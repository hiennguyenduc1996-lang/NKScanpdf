// NKScanpdf — giao diện & luồng chính.
// SỐ PHIÊN BẢN: mỗi lần phát hành tăng 1, đồng thời đổi CACHE trong sw.js thành 'nkscanpdf-v<số>'.
const APP_VERSION = '14.0';
(() => {
  // hiện số phiên bản thật (thay cho số ghi cố định trong trang)
  document.querySelectorAll('.app-ver').forEach((el) => { el.textContent = 'v' + APP_VERSION; });
  const $ = (id) => document.getElementById(id);
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  // Chờ 1 khung hình để vòng xoay "Đang xử lý" kịp hiện — nhưng không bao giờ chờ quá 50 ms
  const nextFrame = () => new Promise((r) => {
    let done = false; const go = () => { if (!done) { done = true; r(); } };
    requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, 50);
  });

  const BEST_Q = 0.95;     // chất lượng JPEG khi lưu trang (mức "Tốt nhất")
  let pages = [];          // các trang đã lưu
  const thumbs = new Map(); // id -> objectURL
  let queue = [];          // ảnh mới đang chờ cắt
  let session = null;      // trang đang chỉnh

  // ---------- Toast ----------
  let toastT;
  function toast(msg, ms = 2200) {
    const t = $('toast'); t.textContent = msg; show(t);
    clearTimeout(toastT); toastT = setTimeout(() => show(t, false), ms);
  }

  // ---------- Danh sách trang ----------
  function thumbUrl(p) {
    if (!thumbs.has(p.id)) thumbs.set(p.id, URL.createObjectURL(p.thumb || p.out));
    return thumbs.get(p.id);
  }
  function dropThumb(id) { if (thumbs.has(id)) { URL.revokeObjectURL(thumbs.get(id)); thumbs.delete(id); } }

  function render() {
    const box = $('pages');
    box.innerHTML = '';
    pages.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = 'page';
      const ic = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
      el.innerHTML = `<div class="thumb"><img alt="Trang ${i + 1}">${p.card ? '<span class="badge">CCCD</span>' : ''}${p.out ? '' : '<span class="pending"><i></i></span>'}</div>
        <div class="num">${i + 1}</div>
        <div class="acts"><button data-a="left" aria-label="Lên trước">${ic('left')}</button>
        <button data-a="edit" aria-label="Sửa">${ic('edit')}</button>
        <button data-a="right" aria-label="Ra sau">${ic('right')}</button>
        <button data-a="share" class="share" aria-label="Chia sẻ trang này">${ic('share')}</button>
        <button data-a="del" class="del" aria-label="Xóa">${ic('x')}</button></div>`;
      el.querySelector('img').src = thumbUrl(p);
      el.querySelector('img').onclick = () => openViewer(i); // xem bản ĐÃ scan (không mở ảnh gốc)
      el.querySelector('[data-a=left]').disabled = i === 0;
      el.querySelector('[data-a=right]').disabled = i === pages.length - 1;
      el.querySelector('.acts').onclick = (e) => {
        const a = e.target.closest('button')?.dataset.a;
        if (a === 'edit') editPage(p);
        if (a === 'del') removePage(p);
        if (a === 'share') openPageShare(p, i);
        if (a === 'left') move(i, -1);
        if (a === 'right') move(i, 1);
      };
      box.appendChild(el);
    });
    const has = pages.length > 0;
    show($('welcome'), !has);
    show($('pagesWrap'), has);
    show($('fab'), has);
    $('btnExport').disabled = $('btnClear').disabled = !has;
    updateStatus();
  }

  async function move(i, d) {
    const j = i + d;
    [pages[i], pages[j]] = [pages[j], pages[i]];
    pages.forEach((p, k) => (p.order = k));
    render();
    await Promise.all([DB.put(pages[i]), DB.put(pages[j])]);
  }

  async function removePage(p) {
    if (!confirm('Xóa trang này?')) return;
    pages = pages.filter((x) => x !== p);
    dropThumb(p.id);
    await DB.del(p.id);
    render();
  }

  $('btnClear').onclick = async () => {
    if (!pages.length || !confirm(`Xóa tất cả ${pages.length} trang?`)) return;
    pages.forEach((p) => dropThumb(p.id));
    pages = [];
    await DB.clear();
    render();
  };

  // ---------- Nhập ảnh ----------
  const pick = (input, card) => () => { localStorage.setItem('cardMode', card ? '1' : '0'); $(input).click(); };
  // Chụp: mở camera trực tiếp có khung tự dò mép giấy; máy không hỗ trợ thì dùng camera của máy
  const openCamera = (card) => async () => {
    localStorage.setItem('cardMode', card ? '1' : '0');
    if (!Camera.supported) { $('fileCamera').click(); return; }
    try {
      await Camera.open({
        onCapture: (blob, hintQuad, aspect) => {
          queue.unshift({ file: new File([blob], 'camera.jpg', { type: 'image/jpeg' }), hint: hintQuad, aspect });
          if (!session) nextInQueue();
        },
        onGallery: () => $('fileGallery').click(),
        onClose: () => render(),
      });
      Camera.setCount(pages.length);
    } catch (e) {
      toast('Không mở được camera trực tiếp – chuyển sang camera của máy', 3000);
      $('fileCamera').click();
    }
  };
  $('btnCamera').onclick = $('tileCamera').onclick = $('fab').onclick = openCamera(false);
  $('btnGallery').onclick = $('tileGallery').onclick = pick('fileGallery', false);
  $('btnCCCD').onclick = $('tileCCCD').onclick = openCamera(true);
  const openHelp = () => show($('help'));
  $('btnInfo').onclick = $('tileHelp').onclick = openHelp;
  $('helpClose').onclick = () => show($('help'), false);
  $('help').onclick = (e) => { if (e.target === $('help')) show($('help'), false); };
  const onFiles = (e) => {
    const files = [...e.target.files].filter((f) => f.type.startsWith('image/') || !f.type);
    e.target.value = '';
    if (!files.length) return;
    if (session && session.retaking) { // thay ảnh của trang đang sửa
      session.retaking = false;
      replaceSource(files.shift());
    }
    queue.push(...files);
    if (!session) nextInQueue();
  };
  $('fileCamera').onchange = onFiles;
  $('fileGallery').onchange = onFiles;

  async function nextInQueue() {
    let item = queue.shift();
    if (!item) return;
    const file = item.file || item, hint = item.hint || null;
    if (Camera.isOpen()) Camera.pause();
    try {
      const base = await Scan.loadToCanvas(file);
      const src = await keepSource(file, base);
      // Ảnh từ camera trực tiếp: dùng ĐÚNG khung xanh người dùng vừa thấy (nếu ảnh cùng tỉ lệ khung hình video).
      // Ảnh chọn từ thư viện: tự nhận lại.
      const sameView = hint && item.aspect && Math.abs((base.width / base.height) / item.aspect - 1) < 0.03;
      const card = localStorage.getItem('cardMode') === '1';
      session = {
        page: null, src, base, rot: 0, canvas: base,
        corners: sameView ? hint.map((p) => p.slice()) : (Scan.detectAuto(base, Camera.detectMode()) || Scan.FULL()),
        card, flatten: !card && localStorage.getItem('flatten') !== '0',
      };
      session.filter = defaultFilter(session.card);
      openCrop();
    } catch (err) {
      toast('Không mở được ảnh: ' + err.message);
      nextInQueue();
    }
  }

  // Giữ nguyên tệp ảnh gốc từ camera (không nén lại -> nhanh và không mất nét).
  // Chỉ chuyển sang JPEG khi định dạng lạ (vd. HEIC) mà trình duyệt có thể không đọc lại được.
  async function keepSource(file, base) {
    if (/^image\/(jpeg|png|webp)$/.test(file.type)) return file;
    return Scan.toBlob(base, 0.95);
  }

  // Ảnh nhỏ cho danh sách trang (nhẹ, cuộn mượt)
  async function makeThumb(canvas) {
    const k = Math.min(1, 360 / Math.max(canvas.width, canvas.height));
    const t = Scan.makeCanvas(canvas.width * k, canvas.height * k);
    const ctx = t.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas, 0, 0, t.width, t.height);
    return Scan.toBlob(t, 0.8);
  }

  // Tài liệu mặc định "Làm nét"; thẻ/CCCD mặc định giữ màu gốc. Mỗi loại nhớ lựa chọn riêng.
  const filterKey = (card) => (card ? 'filterCard' : 'filter');
  const defaultFilter = (card) => localStorage.getItem(filterKey(card)) || (card ? 'original' : 'magic');

  async function replaceSource(file) {
    try {
      const base = await Scan.loadToCanvas(file);
      session.src = await keepSource(file, base);
      session.base = base; session.canvas = base; session.rot = 0;
      session.corners = Scan.detectAuto(base, Camera.detectMode()) || Scan.FULL();
      openCrop();
      toast('Đã thay ảnh mới');
    } catch (err) { toast('Không mở được ảnh: ' + err.message); }
  }

  async function editPage(p) {
    const base = await Scan.loadToCanvas(p.src);
    session = {
      page: p, src: p.src, base, rot: p.rot || 0,
      canvas: Scan.rotate(base, p.rot || 0),
      corners: p.corners.map((c) => c.slice()),
      filter: p.filter,
      card: !!p.card,
      flatten: !!p.flatten,
    };
    openCrop();
  }

  function endSession() {
    session = null;
    show($('crop'), false); show($('filter'), false);
    if (queue.length) nextInQueue();
    else if (Camera.isOpen()) { Camera.setCount(pages.length); Camera.resume(); } // quay lại camera chụp trang tiếp
  }

  // ---------- Màn cắt góc ----------
  const cc = $('cropCanvas');
  const loupe = $('loupe');
  let view = null;   // {x, y, s} : vị trí & tỉ lệ vẽ ảnh trên canvas (px thiết bị)
  let drag = -1;

  function openCrop() {
    show($('filter'), false);
    show($('crop'));
    $('cropCard').classList.toggle('active', session.card);
    updateDetectBtn();
    requestAnimationFrame(layoutCrop);
  }

  function layoutCrop() {
    if (!session) return;
    const st = $('cropStage');
    const dpr = window.devicePixelRatio || 1;
    cc.width = st.clientWidth * dpr; cc.height = st.clientHeight * dpr;
    const pad = 28 * dpr;
    const img = session.canvas;
    const s = Math.min((cc.width - pad * 2) / img.width, (cc.height - pad * 2) / img.height);
    view = { s, x: (cc.width - img.width * s) / 2, y: (cc.height - img.height * s) / 2, dpr };
    drawCrop();
  }
  window.addEventListener('resize', () => { if (!$('crop').classList.contains('hidden')) layoutCrop(); });

  const toScreen = ([u, v]) => [view.x + u * session.canvas.width * view.s, view.y + v * session.canvas.height * view.s];

  function drawCrop() {
    const ctx = cc.getContext('2d');
    const img = session.canvas;
    ctx.clearRect(0, 0, cc.width, cc.height);
    ctx.drawImage(img, view.x, view.y, img.width * view.s, img.height * view.s);
    const pts = session.corners.map(toScreen);
    // làm tối phần ngoài
    ctx.save();
    ctx.fillStyle = 'rgba(14,37,87,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, cc.width, cc.height);
    ctx.moveTo(...pts[0]); ctx.lineTo(...pts[3]); ctx.lineTo(...pts[2]); ctx.lineTo(...pts[1]); ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
    // khung
    ctx.strokeStyle = '#4C90F0'; ctx.lineWidth = 2.5 * view.dpr;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath(); ctx.stroke();
    // nút giữa cạnh (kéo cả cạnh)
    midPoints(pts).forEach((m, e) => {
      const a = pts[e], b = pts[(e + 1) % 4], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      ctx.save(); ctx.translate(m[0], m[1]); ctx.rotate(ang);
      const L = (drag === 4 + e ? 26 : 20) * view.dpr, T = 7 * view.dpr;
      ctx.beginPath(); ctx.roundRect(-L / 2, -T / 2, L, T, T / 2);
      ctx.fillStyle = drag === 4 + e ? '#F2C46D' : '#fff'; ctx.fill();
      ctx.lineWidth = 2 * view.dpr; ctx.strokeStyle = '#F2C46D'; ctx.stroke();
      ctx.restore();
    });
    // nút góc
    pts.forEach((p, i) => {
      ctx.beginPath(); ctx.arc(p[0], p[1], (drag === i ? 16 : 12) * view.dpr, 0, Math.PI * 2);
      ctx.fillStyle = drag === i ? 'rgba(242,196,109,.45)' : 'rgba(255,255,255,.35)'; ctx.fill();
      ctx.lineWidth = 3 * view.dpr; ctx.strokeStyle = '#F2C46D'; ctx.stroke();
    });
  }
  const midPoints = (pts) => pts.map((a, e) => { const b = pts[(e + 1) % 4]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; });

  function drawLoupe(i) {
    const img = session.canvas;
    const [u, v] = i < 4 ? session.corners[i] : midPoints(session.corners)[i - 4];
    const lc = loupe.getContext('2d');
    const zoom = 2.5 / view.s / view.dpr; // nguồn px cho mỗi px loupe (≈ phóng 2.5x so với màn)
    const sz = 120 * zoom;
    lc.fillStyle = '#000'; lc.fillRect(0, 0, 120, 120);
    lc.drawImage(img, u * img.width - sz / 2, v * img.height - sz / 2, sz, sz, 0, 0, 120, 120);
    lc.strokeStyle = '#F2C46D'; lc.lineWidth = 1.5;
    lc.beginPath(); lc.moveTo(60, 48); lc.lineTo(60, 72); lc.moveTo(48, 60); lc.lineTo(72, 60); lc.stroke();
    // đặt kính lúp ở phía đối diện ngón tay
    const sx = toScreen([u, v])[0] / view.dpr;
    const onLeft = sx < cc.clientWidth / 2;
    loupe.style.left = onLeft ? 'auto' : '12px';
    loupe.style.right = onLeft ? '12px' : 'auto';
  }

  function pointerPos(e) {
    const r = cc.getBoundingClientRect();
    return [(e.clientX - r.left) * view.dpr, (e.clientY - r.top) * view.dpr];
  }
  let grabOffset = [0, 0], dragStart = null;
  cc.addEventListener('pointerdown', (e) => {
    if (!session) return;
    const p = pointerPos(e);
    let best = -1, bd = 44 * view.dpr;
    const scr = session.corners.map(toScreen);
    // 0..3 = góc, 4..7 = giữa cạnh (góc được ưu tiên khi gần như nhau)
    [...scr, ...midPoints(scr)].forEach((s, i) => {
      const d = Math.hypot(s[0] - p[0], s[1] - p[1]) + (i >= 4 ? 6 * view.dpr : 0);
      if (d < bd) { bd = d; best = i; }
    });
    if (best < 0) return;
    drag = best;
    const s = best < 4 ? scr[best] : midPoints(scr)[best - 4];
    grabOffset = [s[0] - p[0], s[1] - p[1]];
    dragStart = { p, corners: session.corners.map((c) => c.slice()) };
    cc.setPointerCapture(e.pointerId);
    show(loupe); drawLoupe(best); drawCrop();
  });
  cc.addEventListener('pointermove', (e) => {
    if (drag < 0) return;
    const p = pointerPos(e);
    const img = session.canvas;
    const cl = (v) => Math.max(0, Math.min(1, v));
    if (drag < 4) {
      const u = (p[0] + grabOffset[0] - view.x) / (img.width * view.s);
      const v = (p[1] + grabOffset[1] - view.y) / (img.height * view.s);
      session.corners[drag] = [cl(u), cl(v)];
    } else { // dời cả cạnh theo hướng vuông góc với cạnh
      const e0 = drag - 4, e1 = (e0 + 1) % 4, C = dragStart.corners;
      const ax = (C[e1][0] - C[e0][0]) * img.width, ay = (C[e1][1] - C[e0][1]) * img.height;
      const L = Math.hypot(ax, ay) || 1, nx = -ay / L, ny = ax / L;
      const dx = (p[0] - dragStart.p[0]) / view.s, dy = (p[1] - dragStart.p[1]) / view.s;
      const t = dx * nx + dy * ny;
      for (const k of [e0, e1]) session.corners[k] = [cl(C[k][0] + t * nx / img.width), cl(C[k][1] + t * ny / img.height)];
    }
    drawCrop(); drawLoupe(drag);
  });
  const endDrag = () => { if (drag >= 0) { drag = -1; show(loupe, false); drawCrop(); } };
  cc.addEventListener('pointerup', endDrag);
  cc.addEventListener('pointercancel', endDrag);

  // Nút đổi kiểu nhận diện (nhớ lựa chọn cho cả camera): Tự động -> Theo mép -> Theo chữ -> Tự động
  const DM_LABEL = { auto: 'Tự động', paper: 'Theo mép', text: 'Theo chữ', card: 'Mép thẻ' };
  const DM_TOAST = { auto: 'Tự động: mép giấy, không rõ thì theo vùng chữ', paper: 'Cắt theo mép giấy', text: 'Cắt theo vùng chữ', card: 'Nhận lại mép thẻ' };
  const curMode = () => (session && session.card ? 'card' : (localStorage.getItem('detectMode2') || 'auto'));
  function updateDetectBtn() { $('cropAuto').querySelector('b').textContent = DM_LABEL[curMode()]; }
  $('cropAuto').onclick = () => {
    let next = 'card';
    if (!session.card) {
      next = { auto: 'paper', paper: 'text', text: 'auto' }[curMode()] || 'auto';
      localStorage.setItem('detectMode2', next);
    }
    const q = Scan.detectAuto(session.canvas, next);
    updateDetectBtn();
    if (q) { session.corners = q; drawCrop(); toast(DM_TOAST[next]); }
    else toast('Không tự nhận được – hãy kéo 4 góc bằng tay');
  };
  $('cropFull').onclick = () => { session.corners = Scan.FULL(); drawCrop(); };
  const rot = (dir) => {
    session.rot = (session.rot + dir + 4) % 4;
    session.canvas = Scan.rotate(session.base, session.rot);
    session.corners = Scan.rotateCorners(session.corners, dir);
    layoutCrop();
  };
  $('cropRotL').onclick = () => rot(-1);
  $('cropRotR').onclick = () => rot(1);
  $('cropCancel').onclick = endSession;
  $('cropRetake').onclick = () => { session.retaking = true; $('fileCamera').click(); };
  $('cropCard').onclick = () => {
    session.card = !session.card;
    localStorage.setItem('cardMode', session.card ? '1' : '0');
    session.filter = defaultFilter(session.card);
    $('cropCard').classList.toggle('active', session.card);
    toast(session.card
      ? 'Chế độ thẻ: ảnh được nắn đúng tỉ lệ thẻ, 2 mặt in chung 1 trang A4 đúng kích thước thật'
      : 'Đã tắt chế độ thẻ', 3500);
  };

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (Math.abs(cr) < 1e-6) return false;
      const s = Math.sign(cr);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  $('cropNext').onclick = async () => {
    if (!isConvex(session.corners)) { toast('4 góc bị chéo nhau – hãy kéo lại'); return; }
    session.result = null; working = true;
    show($('crop'), false); show($('filter')); show($('busy'));
    await nextFrame();
    const img = session.canvas;
    const q = session.corners.map(([u, v]) => [u * img.width, v * img.height]);
    let size;
    if (session.card) { // thẻ ID-1 85.6 × 54 mm, ~300 dpi
      const dw = Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]);
      const dh = Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]);
      size = dw >= dh ? [2024, 1276] : [1276, 2024]; // ~600 dpi, chữ nhỏ trên thẻ vẫn rõ
    }
    session.q = q; session.size = size;
    // bản xem trước vừa màn hình -> đổi bộ lọc tức thì; bản nét đầy đủ chỉ làm khi bấm Lưu
    // nắn từ bản thu nhỏ của ảnh (đọc ít điểm ảnh hơn nhiều -> nhanh)
    if (!session.small || session.small._of !== img) {
      const k0 = Math.min(1, 2048 / Math.max(img.width, img.height));
      const sm = Scan.makeCanvas(img.width * k0, img.height * k0);
      const sctx = sm.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(img, 0, 0, sm.width, sm.height);
      sm._of = img; session.small = sm;
    }
    const k = session.small.width / img.width;
    session.warpedRaw = Scan.warp(session.small, q.map(([x, y]) => [x * k, y * k]), size, PREVIEW_MAX);
    session.warpedFlat = null;
    await renderFilter();
  };
  const PREVIEW_MAX = 1200; // chỉ để xem trên màn hình; bản lưu vẫn làm nét đầy đủ ở luồng nền

  // ---------- Màn bộ lọc ----------
  const fc = $('filterCanvas');
  let working = false; // đang xử lý ảnh -> chặn bấm Lưu
  // tẩy nền ngoài nội dung: với tài liệu (không phải thẻ) ở các chế độ làm trắng giấy
  const wantClean = (s) => !s.card && s.filter !== 'original';
  async function renderFilter() {
    working = true;
    show($('busy')); await nextFrame();
    document.querySelectorAll('#filterBar .rb[data-f]').forEach((b) => b.classList.toggle('active', b.dataset.f === session.filter));
    $('filterFlat').classList.toggle('active', !!session.flatten);
    $('filterFlat').classList.toggle('hidden', !!session.card);
    const s = session;
    let result = null;
    const pw = previewWorker();
    if (pw) { // làm ảnh xem trước ở luồng nền riêng -> màn hình không đứng
      try {
        const bmp = await createImageBitmap(s.warpedRaw);
        const r = await new Promise((res) => {
          const id = ++pvSeq; pvWait.set(id, res);
          pw.postMessage({ id, job: { type: 'preview', bmp, flatten: !!s.flatten, filter: s.filter, clean: wantClean(s) } }, [bmp]);
        });
        if (r && r.bmp) {
          result = Scan.makeCanvas(r.bmp.width, r.bmp.height);
          result.getContext('2d').drawImage(r.bmp, 0, 0); r.bmp.close();
        }
      } catch (e) { pvOk = false; }
    }
    if (!result) { // dự phòng: làm trên trang
      let src = s.warpedRaw;
      if (s.flatten) src = s.warpedFlat || (s.warpedFlat = Scan.flatten(s.warpedRaw));
      result = Scan.applyFilter(src, s.filter);
      if (wantClean(s)) Scan.cleanBorder(result);
    }
    if (session !== s) { working = false; return; } // người dùng đã thoát trong lúc chờ
    s.result = result;
    fc.width = result.width; fc.height = result.height;
    fc.getContext('2d').drawImage(result, 0, 0);
    show($('busy'), false);
    working = false;
  }
  // luồng nền riêng cho ảnh xem trước (không xếp hàng sau việc làm nét trang trước)
  let pvWorker = null, pvOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined', pvSeq = 0;
  const pvWait = new Map();
  function previewWorker() {
    if (!pvOk) return null;
    if (!pvWorker) {
      try {
        pvWorker = new Worker('worker.js');
        pvWorker.onmessage = (e) => { const r = pvWait.get(e.data.id); pvWait.delete(e.data.id); if (r) r(e.data); };
        pvWorker.onerror = () => { pvOk = false; pvWorker = null; pvWait.forEach((r) => r(null)); pvWait.clear(); };
      } catch (e) { pvOk = false; }
    }
    return pvWorker;
  }
  $('filterBar').onclick = (e) => {
    const b = e.target.closest('.rb'); if (!b || !session || working) return;
    if (b.id === 'filterFlat') {
      session.flatten = !session.flatten;
      localStorage.setItem('flatten', session.flatten ? '1' : '0');
    } else {
      session.filter = b.dataset.f;
      localStorage.setItem(filterKey(session.card), session.filter);
    }
    renderFilter();
  };
  $('filterBack').onclick = openCrop;

  $('filterSave').onclick = async () => {
    if (working || !session || !session.result) return;
    working = true;
    // Lưu ngay với ảnh xem trước; bản nét đầy đủ làm ở luồng nền (xem processPage)
    const thumb = await makeThumb(session.result);
    const data = {
      src: session.src, rot: session.rot, corners: session.corners, filter: session.filter, card: session.card,
      size: session.size || null, flatten: !!session.flatten, clean: wantClean(session), thumb, out: null, w: 0, h: 0,
    };
    let page;
    if (session.page) {
      page = Object.assign(session.page, data);
      dropThumb(page.id);
    } else {
      page = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), order: pages.length, ...data };
      pages.push(page);
    }
    await DB.put(page);
    processPage(page);
    render();
    const more = queue.length;
    const wasNewCard = session.card && !session.page;
    working = false;
    endSession();
    if (!more) {
      let run = 0; // số ảnh CCCD liên tiếp ở cuối
      for (let k = pages.length - 1; k >= 0 && pages[k].card; k--) run++;
      if (wasNewCard && run % 2 === 1) toast(Camera.isOpen() ? 'Đã lưu mặt trước – giờ chụp mặt sau' : 'Đã lưu mặt trước – bấm CCCD để chụp tiếp mặt sau', 3500);
      else toast(`Đã lưu – tài liệu có ${pages.length} trang`);
    }
  };

  // ---------- Làm nét đầy đủ ở luồng nền ----------
  const jobs = new Map(); // page.id -> Promise
  let worker = null, workerOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
    && 'convertToBlob' in OffscreenCanvas.prototype;
  const waiting = new Map(); let seq = 0;
  function runInWorker(job) {
    if (!worker) {
      worker = new Worker('worker.js');
      worker.onmessage = (e) => { const w = waiting.get(e.data.id); waiting.delete(e.data.id); if (w) w(e.data); };
      worker.onerror = () => { workerOk = false; waiting.forEach((w) => w({ error: 'worker' })); waiting.clear(); };
    }
    return new Promise((res) => { const id = ++seq; waiting.set(id, res); worker.postMessage({ id, job }); });
  }
  async function runFull(job) {
    if (workerOk) {
      const r = await runInWorker(job);
      if (!r.error) return r;
      workerOk = false; // trình duyệt không hỗ trợ đủ -> làm trên trang
    }
    await nextFrame();
    return Scan.processFull(job);
  }

  function processPage(p) {
    const ver = (p._ver || 0) + 1; p._ver = ver;
    const job = { src: p.src, rot: p.rot || 0, corners: p.corners, size: p.size || null, filter: p.filter,
      flatten: !!p.flatten, clean: !!p.clean, quality: BEST_Q };
    const prev = jobs.get(p.id) || Promise.resolve();
    const run = prev.catch(() => {}).then(() => runFull(job)).then(async (r) => {
      if (p._ver !== ver || !pages.includes(p)) return; // trang đã bị sửa lại / xóa
      p.out = r.out; p.w = r.w; p.h = r.h;
      await DB.put(p);
      built = null; render();
    }).catch((err) => toast('Lỗi xử lý ảnh: ' + err.message))
      .finally(() => { if (jobs.get(p.id) === run) jobs.delete(p.id); updateStatus(); });
    jobs.set(p.id, run);
    updateStatus();
    return run;
  }
  const allDone = () => Promise.all([...jobs.values()]);

  function updateStatus() {
    if (!pages.length) { $('status').textContent = 'Sẵn sàng'; return; }
    const cards = pages.filter((p) => p.card).length;
    const n = pages.filter((p) => !p.out).length;
    $('status').textContent = `${pages.length} trang${cards ? ` (${cards} ảnh CCCD)` : ''}`
      + (n ? ` · Đang làm nét ${n} trang…` : ' · Bấm vào trang để sửa');
  }

  // ---------- Xuất file ----------
  let built = null; // {key, blob}
  const docName = $('docName');
  docName.value = localStorage.getItem('docName') || defaultName();
  // Tên file: ô ở tab tài liệu và ô trong hộp Xuất PDF luôn đồng bộ
  const setDocName = (v) => {
    docName.value = v; $('optName').value = v;
    localStorage.setItem('docName', v.trim() || defaultName()); built = null;
  };
  docName.onchange = () => setDocName(docName.value);
  $('optName').oninput = () => { docName.value = $('optName').value; built = null; $('doShare').disabled = $('doDownload').disabled = true; clearTimeout(nameT); nameT = setTimeout(() => { setDocName($('optName').value); buildPdf(); }, 400); };
  let nameT;
  function defaultName() {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `Scan ${z(d.getDate())}-${z(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  const fileBase = () => (docName.value.trim() || defaultName()).replace(/[\\/:*?"<>|]+/g, '_');

  async function encodePage(p, q) {
    let blob = p.out, w = p.w, h = p.h;
    if (q !== 'max') { // nén nhẹ hơn: giải mã rồi mã hoá lại
      const c = await Scan.loadToCanvas(p.out, 8000);
      blob = await Scan.toBlob(c, +q); w = c.width; h = c.height;
    } else if (!w || !h) {
      const bm = await createImageBitmap(p.out); w = bm.width; h = bm.height; bm.close();
    }
    return { blob, bytes: new Uint8Array(await blob.arrayBuffer()), w, h, card: !!p.card };
  }

  async function buildPdf() {
    $('doShare').disabled = $('doDownload').disabled = true;
    if (jobs.size) {
      $('sheetInfo').textContent = 'Đang hoàn tất làm nét các trang…';
      await allDone();
    }
    const size = $('optSize').value, q = $('optQuality').value;
    if (pages.some((p) => !p.out)) { $('sheetInfo').textContent = 'Có trang chưa xử lý được – hãy sửa lại trang đó'; return null; }
    const key = [size, q, fileBase(), pages.map((p) => p.id + ':' + p.out.size).join(',')].join('|');
    if (built && built.key === key) { $('doShare').disabled = $('doDownload').disabled = false; return built; }
    $('sheetInfo').textContent = 'Đang tạo PDF…';
    // "Tốt nhất" dùng thẳng ảnh đã lưu -> gần như tức thì; các mức khác xử lý song song
    const enc = await Promise.all(pages.map((p) => encodePage(p, q)));
    const { blob, sheets } = PDF.build(enc, size, fileBase());
    built = { key, blob, jpgs: enc.map((e) => e.blob) };
    $('sheetInfo').textContent = `${pages.length} ảnh → ${sheets} trang PDF · ${(blob.size / 1048576).toFixed(2)} MB`;
    $('doShare').disabled = $('doDownload').disabled = false;
    return built;
  }

  $('btnExport').onclick = () => { $('optName').value = docName.value; show($('sheet')); buildPdf(); };
  $('sheetClose').onclick = () => show($('sheet'), false);
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) show($('sheet'), false); };
  $('optSize').onchange = $('optQuality').onchange = () => buildPdf();

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // Chia sẻ (Zalo, Gmail, Drive…); máy không hỗ trợ thì tải về
  async function shareOrDownload(files, title) {
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files, title }); return; }
      catch (e) { if (e.name === 'AbortError') return; toast('Không chia sẻ được – đã tải về máy'); }
    } else toast('Máy không hỗ trợ chia sẻ – đã tải về máy');
    for (const f of files) { download(f, f.name); await new Promise((r) => setTimeout(r, 350)); }
  }

  $('doShare').onclick = () => {
    const b = built; if (!b) return;
    shareOrDownload([new File([b.blob], fileBase() + '.pdf', { type: 'application/pdf' })], fileBase());
  };

  // ---------- Xem trang đã scan ----------
  let vwIndex = -1, vwUrl = null;
  async function openViewer(i) {
    if (i < 0 || i >= pages.length) return;
    vwIndex = i;
    const p = pages[i];
    show($('viewer'));
    $('vwTitle').textContent = `Trang ${i + 1}/${pages.length}`;
    $('vwPrev').disabled = i === 0; $('vwNext').disabled = i === pages.length - 1;
    $('vwImg').classList.remove('zoom');
    // đang làm nét nền -> hiện ảnh thu nhỏ đã cắt trước, xong thì thay bản nét
    $('vwImg').src = thumbUrl(p);
    show($('vwBusy'), !p.out);
    if (!p.out && jobs.has(p.id)) await jobs.get(p.id);
    if (vwIndex !== i || !p.out) { show($('vwBusy'), false); return; }
    if (vwUrl) URL.revokeObjectURL(vwUrl);
    vwUrl = URL.createObjectURL(p.out);
    $('vwImg').src = vwUrl;
    show($('vwBusy'), false);
  }
  function closeViewer() {
    show($('viewer'), false); vwIndex = -1;
    if (vwUrl) { URL.revokeObjectURL(vwUrl); vwUrl = null; }
  }
  $('vwBack').onclick = closeViewer;
  $('vwPrev').onclick = () => openViewer(vwIndex - 1);
  $('vwNext').onclick = () => openViewer(vwIndex + 1);
  $('vwImg').onclick = () => $('vwImg').classList.toggle('zoom'); // chạm để phóng to / thu nhỏ
  $('vwEdit').onclick = () => { const p = pages[vwIndex]; closeViewer(); editPage(p); };
  $('vwFilter').onclick = async () => { // vào thẳng bước chọn chế độ ảnh, giữ khung cắt cũ
    const p = pages[vwIndex]; closeViewer(); await editPage(p); $('cropNext').click();
  };
  $('vwShare').onclick = $('vwShare2').onclick = () => openPageShare(pages[vwIndex], vwIndex);
  $('vwDel').onclick = async () => {
    const p = pages[vwIndex]; const i = vwIndex;
    await removePage(p);
    if (!pages.includes(p)) { if (pages.length) openViewer(Math.min(i, pages.length - 1)); else closeViewer(); }
  };
  // vuốt trái / phải để chuyển trang
  let swX = null;
  $('vwStage').addEventListener('touchstart', (e) => { swX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('vwStage').addEventListener('touchend', (e) => {
    if (swX === null || $('vwImg').classList.contains('zoom')) return;
    const dx = e.changedTouches[0].clientX - swX; swX = null;
    if (Math.abs(dx) > 60) openViewer(vwIndex + (dx < 0 ? 1 : -1));
  });

  // ---------- Chia sẻ riêng 1 trang ----------
  let pageFiles = null;
  async function openPageShare(p, i) {
    pageFiles = null;
    const name = `${fileBase()}_trang${i + 1}`;
    $('psTitle').textContent = `Chia sẻ trang ${i + 1}`;
    $('psName').value = name;
    $('psImg').src = thumbUrl(p);
    ['psJpg', 'psPdf', 'psSave'].forEach((id) => ($(id).disabled = true));
    $('psInfo').textContent = 'Đang chuẩn bị…';
    show($('pageShare'));
    if (jobs.has(p.id)) { $('psInfo').textContent = 'Đang làm nét trang này…'; await jobs.get(p.id); }
    if (!p.out) { $('psInfo').textContent = 'Trang chưa xử lý được – hãy sửa lại trang'; return; }
    const enc = await encodePage(p, 'max');
    const { blob } = PDF.build([enc], $('optSize').value || 'a4', name);
    pageFiles = { jpg: p.out, pdf: blob, page: p };
    $('psInfo').textContent = `Ảnh ${(p.out.size / 1048576).toFixed(2)} MB · PDF ${(blob.size / 1048576).toFixed(2)} MB`;
    ['psJpg', 'psPdf', 'psSave'].forEach((id) => ($(id).disabled = false));
  }
  const psBase = () => ($('psName').value.trim() || 'Trang').replace(/[\\/:*?"<>|]+/g, '_');
  $('psJpg').onclick = () => pageFiles && shareOrDownload([new File([pageFiles.jpg], psBase() + '.jpg', { type: 'image/jpeg' })], psBase());
  $('psPdf').onclick = () => pageFiles && shareOrDownload([new File([pageFiles.pdf], psBase() + '.pdf', { type: 'application/pdf' })], psBase());
  $('psSave').onclick = () => { if (pageFiles) { download(pageFiles.pdf, psBase() + '.pdf'); toast('Đã tải PDF trang này về máy'); } };
  $('psClose').onclick = () => show($('pageShare'), false);
  $('pageShare').onclick = (e) => { if (e.target === $('pageShare')) show($('pageShare'), false); };
  $('doDownload').onclick = () => { if (built) download(built.blob, fileBase() + '.pdf'); };
  $('doImages').onclick = async () => {
    const b = await buildPdf();
    if (!b) return;
    const files = b.jpgs.map((j, i) => new File([j], `${fileBase()}_${i + 1}.jpg`, { type: 'image/jpeg' }));
    if (navigator.canShare && navigator.canShare({ files })) {
      try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    for (const f of files) { download(f, f.name); await new Promise((r) => setTimeout(r, 350)); }
  };

  // ---------- Cài đặt PWA ----------
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; show($('btnInstall')); });
  const doInstall = async () => {
    if (window.matchMedia('(display-mode: standalone)').matches) { toast('App đã được cài rồi'); return; }
    if (!installEvt) { openHelp(); toast('Làm theo bước 5 để thêm app ra màn hình chính', 3500); return; }
    installEvt.prompt();
    await installEvt.userChoice;
    installEvt = null; show($('btnInstall'), false);
  };
  $('btnInstall').onclick = $('tileInstall').onclick = doInstall;
  window.addEventListener('appinstalled', () => { show($('btnInstall'), false); toast('Đã cài app ra màn hình chính'); });

  if ('serviceWorker' in navigator) {
    const hadSW = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {}));
    // có bản mới -> tải lại 1 lần để dùng ngay (chỉ khi đang không chụp/chỉnh ảnh)
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadSW || reloaded || session || Camera.isOpen()) return;
      reloaded = true; location.reload();
    });
  }

  // ---------- Khởi động ----------
  DB.all().then((list) => {
    pages = list; pages.forEach((p, i) => (p.order = i)); render();
    pages.filter((p) => !p.out).forEach(processPage); // làm tiếp trang dở dang lần trước
  })
    .catch(() => { toast('Trình duyệt chặn lưu trữ – trang sẽ mất khi đóng app'); render(); });
})();
