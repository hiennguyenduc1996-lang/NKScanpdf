// Màn camera trực tiếp: dò mép giấy liên tục, vẽ khung, giữ yên máy thì tự chụp (giống CamScanner).
const Camera = (() => {
  const $ = (id) => document.getElementById(id);
  const supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  let stream = null, track = null, imageCapture = null;
  let opened = false, paused = false, busy = false;
  let quad = null, missed = 0, stableSince = 0, lastQuad = null, loopT = 0, torchOn = false, cost = 40;
  // Chống chụp trùng: sau mỗi lần chụp, chỉ tự chụp lại khi đã sang trang khác
  let armed = true, shotSig = null, shotQuad = null, goneFrames = 0;
  // "Dấu vân tay" nội dung trang: nắn phẳng phần giấy về 36×48 điểm rồi chuẩn hoá độ sáng.
  // Đo thử: cùng 1 trang (kể cả rung tay) khác nhau ≈ 0,37; trang khác ≈ 0,74 -> ngưỡng 0,55.
  const SAME_PAGE_MAX = 0.55;
  function signature(v, q) {
    if (!q || !v.videoWidth) return null;
    const k = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
    const s = Scan.makeCanvas(v.videoWidth * k, v.videoHeight * k); // canvas mới mỗi lần (không dùng bộ nhớ đệm điểm ảnh cũ)
    s.getContext('2d').drawImage(v, 0, 0, s.width, s.height);
    const w = Scan.warp(s, q.map(([u, t]) => [u * s.width, t * s.height]), [36, 48]);
    const d = w.getContext('2d').getImageData(0, 0, 36, 48).data, a = new Float32Array(36 * 48);
    let m = 0;
    for (let i = 0; i < a.length; i++) { a[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; m += a[i]; }
    m /= a.length;
    let sd = 0; for (const x of a) sd += (x - m) * (x - m);
    sd = Math.sqrt(sd / a.length) || 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - m) / sd;
    return a;
  }
  function sigDiff(a, b) { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; }
  let cb = {};
  const STABLE_MS = 1300;   // giữ yên bao lâu thì tự chụp
  const video = () => $('camVideo');
  const overlay = () => $('camOverlay');

  // Tự chụp: mặc định TẮT, người dùng bật bằng nút "Tự chụp"
  const auto = () => localStorage.getItem('autoShot') === '1';
  // Thẻ/CCCD: nhận theo mép thẻ; tài liệu: theo vùng chữ (mặc định) hoặc mép giấy (người dùng chọn)
  const detectMode = () => (localStorage.getItem('cardMode') === '1' ? 'paper' : (localStorage.getItem('detectMode') || 'text'));

  async function open(callbacks) {
    cb = callbacks || {};
    if (!supported) throw new Error('no-camera');
    $('camera').classList.remove('hidden');
    hint('Đang mở camera…');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
      });
    } catch (e) {
      $('camera').classList.add('hidden');
      throw e;
    }
    track = stream.getVideoTracks()[0];
    try { // lấy nét liên tục nếu máy hỗ trợ
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      $('camTorch').classList.toggle('hidden', !caps.torch);
    } catch (e) { $('camTorch').classList.add('hidden'); }
    imageCapture = 'ImageCapture' in window ? new ImageCapture(track) : null;
    const v = video();
    v.srcObject = stream;
    await v.play().catch(() => {});
    opened = true; paused = false; quad = null; stableSince = 0; armed = true; shotSig = null; shotQuad = null;
    locked = false; hist = []; pend = []; anchor = null; lastQuad = null; missed = 0;
    updateAutoBtn(); updateMode();
    requestAnimationFrame(loop);
  }

  function close() {
    opened = false;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null; track = null; imageCapture = null; torchOn = false;
    $('camTorch').classList.remove('on');
    $('camera').classList.add('hidden');
  }

  function pause() { paused = true; quad = null; draw(); }
  function resume() { if (opened) { paused = false; busy = false; stableSince = 0; quad = null; } }

  function hint(t) { $('camHint').textContent = t; }

  // ---- vòng dò mép giấy ----
  function loop(ts) {
    if (!opened) return;
    requestAnimationFrame(loop);
    // Mỗi lúc chỉ 1 lần dò; dò ở LUỒNG NỀN nên hình camera và nút bấm luôn mượt.
    // Nếu máy không hỗ trợ luồng nền thì dò trên trang nhưng thưa hơn (theo tốc độ máy).
    const gap = dw ? 120 : Math.max(150, cost * 4);
    if (paused || busy || inflight || ts - loopT < gap) return;
    loopT = ts;
    const v = video();
    if (!v.videoWidth) return;
    detectFrame(v);
  }

  // ---- dò khung (luồng nền) ----
  let dw = null, dwOk = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' && 'createImageBitmap' in window;
  let inflight = false, dseq = 0;
  const dwait = new Map();
  function getWorker() {
    if (!dwOk) return null;
    if (!dw) {
      try {
        dw = new Worker('detect-worker.js');
        dw.onmessage = (e) => { const r = dwait.get(e.data.id); dwait.delete(e.data.id); if (r) r(e.data.q); };
        dw.onerror = () => { dwOk = false; dw = null; dwait.forEach((r) => r(undefined)); dwait.clear(); };
      } catch (e) { dwOk = false; dw = null; }
    }
    return dw;
  }
  async function detectFrame(v) {
    inflight = true;
    const mode = detectMode(), t0 = performance.now();
    const allowPaper = !quad && missed > 6;
    let q = null;
    try {
      const w = getWorker();
      if (w) {
        const k = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
        const bmp = await createImageBitmap(v, { resizeWidth: Math.round(v.videoWidth * k), resizeHeight: Math.round(v.videoHeight * k) });
        q = await new Promise((res) => {
          const id = ++dseq; dwait.set(id, res);
          setTimeout(() => { if (dwait.has(id)) { dwait.delete(id); res(null); } }, 4000); // không treo nếu luồng nền chậm
          w.postMessage({ id, bmp, mode, allowPaper }, [bmp]);
        });
        if (q === undefined) q = null; // luồng nền lỗi -> lần sau dò trên trang
      } else {
        q = mode === 'text' ? Scan.detectContent(v, 400) : Scan.detect(v, 256);
        if (!q && mode === 'text' && allowPaper) q = Scan.detect(v, 256);
      }
    } catch (e) { q = null; dwOk = false; }
    inflight = false;
    if (!opened || paused || busy) return;
    const now = performance.now();
    cost = cost * 0.7 + (now - t0) * 0.3;
    afterDetect(q, now, v);
  }

  function afterDetect(q, now, v) {
    trackQuad(q, now);

    // mở khoá tự chụp khi: giấy rời khỏi khung một lúc, khung dời chỗ hẳn, hoặc nội dung trang đã đổi
    if (!armed) {
      if (!quad) { if (++goneFrames >= 3) armed = true; } else goneFrames = 0;
      if (!armed && quad && shotQuad) {
        const moved = Math.max(...quad.map((p, i) => Math.hypot(p[0] - shotQuad[i][0], p[1] - shotQuad[i][1])));
        if (moved > 0.08) armed = true;
      }
      if (!armed && shotSig && quad && stableSince) {
        const sg = signature(v, quad);
        if (sg && sigDiff(sg, shotSig) > SAME_PAGE_MAX) armed = true;
      }
      if (armed) stableSince = 0;
    }

    const prog = armed && quad && stableSince ? Math.min(1, (now - stableSince) / STABLE_MS) : 0;
    setProgress(auto() ? prog : 0);
    if (!quad) hint('Đưa tài liệu vào khung hình');
    else if (!auto()) hint(locked ? 'Đã khoá khung – bấm nút chụp' : 'Giữ yên máy để khoá khung');
    else if (!armed) hint('Đã chụp trang này – lật sang trang mới');
    else hint(locked ? 'Đã khoá khung – giữ yên…' : prog > 0 ? 'Giữ yên máy…' : 'Đã thấy giấy – giữ yên để tự chụp');
    draw();
    if (auto() && armed && prog >= 1) shoot();
  }

  // ---- Lọc rung + khoá khung ----
  // hist: các lần dò gần nhất; khung hiển thị = trung vị từng góc (bỏ lần dò lệch).
  // Khung chỉ "nhảy" sang chỗ mới khi ≥ 3 lần dò liên tiếp cùng chỉ về chỗ mới (người dùng dời máy thật).
  // Đứng yên LOCK_MS -> khoá: khung đứng im hẳn, không rung theo nhiễu nữa.
  const HIST = 5, JUMP = 0.05, LOCK_MS = 600;
  let hist = [], pend = [], locked = false;
  const dist = (a, b) => Math.max(...a.map((p, i) => Math.hypot(p[0] - b[i][0], p[1] - b[i][1])));
  const median = (qs) => [0, 1, 2, 3].map((i) => [0, 1].map((k) => {
    const v = qs.map((q) => q[i][k]).sort((x, y) => x - y); return v[v.length >> 1];
  }));
  function trackQuad(q, now) {
    if (!q) {
      if (++missed > 6) { quad = null; hist = []; pend = []; locked = false; stableSince = 0; lastQuad = null; anchor = null; }
      return;
    }
    missed = 0;
    if (!quad) { // lần đầu thấy giấy
      hist = [q]; pend = []; quad = q; lastQuad = q; stableSince = now; locked = false; anchor = q.map((p) => p.slice());
      return;
    }
    if (dist(q, quad) > JUMP) {
      // lệch nhiều: có thể là nhiễu, có thể là người dùng dời máy -> chờ xác nhận
      if (pend.length && dist(q, pend[pend.length - 1]) > JUMP) pend = [];
      pend.push(q);
      if (pend.length >= 3) { quad = median(pend); hist = pend.slice(); pend = []; locked = false; stableSince = now; lastQuad = quad; anchor = quad.map((p) => p.slice()); }
      return;
    }
    pend = [];
    hist.push(q); if (hist.length > HIST) hist.shift();
    const m = median(hist);
    if (!locked) quad = quad.map((p, i) => [p[0] * 0.6 + m[i][0] * 0.4, p[1] * 0.6 + m[i][1] * 0.4]);
    // Chịu rung tay: coi là "đứng yên" nếu khung còn nằm trong bán kính TREMOR quanh điểm neo
    // (không đòi từng lần dò phải trùng khít). Đứng yên đủ LOCK_MS -> khoá.
    lastQuad = quad;
    if (locked) return;
    if (!anchor || dist(quad, anchor) > TREMOR) { anchor = quad.map((p) => p.slice()); stableSince = now; }
    if (now - stableSince > LOCK_MS) { locked = true; quad = median(hist); }
  }
  const TREMOR = 0.025;
  let anchor = null;

  // vẽ khung lên lớp phủ (video hiển thị trọn khung hình: object-fit: contain)
  function draw() {
    const c = overlay(), v = video();
    const dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth * dpr, H = c.clientHeight * dpr;
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    if (!quad || !v.videoWidth) return;
    const s = Math.min(W / v.videoWidth, H / v.videoHeight);
    const ox = (W - v.videoWidth * s) / 2, oy = (H - v.videoHeight * s) / 2;
    const pts = quad.map(([u, t]) => [ox + u * v.videoWidth * s, oy + t * v.videoHeight * s]);
    const stable = locked;
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.closePath();
    ctx.fillStyle = stable ? 'rgba(242,196,109,.28)' : 'rgba(47,116,214,.25)'; ctx.fill();
    ctx.lineWidth = 3 * dpr; ctx.strokeStyle = stable ? '#F2C46D' : '#4C90F0'; ctx.stroke();
    pts.forEach((p) => { ctx.beginPath(); ctx.arc(p[0], p[1], 7 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 2.5 * dpr; ctx.stroke(); });
  }

  function setProgress(f) {
    const ring = $('shutterRing');
    if (ring) ring.style.strokeDashoffset = String(226 * (1 - f));
  }

  // ---- chụp ----
  async function shoot() {
    if (!opened || busy || paused) return;
    busy = true;
    const q = quad, v = video();
    // nhớ trang vừa chụp để không tự chụp lại trùng
    armed = false; goneFrames = 0; shotQuad = q; shotSig = signature(v, q);
    const fl = $('camFlash'); fl.classList.remove('go'); void fl.offsetWidth; fl.classList.add('go');
    hint('Đang chụp…');
    let blob = null;
    if (imageCapture) { // ảnh độ phân giải đầy đủ của cảm biến (Chrome Android)
      try {
        blob = await Promise.race([
          imageCapture.takePhoto(torchOn ? { fillLightMode: 'flash' } : {}),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
        ]);
      } catch (e) { blob = null; }
    }
    if (!blob) { // lấy khung hình video
      const c = Scan.makeCanvas(v.videoWidth, v.videoHeight);
      c.getContext('2d').drawImage(v, 0, 0);
      blob = await Scan.toBlob(c, 0.95);
    }
    paused = true; setProgress(0);
    cb.onCapture && cb.onCapture(blob, q, v.videoWidth / v.videoHeight);
  }

  async function toggleTorch() {
    if (!track) return;
    torchOn = !torchOn;
    try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); } catch (e) { torchOn = false; }
    $('camTorch').classList.toggle('on', torchOn);
  }

  function updateAutoBtn() {
    const on = auto();
    $('camAuto').classList.toggle('on', on);
    $('camAuto').querySelector('b').textContent = on ? 'Tự chụp: Bật' : 'Tự chụp: Tắt';
  }
  function updateMode() {
    const card = localStorage.getItem('cardMode') === '1';
    $('camModeDoc').classList.toggle('on', !card);
    $('camModeCard').classList.toggle('on', card);
  }
  function setCount(n) {
    $('camDone').textContent = n ? `Xong (${n})` : 'Đóng';
  }

  // ---- nút ----
  function bind() {
    $('camShutter').onclick = () => { stableSince = 0; shoot(); };
    $('camClose').onclick = () => { close(); cb.onClose && cb.onClose(); };
    $('camDone').onclick = () => { close(); cb.onClose && cb.onClose(); };
    $('camTorch').onclick = toggleTorch;
    $('camAuto').onclick = () => { localStorage.setItem('autoShot', auto() ? '0' : '1'); stableSince = 0; updateAutoBtn(); };
    $('camModeDoc').onclick = () => { localStorage.setItem('cardMode', '0'); updateMode(); };
    $('camModeCard').onclick = () => { localStorage.setItem('cardMode', '1'); updateMode(); };
    $('camGallery').onclick = () => cb.onGallery && cb.onGallery();
    window.addEventListener('resize', draw);
    document.addEventListener('visibilitychange', () => { if (document.hidden && opened) { close(); cb.onClose && cb.onClose(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();

  return { supported, open, close, pause, resume, setCount, isOpen: () => opened, updateMode, detectMode,
    state: () => ({ quad, locked }) };
})();
