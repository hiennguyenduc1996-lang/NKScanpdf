// Xử lý ảnh: nạp ảnh, xoay, tự nhận mép giấy, nắn phẳng phối cảnh, bộ lọc.
const Scan = (() => {
  const MAX_SRC = 4096;  // cạnh dài tối đa của ảnh gốc (giữ nguyên độ phân giải camera 12MP)
  const MAX_OUT = 3508;  // cạnh dài tối đa của trang sau khi nắn (= A4 ở 300 dpi)

  const IN_WORKER = typeof document === 'undefined';

  // Chạy được cả trên trang lẫn trong Web Worker (OffscreenCanvas)
  function makeCanvas(w, h) {
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (IN_WORKER) return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  // Blob/File -> canvas (đã thu nhỏ, đúng chiều EXIF)
  async function loadToCanvas(blob, maxSide = MAX_SRC) {
    let src, w, h;
    try {
      try { src = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
      catch (e1) { if (IN_WORKER) src = await createImageBitmap(blob); else throw e1; }
      w = src.width; h = src.height;
    } catch (e) {
      if (IN_WORKER) throw e;
      src = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error('Không đọc được ảnh'));
        img.src = URL.createObjectURL(blob);
      });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = makeCanvas(w * k, h * k);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    if (src.close) src.close();
    return c;
  }

  // Xoay canvas theo bội số 90° (rot: 0..3, chiều kim đồng hồ)
  function rotate(canvas, rot) {
    rot = ((rot % 4) + 4) % 4;
    if (!rot) return canvas;
    const sw = rot % 2 ? canvas.height : canvas.width;
    const sh = rot % 2 ? canvas.width : canvas.height;
    const c = makeCanvas(sw, sh);
    const ctx = c.getContext('2d');
    ctx.translate(sw / 2, sh / 2);
    ctx.rotate(rot * Math.PI / 2);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return c;
  }

  // Xoay 4 góc (chuẩn hoá 0..1) theo cùng phép xoay ảnh, giữ thứ tự TL,TR,BR,BL
  function rotateCorners(q, dir) {
    if (dir > 0) { // phải (cw)
      const m = q.map(([x, y]) => [1 - y, x]);
      return [m[3], m[0], m[1], m[2]];
    }
    const m = q.map(([x, y]) => [y, 1 - x]);
    return [m[1], m[2], m[3], m[0]];
  }

  const FULL = () => [[0, 0], [1, 0], [1, 1], [0, 1]];

  // ---------- Tự nhận mép giấy ----------
  // Cách 1: lấy màu giấy ở giữa ảnh làm mẫu, loang ra vùng cùng màu (loại mặt bàn gỗ, vải màu...).
  // Cách 2 (dự phòng): vùng sáng lớn nhất theo ngưỡng Otsu.
  // Sau đó khớp 4 đường thẳng theo mép giấy để lấy góc chính xác.
  // src: canvas / ImageBitmap / video; S: cạnh dài khi phân tích (nhỏ = nhanh, dùng cho camera trực tiếp)
  function detect(src, S = 360) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const k = Math.min(1, S / Math.max(sw, sh));
    const w = Math.max(8, Math.round(sw * k));
    const h = Math.max(8, Math.round(sh * k));
    if (!detect._c || detect._c.width !== w || detect._c.height !== h) detect._c = makeCanvas(w, h);
    const c = detect._c;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    let R = new Float32Array(n), G = new Float32Array(n), Bc = new Float32Array(n);
    for (let i = 0; i < n; i++) { R[i] = d[i * 4]; G[i] = d[i * 4 + 1]; Bc[i] = d[i * 4 + 2]; }
    R = boxBlur(R, w, h, 2); G = boxBlur(G, w, h, 2); Bc = boxBlur(Bc, w, h, 2);
    const g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * Bc[i];

    const tries = [];
    const m1 = paperMask(R, G, Bc, g, w, h);
    if (m1) tries.push(m1);
    const m2 = otsuMask(g, w, h);
    if (m2) tries.push(m2);
    for (const mask of tries) {
      const q = quadFromMask(mask, w, h);
      if (q) return q.map(([x, y]) => [clamp01(x / w), clamp01(y / h)]);
    }
    return null;
  }

  // Vùng giấy theo màu mẫu ở giữa ảnh, loang từ tâm
  function paperMask(R, G, B, L, w, h) {
    const n = w * h;
    const x0 = Math.round(w * 0.3), x1 = Math.round(w * 0.7), y0 = Math.round(h * 0.3), y1 = Math.round(h * 0.7);
    const sample = [];
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) sample.push(y * w + x);
    // bỏ chữ (tối): chỉ lấy 50% điểm sáng nhất
    sample.sort((a, b) => L[a] - L[b]);
    const top = sample.slice(Math.floor(sample.length * 0.5));
    if (!top.length) return null;
    const med = (arr) => { arr.sort((a, b) => a - b); return arr[arr.length >> 1]; };
    const refL = med(top.map((i) => L[i]));
    const refCr = med(top.map((i) => R[i] - G[i]));
    const refCb = med(top.map((i) => (R[i] + G[i]) / 2 - B[i]));
    if (refL < 70) return null; // giữa ảnh quá tối -> không phải giấy
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const dc = Math.abs(R[i] - G[i] - refCr) + Math.abs((R[i] + G[i]) / 2 - B[i] - refCb);
      ok[i] = L[i] > refL * 0.55 && dc < 26 + refL * 0.06 ? 1 : 0;
    }
    // loang từ các điểm giấy ở vùng giữa
    const mask = new Uint8Array(n), stack = new Int32Array(n);
    let sp = 0, size = 0;
    for (const i of top) if (ok[i] && !mask[i]) { mask[i] = 1; stack[sp++] = i; }
    while (sp) {
      const p = stack[--sp]; size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && ok[p - 1] && !mask[p - 1]) { mask[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && ok[p + 1] && !mask[p + 1]) { mask[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && ok[p - w] && !mask[p - w]) { mask[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && ok[p + w] && !mask[p + w]) { mask[p + w] = 1; stack[sp++] = p + w; }
    }
    if (size < n * 0.12 || size > n * 0.985) return null;
    return mask;
  }

  // Tứ giác từ mặt nạ: 4 góc thô -> khớp đường thẳng từng cạnh -> giao điểm
  function quadFromMask(mask, w, h, minFrac = 0.1) {
    const n = w * h, pts = [];
    let cx = 0, cy = 0;
    for (let p = 0; p < n; p++) if (mask[p]) {
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[p - 1] || !mask[p + 1] || !mask[p - w] || !mask[p + w]) {
        pts.push([x + 0.5, y + 0.5]); cx += x; cy += y;
      }
    }
    if (pts.length < 12) return null;
    cx /= pts.length; cy /= pts.length;
    const far = (from) => { let b = null, bd = -1; for (const p of pts) { const dd = (p[0] - from[0]) ** 2 + (p[1] - from[1]) ** 2; if (dd > bd) { bd = dd; b = p; } } return b; };
    const a = far([cx, cy]);
    const b = far(a);
    let c1 = null, c2 = null, mx1 = 0, mx2 = 0;
    for (const p of pts) {
      const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cr > mx1) { mx1 = cr; c1 = p; }
      if (cr < mx2) { mx2 = cr; c2 = p; }
    }
    if (!c1 || !c2) return null;
    let quad = orderQuad([a, c1, b, c2]);
    if (Math.abs(polyArea(quad)) < n * minFrac) return null;

    // khớp đường thẳng cho từng cạnh bằng các điểm biên nằm gần cạnh đó
    const tol = Math.max(w, h) * 0.035;
    const lines = [];
    for (let e = 0; e < 4; e++) {
      const P = quad[e], Q = quad[(e + 1) % 4];
      const dx = Q[0] - P[0], dy = Q[1] - P[1], len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, cnt = 0;
      for (const p of pts) {
        const rx = p[0] - P[0], ry = p[1] - P[1];
        const t = (rx * ux + ry * uy) / len;
        if (t < 0.12 || t > 0.88) continue; // bỏ vùng gần góc (góc giấy hay quăn)
        if (Math.abs(rx * uy - ry * ux) > tol) continue;
        sx += p[0]; sy += p[1]; sxx += p[0] * p[0]; syy += p[1] * p[1]; sxy += p[0] * p[1]; cnt++;
      }
      if (cnt < 6) { lines.push(null); continue; }
      const mxp = sx / cnt, myp = sy / cnt;
      const cxx = sxx / cnt - mxp * mxp, cyy = syy / cnt - myp * myp, cxy = sxy / cnt - mxp * myp;
      const ang = 0.5 * Math.atan2(2 * cxy, cxx - cyy); // hướng chính của các điểm
      lines.push({ px: mxp, py: myp, dx: Math.cos(ang), dy: Math.sin(ang) });
    }
    const refined = quad.map((corner, i) => {
      const L1 = lines[(i + 3) % 4], L2 = lines[i]; // cạnh trước và cạnh sau của góc i
      if (!L1 || !L2) return corner;
      const den = L1.dx * L2.dy - L1.dy * L2.dx;
      if (Math.abs(den) < 0.2) return corner; // gần song song
      const t = ((L2.px - L1.px) * L2.dy - (L2.py - L1.py) * L2.dx) / den;
      const X = L1.px + t * L1.dx, Y = L1.py + t * L1.dy;
      if (Math.hypot(X - corner[0], Y - corner[1]) > Math.max(w, h) * 0.12) return corner;
      return [Math.max(0, Math.min(w, X)), Math.max(0, Math.min(h, Y))];
    });
    const rq = orderQuad(refined);
    return isConvexQuad(rq) && Math.abs(polyArea(rq)) > n * minFrac ? rq : quad;
  }

  // ---------- Nhận diện theo VÙNG CHỮ ----------
  // Tìm nét chữ (tối hơn nền giấy xung quanh) -> nối chữ thành khối -> chọn khối chữ chính của trang
  // (bỏ các mẩu chữ của trang bên cạnh chạm mép ảnh) -> tứ giác ôm khối chữ, nới thêm lề.
  function grayOf(src, S) {
    const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
    const k = Math.min(1, S / Math.max(sw, sh));
    const w = Math.max(8, Math.round(sw * k)), h = Math.max(8, Math.round(sh * k));
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data, g = new Float32Array(w * h), ch = new Float32Array(w * h);
    for (let i = 0; i < g.length; i++) {
      const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
      g[i] = 0.299 * r + 0.587 * gg + 0.114 * b;
      ch[i] = Math.max(r, gg, b) - Math.min(r, gg, b); // độ đậm màu
    }
    return { g, ch, w, h };
  }

  // mặt nạ nét chữ: điểm tối rõ rệt so với nền GIẤY quanh nó (nền sáng, ít màu).
  // Loại vân gỗ, vải hoa, bóng mép sách (nền nhiều màu hoặc tối).
  // edgeSafe: nền = điểm SÁNG nhất quanh đó (phía giấy) -> chữ sát mép giấy cạnh mặt bàn tối vẫn được nhận.
  //   Chỉ dùng trên ảnh ĐÃ làm trắng giấy (bước tẩy nền); khi nhận diện ảnh gốc dùng nền trung bình để không nhầm vân gỗ.
  function inkMask(g, w, h, ch, edgeSafe) {
    let bg, bgc;
    if (edgeSafe) {
      const r = Math.max(3, Math.round(Math.max(w, h) / 90));
      bg = boxBlur(slide(g, w, h, r, true), w, h, 1);
      bgc = null;
    } else {
      const r = Math.max(4, Math.round(Math.max(w, h) / 40));
      bg = boxBlur(boxBlur(g, w, h, r), w, h, r);
      bgc = ch ? boxBlur(boxBlur(ch, w, h, r), w, h, r) : null;
    }
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) {
      if (!(bg[i] > 110 && g[i] < bg[i] * 0.8 && bg[i] - g[i] > 20)) continue;
      if (bgc && (bgc[i] > 42 || (ch[i] > 70 && g[i] > 80))) continue;
      m[i] = 1;
    }
    return m;
  }

  // lọc lớn nhất / nhỏ nhất trong cửa sổ (2r+1)² (tách theo hàng rồi cột)
  function slide(src, w, h, r, isMax) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const pick = isMax ? Math.max : Math.min;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let v = src[row + x];
        const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
        for (let k = a; k <= b; k += 2) v = pick(v, src[row + k]);
        tmp[row + x] = v;
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let v = tmp[y * w + x];
        const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
        for (let k = a; k <= b; k += 2) v = pick(v, tmp[k * w + x]);
        out[y * w + x] = v;
      }
    }
    return out;
  }

  // giãn mặt nạ theo hộp (2rx+1)×(2ry+1) bằng ảnh tích phân
  function dilateBox(m, w, h, rx, ry) {
    const I = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += m[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    }
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ry), y1 = Math.min(h, y + ry + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rx), x1 = Math.min(w, x + rx + 1);
        out[y * w + x] = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0] > 0 ? 1 : 0;
      }
    }
    return out;
  }

  function detectContent(src, S = 480) {
    const { g, ch, w, h } = grayOf(src, S);
    const n = w * h;
    let ink = inkMask(g, w, h, ch);
    ink = dropCutOffLines(ink, w, h);
    ink = keepMainColumn(ink, w, h);
    let inkTotal = 0; for (let i = 0; i < n; i++) inkTotal += ink[i];
    if (inkTotal < n * 0.004) return null; // gần như không có chữ
    // nối chữ thành dòng, dòng thành khối
    const blk = dilateBox(ink, w, h, Math.max(2, Math.round(w * 0.011)), Math.max(2, Math.round(h * 0.012)));
    // gán nhãn khối
    const lab = new Int32Array(n), stack = new Int32Array(n), comps = [];
    for (let s = 0; s < n; s++) {
      if (!blk[s] || lab[s]) continue;
      const id = comps.length + 1;
      let sp = 0, inkc = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, sx = 0, sy = 0, cnt = 0;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        inkc += ink[p]; cnt++; sx += x; sy += y;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && blk[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && blk[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && blk[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && blk[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      const eb = Math.round(Math.min(w, h) * 0.012);
      comps.push({ id, ink: inkc, x0, x1, y0, y1, cx: sx / cnt, cy: sy / cnt,
        border: x0 <= eb || x1 >= w - 1 - eb || y0 <= eb || y1 >= h - 1 - eb });
    }
    if (!comps.length) return null;
    // khối chính: nhiều chữ nhất, ưu tiên gần giữa ảnh và không chạm mép ảnh
    const diag = Math.hypot(w, h) / 2;
    const score = (c) => c.ink * (1 - 0.6 * Math.hypot(c.cx - w / 2, c.cy - h / 2) / diag) * (c.border ? 0.6 : 1);
    let main = comps[0]; for (const c of comps) if (score(c) > score(main)) main = c;
    if (main.ink < inkTotal * 0.25) return null;
    // gộp các khối lân cận (đề mục, số trang...) nằm sát khối chính, bỏ khối chạm mép ảnh (chữ trang bên cạnh)
    const sel = new Set([main.id]);
    let U = { x0: main.x0, x1: main.x1, y0: main.y0, y1: main.y1 };
    const gap = Math.max(w, h) * 0.045;
    for (let changed = true; changed;) {
      changed = false;
      for (const c of comps) {
        if (sel.has(c.id) || c.ink < inkTotal * 0.002) continue;
        if (c.border && !main.border) continue;
        const near = c.x0 <= U.x1 + gap && c.x1 >= U.x0 - gap && c.y0 <= U.y1 + gap && c.y1 >= U.y0 - gap;
        if (!near) continue;
        sel.add(c.id); changed = true;
        U = { x0: Math.min(U.x0, c.x0), x1: Math.max(U.x1, c.x1), y0: Math.min(U.y0, c.y0), y1: Math.max(U.y1, c.y1) };
      }
    }
    const mask = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (sel.has(lab[p])) mask[p] = 1;
    trimAtGutter(mask, ink, w, h);
    // khung ổn định theo dòng chữ (không phụ thuộc điểm lẻ) -> camera không bị nhảy
    const q = textQuad(mask, ink, w, h) || quadFromMask(mask, w, h, 0.03);
    if (!q) return null;
    // nới lề quanh khối chữ (~5% cạnh dài khối) cho giống lề giấy thật, không cắt sát chữ
    // (phần nền bàn lọt vào lề sẽ được tô trắng ở bước tẩy nền)
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    const size = Math.max(Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]), Math.hypot(q[3][0] - q[0][0], q[3][1] - q[0][1]));
    const mpx = size * 0.05 * 1.41;
    return q.map(([x, y]) => {
      const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
      return [clamp01((x + dx / L * mpx) / w), clamp01((y + dy / L * mpx) / h)];
    });
  }

  // Bỏ chữ của trang bên cạnh / chữ bị khung ảnh cắt ngang:
  // tách nét chữ thành từng đoạn dòng; đoạn chạm mép ảnh -> bỏ, kéo theo các đoạn nối tiếp trên cùng dòng.
  function dropCutOffLines(ink, w, h) {
    const n = w * h;
    const seg = dilateBox(ink, w, h, Math.max(2, Math.round(w * 0.006)), 1);
    const lab = new Int32Array(n), stack = new Int32Array(n), segs = [];
    for (let s = 0; s < n; s++) {
      if (!seg[s] || lab[s]) continue;
      const id = segs.length + 1;
      let sp = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, inkc = 0;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        inkc += ink[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && seg[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && seg[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && seg[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && seg[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      segs.push({ x0, x1, y0, y1, ink: inkc, rm: false });
    }
    const ex = Math.round(w * 0.015), ey = Math.round(h * 0.012);
    let removedInk = 0, totalInk = 0;
    for (const s of segs) {
      totalInk += s.ink;
      if (s.x0 <= ex || s.x1 >= w - 1 - ex || s.y0 <= ey || s.y1 >= h - 1 - ey) s.rm = true;
    }
    // lan theo dòng: đoạn nằm cùng hàng và sát đoạn đã bỏ (khoảng cách chữ < 1,3% bề ngang)
    const gap = w * 0.013;
    const order = segs.map((s, i) => i).sort((a, b) => segs[a].y0 - segs[b].y0);
    for (let changed = true, iter = 0; changed && iter < 30; iter++) {
      changed = false;
      for (let ii = 0; ii < order.length; ii++) {
        const r = segs[order[ii]];
        if (!r.rm) continue;
        for (let jj = ii - 1; jj >= 0 && segs[order[jj]].y0 > r.y0 - h * 0.05; jj--) changed = spread(r, segs[order[jj]]) || changed;
        for (let jj = ii + 1; jj < order.length && segs[order[jj]].y0 < r.y1; jj++) changed = spread(r, segs[order[jj]]) || changed;
      }
    }
    function spread(r, c) {
      if (c.rm) return false;
      const ov = Math.min(r.y1, c.y1) - Math.max(r.y0, c.y0);
      if (ov < 0.5 * Math.min(r.y1 - r.y0 + 1, c.y1 - c.y0 + 1)) return false;
      const gx = c.x0 > r.x1 ? c.x0 - r.x1 : r.x0 > c.x1 ? r.x0 - c.x1 : 0;
      if (gx > gap) return false;
      c.rm = true; return true;
    }
    for (const s of segs) if (s.rm) removedInk += s.ink;
    if (removedInk > totalInk * 0.5) return ink; // khung chụp sát quá -> giữ nguyên, không đoán bừa
    const out = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (ink[p] && lab[p] && !segs[lab[p] - 1].rm) out[p] = 1;
    return out;
  }

  // Tứ giác ôm khối chữ, tính theo cách THỐNG KÊ nên rất ổn định giữa các khung hình:
  //  - góc nghiêng = góc làm hình chiếu các dòng chữ "sắc" nhất
  //  - mép trên/dưới = phân vị 0,3% / 99,7% của chữ theo phương vuông góc dòng
  //  - mép trái/phải = đường thẳng khớp qua điểm đầu/cuối dòng của 8 nhóm dòng (bắt được độ chụm khi chụp xiên)
  function textQuad(mask, ink, w, h) {
    const xs = [], ys = [];
    for (let p = 0; p < w * h; p++) if (mask[p] && ink[p]) { xs.push(p % w); ys.push((p / w) | 0); }
    const N = xs.length;
    if (N < 200) return null;
    const step = Math.max(1, Math.floor(N / 15000)); // lấy mẫu cho nhanh
    // 1) góc nghiêng của dòng chữ
    const H = Math.ceil(Math.hypot(w, h)) + 2;
    const hist = new Float32Array(H);
    let bestA = 0, bestS = -1;
    for (let deg = -12; deg <= 12; deg += 0.5) {
      const a = deg * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
      hist.fill(0);
      for (let i = 0; i < N; i += step) { const v = (-xs[i] * s + ys[i] * c + w) | 0; if (v >= 0 && v < H) hist[v]++; }
      let sc = 0; for (let k = 0; k < H; k++) sc += hist[k] * hist[k];
      if (sc > bestS) { bestS = sc; bestA = a; }
    }
    // tinh chỉnh ±0,5° với bước 0,1°
    for (let deg = bestA * 180 / Math.PI - 0.4; deg <= bestA * 180 / Math.PI + 0.41; deg += 0.1) {
      const a = deg * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
      hist.fill(0);
      for (let i = 0; i < N; i += step) { const v = (-xs[i] * s + ys[i] * c + w) | 0; if (v >= 0 && v < H) hist[v]++; }
      let sc = 0; for (let k = 0; k < H; k++) sc += hist[k] * hist[k];
      if (sc > bestS) { bestS = sc; bestA = a; }
    }
    const s = Math.sin(bestA), c = Math.cos(bestA);
    // 2) toạ độ theo dòng: u dọc dòng, v vuông góc
    const U = new Float32Array(N), V = new Float32Array(N);
    for (let i = 0; i < N; i++) { U[i] = xs[i] * c + ys[i] * s; V[i] = -xs[i] * s + ys[i] * c; }
    const q = (arr, f) => { const a = Float32Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.max(0, Math.floor(f * (a.length - 1))))]; };
    const v0 = q(V, 0.003), v1 = q(V, 0.997);
    if (v1 - v0 < h * 0.08) return null;
    // 3) mép trái/phải theo 8 nhóm dòng
    const NB = 8, bl = [], br = [];
    for (let b = 0; b < NB; b++) {
      const lo = v0 + (v1 - v0) * b / NB, hi = v0 + (v1 - v0) * (b + 1) / NB, us = [];
      for (let i = 0; i < N; i++) if (V[i] >= lo && V[i] < hi) us.push(U[i]);
      if (us.length < 30) continue;
      us.sort((a, b2) => a - b2);
      bl.push([(lo + hi) / 2, us[Math.floor(us.length * 0.01)]]);
      br.push([(lo + hi) / 2, us[Math.floor(us.length * 0.99)]]);
    }
    if (bl.length < 3) return null;
    // đường thẳng u = a + b·v, khớp bền: bỏ nhóm lệch xa nhất rồi khớp lại (dòng ngắn/thụt đầu dòng)
    const fit = (pts, side) => {
      const ls = (P) => { const n = P.length; let sv = 0, su = 0, svv = 0, svu = 0; for (const [v, u] of P) { sv += v; su += u; svv += v * v; svu += v * u; } const d = n * svv - sv * sv; const b = d ? (n * svu - sv * su) / d : 0; return [(su - b * sv) / n, b]; };
      let P = pts.slice(), [a, b] = ls(P);
      for (let it = 0; it < 2 && P.length > 3; it++) {
        // phía trái: điểm lệch vào trong (u lớn hơn đường) là dòng thụt -> bỏ; phía phải ngược lại
        let worst = -1, wd = 0;
        P.forEach(([v, u], k) => { const d = side * (u - (a + b * v)); if (d > wd) { wd = d; worst = k; } });
        if (worst < 0 || wd < w * 0.01) break;
        P.splice(worst, 1); [a, b] = ls(P);
      }
      return [a, b];
    };
    let [aL, sL] = fit(bl, 1), [aR, sR] = fit(br, -1);
    // Độ chụm thật khi chụp xiên: 2 mép chụm vào nhau đối xứng và nhỏ.
    // Mép lệch hẳn 1 bên là do dòng dài/ngắn không đều -> dùng độ xiên chung (trung bình), giới hạn ±6%.
    // Tính LIÊN TỤC (không rẽ nhánh) để rung tay nhỏ chỉ gây xê dịch nhỏ:
    //   m = độ xiên chung của 2 mép, k = nửa độ chụm, bỏ phần nhỏ hơn 1% (coi như nhiễu) và giới hạn.
    const cl = (v, a) => Math.max(-a, Math.min(a, v));
    const m = cl((sL + sR) / 2, 0.06);
    let k = (sL - sR) / 2;
    k = cl(Math.sign(k) * Math.max(0, Math.abs(k) - 0.01), 0.04);
    sL = m + k; sR = m - k;
    // khớp lại hệ số chặn với độ xiên đã giới hạn (giữ mép ngoài cùng của chữ)
    const refit = (pts, sl, side) => { let best = side > 0 ? Infinity : -Infinity; for (const [v, u] of pts) { const a0 = u - sl * v; best = side > 0 ? Math.min(best, a0) : Math.max(best, a0); } return best; };
    aL = refit(bl, sL, 1); aR = refit(br, sR, -1);
    const L = (v) => aL + sL * v, R = (v) => aR + sR * v;
    const toXY = (u, v) => [u * c - v * s, u * s + v * c];
    const quad = [toXY(L(v0), v0), toXY(R(v0), v0), toXY(R(v1), v1), toXY(L(v1), v1)];
    if (!isConvexQuad(quad) || Math.abs(polyArea(quad)) < w * h * 0.03) return null;
    return quad;
  }

  // Giữ cột chữ chính của trang:
  //  1) nét chữ -> đoạn -> ghép thành DÒNG (các đoạn cùng hàng, cách nhau < khoảng cách giữa các từ)
  //  2) cột chính = các dòng dài đi qua giữa trang
  //  3) dòng khác chỉ được giữ nếu nằm trong phạm vi cột chính ở các dòng lân cận (chịu được trang nghiêng)
  //  -> chữ trang bên cạnh (bên kia rãnh gáy) bị bỏ; đề mục, số trang trong cột vẫn giữ
  function keepMainColumn(ink, w, h) {
    const n = w * h;
    const seg = dilateBox(ink, w, h, Math.max(1, Math.round(w * 0.005)), 1);
    const lab = new Int32Array(n), stack = new Int32Array(n), segs = [];
    for (let s = 0; s < n; s++) {
      if (!seg[s] || lab[s]) continue;
      const id = segs.length + 1;
      let sp = 0, x0 = w, x1 = 0, y0 = h, y1 = 0, inkc = 0;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        inkc += ink[p];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && seg[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && seg[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && seg[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && seg[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      segs.push({ x0, x1, y0, y1, ink: inkc });
    }
    if (segs.length < 5) return ink;
    // ghép đoạn thành dòng (union-find)
    const par = segs.map((_, i) => i);
    const find = (i) => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
    const order = segs.map((_, i) => i).sort((a, b) => segs[a].y0 - segs[b].y0);
    const gap = w * 0.016, hMax = h * 0.06;
    for (let a = 0; a < order.length; a++) {
      const A = segs[order[a]];
      for (let b = a + 1; b < order.length && segs[order[b]].y0 <= A.y1; b++) {
        const B = segs[order[b]];
        const ov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0);
        if (ov < 0.5 * Math.min(A.y1 - A.y0 + 1, B.y1 - B.y0 + 1)) continue;
        const gx = B.x0 > A.x1 ? B.x0 - A.x1 : A.x0 > B.x1 ? A.x0 - B.x1 : 0;
        if (gx <= gap) par[find(order[a])] = find(order[b]);
      }
    }
    const lines = new Map();
    segs.forEach((s, i) => {
      const r = find(i);
      const L = lines.get(r) || { x0: w, x1: 0, y0: h, y1: 0, ink: 0, members: [] };
      L.x0 = Math.min(L.x0, s.x0); L.x1 = Math.max(L.x1, s.x1); L.y0 = Math.min(L.y0, s.y0); L.y1 = Math.max(L.y1, s.y1);
      L.ink += s.ink; L.members.push(i); lines.set(r, L);
    });
    const all = [...lines.values()].filter((L) => L.y1 - L.y0 < hMax || L.x1 - L.x0 > w * 0.2);
    // tâm cột chính: trung vị (theo trọng số độ dài²) của tâm các dòng
    const ws = all.map((L) => ({ c: (L.x0 + L.x1) / 2, wt: (L.x1 - L.x0) ** 2 })).sort((a, b) => a.c - b.c);
    const tw = ws.reduce((s, v) => s + v.wt, 0);
    let acc = 0, cx = w / 2;
    for (const v of ws) { acc += v.wt; if (acc >= tw / 2) { cx = v.c; break; } }
    const core = all.filter((L) => L.x0 <= cx && L.x1 >= cx && L.x1 - L.x0 >= w * 0.25);
    const inkAll = all.reduce((s, L) => s + L.ink, 0), inkCore = core.reduce((s, L) => s + L.ink, 0);
    if (!core.length || inkCore < inkAll * 0.3) return ink;
    const keep = new Set(core);
    const tol = w * 0.012, near = h * 0.08;
    for (const L of all) {
      if (keep.has(L)) continue;
      let lx0 = w, lx1 = 0;
      for (const C of core) if (C.y1 >= L.y0 - near && C.y0 <= L.y1 + near) { lx0 = Math.min(lx0, C.x0); lx1 = Math.max(lx1, C.x1); }
      if (lx1 < lx0) continue; // không có dòng chính nào gần -> ngoài trang
      if (L.x1 >= lx0 - tol && L.x0 <= lx1 + tol && L.x0 >= lx0 - w * 0.06) keep.add(L);
    }
    const keepSeg = new Uint8Array(segs.length + 1);
    for (const L of keep) for (const i of L.members) keepSeg[i + 1] = 1;
    const out = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (ink[p] && keepSeg[lab[p]]) out[p] = 1;
    return out;
  }

  // Cắt phần chữ của trang bên cạnh: tìm rãnh trống (dải cột/hàng không có chữ) trong khối;
  // phần bên kia rãnh mà chạm mép ảnh và ít chữ hơn -> bỏ.
  function trimAtGutter(mask, ink, w, h) {
    for (const vertical of [true, false]) {
      const L = vertical ? w : h, M = vertical ? h : w;
      const prof = new Float32Array(L);
      let total = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (mask[p] && ink[p]) { prof[vertical ? x : y]++; total++; }
      }
      if (!total) return;
      let a = 0, b = L - 1;
      while (a < L && !prof[a]) a++;
      while (b > a && !prof[b]) b--;
      const minRun = Math.max(3, Math.round(L * 0.008)), empty = M * 0.002;
      // các rãnh trống bên trong khối
      const gutters = [];
      for (let i = a; i <= b;) {
        if (prof[i] <= empty) { let j = i; while (j <= b && prof[j] <= empty) j++; if (j - i >= minRun) gutters.push([i, j]); i = j; } else i++;
      }
      const edge = Math.round(L * 0.015);
      let cutLo = -1, cutHi = L;
      for (const [i, j] of gutters) {
        let before = 0, after = 0;
        for (let k = a; k < i; k++) before += prof[k];
        for (let k = j; k <= b; k++) after += prof[k];
        if (a <= edge && before < total * 0.4) cutLo = Math.max(cutLo, j - 1);     // phần trước rãnh chạm mép đầu
        if (b >= L - 1 - edge && after < total * 0.4) cutHi = Math.min(cutHi, i);   // phần sau rãnh chạm mép cuối
      }
      if (cutLo < 0 && cutHi >= L) continue;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const t = vertical ? x : y;
        if (t <= cutLo || t >= cutHi) mask[y * w + x] = 0;
      }
    }
  }

  // ---------- Nhận diện theo CẠNH THẲNG (mép giấy / mép thẻ) ----------
  // 1) gradient độ sáng + độ màu (Sobel) -> điểm biên (lọc cực đại theo hướng)
  // 2) Hough có ràng buộc hướng: mỗi điểm biên chỉ bỏ phiếu cho đường gần vuông góc với gradient của nó
  // 3) lấy các đường mạnh, ghép 2 cặp gần song song thành tứ giác
  // 4) chấm điểm: tỉ lệ chiều dài mỗi cạnh nằm trên biên thật cùng hướng (chịu được ngón tay che một phần)
  function edgeQuads(src, S, opt = {}) {
    const { g, ch, w, h } = grayOf(src, S);
    const n = w * h;
    const G = boxBlur(g, w, h, 1), C = boxBlur(ch, w, h, 1);
    const mag = new Float32Array(n), ang = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = (G[i - w + 1] + 2 * G[i + 1] + G[i + w + 1]) - (G[i - w - 1] + 2 * G[i - 1] + G[i + w - 1]);
      const gy = (G[i + w - 1] + 2 * G[i + w] + G[i + w + 1]) - (G[i - w - 1] + 2 * G[i - w] + G[i - w + 1]);
      const cx = (C[i - w + 1] + 2 * C[i + 1] + C[i + w + 1]) - (C[i - w - 1] + 2 * C[i - 1] + C[i + w - 1]);
      const cy = (C[i + w - 1] + 2 * C[i + w] + C[i + w + 1]) - (C[i - w - 1] + 2 * C[i - w] + C[i - w + 1]);
      const m1 = Math.hypot(gx, gy), m2 = Math.hypot(cx, cy) * 1.3; // độ khác màu cũng là biên (thẻ xanh trên bàn be)
      if (m1 >= m2) { mag[i] = m1; ang[i] = Math.atan2(gy, gx); } else { mag[i] = m2; ang[i] = Math.atan2(cy, cx); }
    }
    // ngưỡng: phân vị 88%, kẹp trong [16, 48] -> chữ đậm trong trang không đẩy ngưỡng lên cao làm mất mép giấy nhạt
    const hist = new Uint32Array(512);
    for (let i = 0; i < n; i++) hist[Math.min(511, mag[i] | 0)]++;
    let acc = 0, t = 20;
    for (let v = 0; v < 512; v++) { acc += hist[v]; if (acc >= n * 0.88) { t = Math.max(16, Math.min(48, v)); break; } }
    // lọc cực đại theo hướng gradient -> biên mảnh
    const edge = new Uint8Array(n);
    let cnt = 0;
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x, m = mag[i];
      if (m < t) continue;
      const a = ang[i], dx = Math.round(Math.cos(a)), dy = Math.round(Math.sin(a));
      if (m >= mag[i + dy * w + dx] && m >= mag[i - dy * w - dx]) { edge[i] = 1; cnt++; }
    }
    if (cnt < 50) return [];
    // Hough có ràng buộc hướng
    const NT = 180, diag = Math.ceil(Math.hypot(w, h)), NR = 2 * diag + 1;
    const H = new Float32Array(NT * NR);
    const cosT = new Float32Array(NT), sinT = new Float32Array(NT);
    for (let k = 0; k < NT; k++) { cosT[k] = Math.cos(k * Math.PI / NT); sinT[k] = Math.sin(k * Math.PI / NT); }
    const SPREAD = 6;
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
      const i = y * w + x; if (!edge[i]) continue;
      let th = ang[i]; if (th < 0) th += Math.PI; // pháp tuyến đường thẳng = hướng gradient (mod 180°)
      const k0 = Math.round(th * NT / Math.PI);
      const wt = Math.min(2, mag[i] / t);
      for (let dk = -SPREAD; dk <= SPREAD; dk++) {
        const k = (k0 + dk + NT) % NT;
        const r = Math.round(x * cosT[k] + y * sinT[k]) + diag;
        H[k * NR + r] += wt;
      }
    }
    // đỉnh: cực đại cục bộ, đủ dài
    const minVotes = Math.min(w, h) * 0.14;
    const peaks = [];
    for (let k = 0; k < NT; k++) for (let r = 0; r < NR; r++) {
      const v = H[k * NR + r]; if (v < minVotes) continue;
      let isMax = true;
      for (let dk = -3; dk <= 3 && isMax; dk++) for (let dr = -6; dr <= 6; dr++) {
        if (!dk && !dr) continue;
        let kk = k + dk, rr = r + dr;
        if (kk < 0) { kk += NT; rr = NR - 1 - rr; } else if (kk >= NT) { kk -= NT; rr = NR - 1 - rr; }
        if (rr < 0 || rr >= NR) continue;
        if (H[kk * NR + rr] > v) { isMax = false; break; }
      }
      if (isMax) peaks.push({ k, r: r - diag, v });
    }
    peaks.sort((a, b) => b.v - a.v);
    const L = peaks.slice(0, 22).map((p) => ({ th: p.k * Math.PI / NT, c: cosT[p.k], s: sinT[p.k], r: p.r, v: p.v }));
    if (L.length < 4) return [];
    // cặp đường gần song song, cách nhau đủ xa
    const angDiff = (a, b) => { let d = Math.abs(a - b) % Math.PI; return Math.min(d, Math.PI - d); };
    const midDist = (a, b) => { // khoảng cách 2 đường đo tại tâm ảnh
      const px = w / 2, py = h / 2;
      return Math.abs((px * a.c + py * a.s - a.r) - (px * b.c + py * b.s - b.r) * Math.sign(a.c * b.c + a.s * b.s || 1));
    };
    const pairs = [];
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      if (angDiff(L[i].th, L[j].th) > 0.35) continue;
      if (midDist(L[i], L[j]) < Math.min(w, h) * 0.12) continue;
      pairs.push([L[i], L[j]]);
    }
    const inter = (a, b) => { const d = a.c * b.s - a.s * b.c; if (Math.abs(d) < 1e-6) return null; return [(a.r * b.s - b.r * a.s) / d, (b.r * a.c - a.r * b.c) / d]; };
    // điểm hỗ trợ của 1 cạnh: tỉ lệ điểm mẫu có biên mạnh cùng hướng (trong ±2px)
    // + "độ chênh 2 bên": mép giấy thật thì 2 bên khác hẳn nhau (giấy | bàn); dòng chữ thì 2 bên đều là giấy
    const strong = t * 0.55, OFF = 5;
    function sideSupport(P, Q) {
      const len = Math.hypot(Q[0] - P[0], Q[1] - P[1]); if (len < 4) return { s: 0, inside: 0, step: 0 };
      const nx = -(Q[1] - P[1]) / len, ny = (Q[0] - P[0]) / len;
      const N = Math.max(8, Math.floor(len / 2));
      let hit = 0, inside = 0, stepSum = 0, stepN = 0;
      for (let k = 0; k <= N; k++) {
        const f = 0.04 + 0.92 * k / N; // bỏ sát góc (góc thẻ bo tròn)
        const x0 = P[0] + (Q[0] - P[0]) * f, y0 = P[1] + (Q[1] - P[1]) * f;
        if (x0 < 2 || y0 < 2 || x0 > w - 3 || y0 > h - 3) continue;
        inside++;
        for (let o = -2; o <= 2; o++) {
          const i = Math.round(y0 + ny * o) * w + Math.round(x0 + nx * o);
          if (mag[i] > strong && Math.abs(Math.cos(ang[i]) * nx + Math.sin(ang[i]) * ny) > 0.85) { hit++; break; }
        }
        const xa = Math.round(x0 + nx * OFF), ya = Math.round(y0 + ny * OFF), xb = Math.round(x0 - nx * OFF), yb = Math.round(y0 - ny * OFF);
        if (xa >= 0 && ya >= 0 && xa < w && ya < h && xb >= 0 && yb >= 0 && xb < w && yb < h) {
          const ia = ya * w + xa, ib = yb * w + xb;
          stepSum += Math.abs(G[ia] - G[ib]) + 0.8 * Math.abs(C[ia] - C[ib]); stepN++;
        }
      }
      return { s: inside ? hit / inside : 0, inside: inside / (N + 1), step: stepN ? stepSum / stepN : 0 };
    }
    const cands = [];
    for (let a = 0; a < pairs.length; a++) for (let b = a + 1; b < pairs.length; b++) {
      const [l1, l2] = pairs[a], [l3, l4] = pairs[b];
      if (l1 === l3 || l1 === l4 || l2 === l3 || l2 === l4) continue;
      const cross = angDiff(l1.th, l3.th);
      if (cross < 0.9) continue; // 2 cặp phải gần vuông góc (> ~52°)
      const pts = [inter(l1, l3), inter(l3, l2), inter(l2, l4), inter(l4, l1)];
      if (pts.some((p) => !p || p[0] < -0.08 * w || p[0] > 1.08 * w || p[1] < -0.08 * h || p[1] > 1.08 * h)) continue;
      const q = orderQuad(pts);
      if (!isConvexQuad(q)) continue;
      const area = Math.abs(polyArea(q));
      if (area < n * (opt.card ? 0.03 : 0.06)) continue;
      let sum = 0, minS = 1, inS = 0, minStep = 1e9;
      for (let e = 0; e < 4; e++) { const r = sideSupport(q[e], q[(e + 1) % 4]); sum += r.s; minS = Math.min(minS, r.s); inS += r.inside; minStep = Math.min(minStep, r.step); }
      if (inS < 2.4) continue; // phần lớn tứ giác phải nằm trong ảnh
      let score = sum / 4;
      if (minS < 0.2) score *= 0.55; // 1 cạnh gần như không có biên -> đáng ngờ
      score *= Math.min(1, minStep / 12); // có cạnh mà 2 bên giống hệt nhau (dòng chữ) -> khung giả
      score *= 0.85 + 0.15 * Math.min(1, area / (n * 0.5));
      if (opt.card) { // tỉ lệ thẻ ID-1 = 1,586
        const sl = [0, 1, 2, 3].map((e) => Math.hypot(q[(e + 1) % 4][0] - q[e][0], q[(e + 1) % 4][1] - q[e][1]));
        const A = (sl[0] + sl[2]) / 2, B = (sl[1] + sl[3]) / 2, ratio = Math.max(A, B) / Math.min(A, B);
        score *= 0.6 + 0.4 * Math.exp(-(((ratio - 1.586) / 0.22) ** 2));
        score *= 0.65 + 0.35 * Math.min(1, area / (n * 0.25)); // ưu tiên khung thẻ bên ngoài, không phải ô ảnh bên trong
      }
      cands.push({ q: q.map(([x, y]) => [clamp01(x / w), clamp01(y / h)]), score, area: area / n });
    }
    cands.sort((a, b) => b.score - a.score);
    return cands.slice(0, 12);
  }

  // tỉ lệ các điểm của tứ giác A nằm trong tứ giác B (A đã chuẩn hoá)
  function containFrac(A, B) {
    const inside = (p) => { let s = 0; for (let i = 0; i < 4; i++) { const a = B[i], b = B[(i + 1) % 4]; const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (c !== 0) { const sg = Math.sign(c); if (s && sg !== s) return false; s = sg; } } return true; };
    let k = 0, tot = 0;
    for (let i = 0; i < 4; i++) for (let f = 0; f < 1; f += 0.25) {
      const a = A[i], b = A[(i + 1) % 4]; tot++;
      if (inside([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])) k++;
    }
    return k / tot;
  }

  // Chọn cách nhận: 'text' = theo vùng chữ (mặc định cho tài liệu), 'paper' = theo mép giấy (thẻ, ảnh)
  // mode: 'auto' (tài liệu, mặc định) | 'paper' (chỉ mép giấy) | 'text' (chỉ vùng chữ) | 'card' (CCCD / thẻ)
  // Dùng CÙNG độ phân giải cho camera và ảnh đã chụp -> khung trên camera = khung cắt sau khi chụp.
  function detectAuto(src, mode, fast) {
    const ES = 400; // camera và ảnh đã chụp dùng chung (dò chạy ở luồng nền nên không ảnh hưởng độ mượt)
    if (mode === 'text') return detectContent(src, 480) || detect(src, 360);
    if (mode === 'card') {
      const c = edgeQuads(src, ES, { card: true });
      if (c.length && c[0].score >= 0.42) return c[0].q;
      return detect(src, 360);
    }
    const cands = edgeQuads(src, ES);
    if (mode === 'paper') return cands.length && cands[0].score >= 0.42 ? cands[0].q : detect(src, 360);
    // auto: mép giấy nếu thấy rõ VÀ ôm trọn khối chữ chính (sách mở -> đúng 1 trang); không thì cắt theo vùng chữ
    const tq = detectContent(src, 480);
    if (tq) {
      // khối chữ thu nhỏ 15% về tâm (bỏ phần lề đã nới) để kiểm tra "mép giấy ôm trọn chữ"
      const tcx = tq.reduce((s, p) => s + p[0], 0) / 4, tcy = tq.reduce((s, p) => s + p[1], 0) / 4;
      const core = tq.map(([x, y]) => [tcx + (x - tcx) * 0.85, tcy + (y - tcy) * 0.85]);
      const ta = Math.abs(polyArea(core));
      for (const c of cands) {
        if (c.score < 0.42) break;
        const cf = containFrac(core, c.q);
        // mép giấy rõ ràng (điểm cao) thì tin mép giấy, kể cả khi khối chữ dò lệch (bàn bừa bộn)
        if (cf < 0.85 && !(c === cands[0] && c.score >= 0.8 && cf >= 0.3)) continue;
        if (Math.abs(polyArea(c.q)) > ta * 3.4) continue;     // không lấy cả 2 trang sách / cả mặt bàn
        return c.q;
      }
      return tq;
    }
    if (cands.length && cands[0].score >= 0.5) return cands[0].q;
    return detect(src, 360);
  }

  // ---------- LÀM PHẲNG trang cong (theo dòng chữ) ----------
  // Chia trang thành các dải dọc, so độ lệch dọc của dòng chữ giữa các dải cạnh nhau, cộng dồn từ giữa ra
  // -> trường dịch chuyển D(x, y) mượt (đa thức bậc 2 theo x, nội suy theo y) -> kéo dòng chữ thẳng lại.
  function flatten(canvas) {
    const A = 760;
    const { g, ch, w, h } = grayOf(canvas, A);
    const ink = inkMask(g, w, h, ch);
    // vùng có chữ theo chiều ngang / dọc
    const colSum = new Float32Array(w), rowSum = new Float32Array(h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = ink[y * w + x]; colSum[x] += v; rowSum[y] += v; }
    const firstLast = (arr, thr) => { let a = 0, b = arr.length - 1; while (a < b && arr[a] < thr) a++; while (b > a && arr[b] < thr) b--; return [a, b]; };
    const [tx0, tx1] = firstLast(colSum, h * 0.01), [ty0, ty1] = firstLast(rowSum, w * 0.01);
    if (tx1 - tx0 < w * 0.4 || ty1 - ty0 < h * 0.3) return canvas;
    const NS = 12, NB = 4, sw = (tx1 - tx0) / NS;
    // hồ sơ hàng của từng dải
    const P = [];
    for (let s = 0; s < NS; s++) {
      const a = Math.round(tx0 + s * sw), b = Math.round(tx0 + (s + 1) * sw), pr = new Float32Array(h);
      for (let y = 0; y < h; y++) { let t = 0; for (let x = a; x < b; x++) t += ink[y * w + x]; pr[y] = t; }
      P.push(boxBlur(pr, h, 1, 1));
    }
    // khoảng cách dòng (tự tương quan của hồ sơ tổng)
    const tot = new Float32Array(h); for (const pr of P) for (let y = 0; y < h; y++) tot[y] += pr[y];
    let mean = 0; for (let y = ty0; y <= ty1; y++) mean += tot[y]; mean /= (ty1 - ty0 + 1);
    let bestLag = 0, bestAc = 0, prevAc = Infinity, descending = true;
    for (let lag = 4; lag < (ty1 - ty0) / 3; lag++) {
      let ac = 0; for (let y = ty0; y + lag <= ty1; y++) ac += (tot[y] - mean) * (tot[y + lag] - mean);
      if (descending) { if (ac > prevAc) descending = false; prevAc = ac; continue; }
      if (ac > bestAc) { bestAc = ac; bestLag = lag; } else if (bestLag && ac < bestAc * 0.7) break;
    }
    if (!bestLag) return canvas;
    const maxShift = Math.max(1, Math.round(bestLag * 0.4));
    const bandH = (ty1 - ty0) / NB;
    const bandC = [], fits = [];
    for (let bnd = 0; bnd < NB; bnd++) {
      const ya = Math.round(ty0 + bnd * bandH), yb = Math.round(ty0 + (bnd + 1) * bandH);
      bandC.push((ya + yb) / 2);
      // độ lệch giữa dải s và s+1 trong băng này
      const step = [], conf = [];
      for (let s = 0; s < NS - 1; s++) {
        let bd = 0, bv = -1, n0 = 0, n1 = 0;
        for (let y = ya; y < yb; y++) { n0 += P[s][y] * P[s][y]; n1 += P[s + 1][y] * P[s + 1][y]; }
        for (let dd = -maxShift; dd <= maxShift; dd++) {
          let v = 0; for (let y = ya; y < yb; y++) { const yy = y + dd; if (yy >= 0 && yy < h) v += P[s][y] * P[s + 1][yy]; }
          if (v > bv) { bv = v; bd = dd; }
        }
        const c = n0 && n1 ? bv / Math.sqrt(n0 * n1) : 0;
        step.push(c > 0.35 ? bd : 0); conf.push(c > 0.35 ? c : 0);
      }
      // cộng dồn từ dải giữa ra hai bên
      const mid = NS >> 1, D = new Float32Array(NS), W = new Float32Array(NS);
      W[mid] = 1;
      for (let s = mid; s < NS - 1; s++) { D[s + 1] = D[s] + step[s]; W[s + 1] = conf[s]; }
      for (let s = mid - 1; s >= 0; s--) { D[s] = D[s + 1] - step[s]; W[s] = conf[s]; }
      // khớp đa thức bậc 2 có trọng số: D(x) = c0 + c1 t + c2 t², t = vị trí chuẩn hoá -1..1
      let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Y = [0, 0, 0];
      for (let s = 0; s < NS; s++) {
        const t = ((tx0 + (s + 0.5) * sw) - w / 2) / (w / 2), v = [1, t, t * t], wt = W[s];
        for (let i = 0; i < 3; i++) { Y[i] += wt * v[i] * D[s]; for (let j = 0; j < 3; j++) S[i][j] += wt * v[i] * v[j]; }
      }
      fits.push(solve3(S, Y) || [0, 0, 0]);
    }
    // độ cong đáng kể không?
    let maxD = 0;
    for (const f of fits) for (const t of [-1, -0.5, 0, 0.5, 1]) maxD = Math.max(maxD, Math.abs(f[1] * t + f[2] * t * t));
    if (maxD < 1.2) return canvas; // trang vốn đã phẳng
    // áp dụng lên ảnh đầy đủ
    const W2 = canvas.width, H2 = canvas.height, f = W2 / w;
    const lim = H2 * 0.06;
    const Db = fits.map((c) => {
      const arr = new Float32Array(W2);
      for (let x = 0; x < W2; x++) { const t = (x / f - w / 2) / (w / 2); let v = (c[1] * t + c[2] * t * t) * f; arr[x] = Math.max(-lim, Math.min(lim, v)); }
      return arr;
    });
    if (!canvas._px) canvas._px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W2, H2).data;
    const sd = canvas._px, out = makeCanvas(W2, H2), octx = out.getContext('2d'), od = octx.createImageData(W2, H2), o = od.data;
    const off = new Float32Array(W2), row = W2 * 4;
    let i = 0;
    for (let y = 0; y < H2; y++) {
      const ya = y / f; let bi = 0;
      while (bi < NB - 2 && ya > bandC[bi + 1]) bi++;
      let t = (ya - bandC[bi]) / (bandC[bi + 1] - bandC[bi]); t = t < 0 ? 0 : t > 1 ? 1 : t;
      const A0 = Db[bi], A1 = Db[bi + 1];
      for (let x = 0; x < W2; x++) off[x] = A0[x] * (1 - t) + A1[x] * t;
      for (let x = 0; x < W2; x++, i += 4) {
        let sy = y + off[x]; if (sy < 0) sy = 0; else if (sy > H2 - 1.001) sy = H2 - 1.001;
        const iy = sy | 0, fy = sy - iy, p = (iy * W2 + x) << 2, p2 = p + row;
        o[i] = sd[p] * (1 - fy) + sd[p2] * fy;
        o[i + 1] = sd[p + 1] * (1 - fy) + sd[p2 + 1] * fy;
        o[i + 2] = sd[p + 2] * (1 - fy) + sd[p2 + 2] * fy;
        o[i + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // ---------- TẨY NỀN NGOÀI NỘI DUNG ----------
  // Sau khi làm nét: tìm khung bao quanh chữ (bỏ mẩu chữ/vệt tối chạm mép ảnh), nới lề,
  // rồi tô trắng toàn bộ phần bên ngoài -> mất hẳn bàn ghế, bóng tay, mép sách còn sót ở rìa.
  function cleanBorder(canvas) {
    const { g, ch, w, h } = grayOf(canvas, 600);
    let ink = inkMask(g, w, h, ch, true);
    ink = dropCutOffLines(ink, w, h);
    // chỉ tính nét thuộc cụm chữ thật (đoạn có ≥ 12 điểm), bỏ chấm nhiễu lẻ tẻ -> giữ được chữ nhỏ ở rìa như "Trang 1"
    const seg = dilateBox(ink, w, h, Math.max(2, Math.round(w * 0.006)), 1);
    const lab = new Int32Array(w * h), size = [0], stack = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!seg[s] || lab[s]) continue;
      const id = size.length; let sp = 0, cnt = 0;
      stack[sp++] = s; lab[s] = id;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0; cnt += ink[p];
        if (x > 0 && seg[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack[sp++] = p - 1; }
        if (x < w - 1 && seg[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack[sp++] = p + 1; }
        if (y > 0 && seg[p - w] && !lab[p - w]) { lab[p - w] = id; stack[sp++] = p - w; }
        if (y < h - 1 && seg[p + w] && !lab[p + w]) { lab[p + w] = id; stack[sp++] = p + w; }
      }
      size.push(cnt);
    }
    const cols = new Float32Array(w), rows = new Float32Array(h);
    let tot = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (ink[p] && size[lab[p]] >= 12) { cols[x]++; rows[y]++; tot++; }
    }
    if (tot < w * h * 0.003) return canvas;
    const range = (arr) => {
      let a = 0, b = arr.length - 1;
      while (a < b && !arr[a]) a++;
      while (b > a && !arr[b]) b--;
      return [a, b];
    };
    const [x0, x1] = range(cols), [y0, y1] = range(rows);
    if ((x1 - x0) * (y1 - y0) < w * h * 0.2) return canvas;
    const pad = Math.max(w, h) * 0.045, f = canvas.width / w;
    const X0 = Math.max(0, (x0 - pad) * f), X1 = Math.min(canvas.width, (x1 + 1 + pad) * f);
    const Y0 = Math.max(0, (y0 - pad) * f), Y1 = Math.min(canvas.height, (y1 + 1 + pad) * f);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, Y0);
    ctx.fillRect(0, Y1, canvas.width, canvas.height - Y1);
    ctx.fillRect(0, Y0, X0, Y1 - Y0);
    ctx.fillRect(X1, Y0, canvas.width - X1, Y1 - Y0);
    return canvas;
  }

  function solve3(M, b) {
    const a = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c; for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
      if (Math.abs(a[p][c]) < 1e-9) return null;
      [a[c], a[p]] = [a[p], a[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const k = a[r][c] / a[c][c]; for (let j = c; j < 4; j++) a[r][j] -= k * a[c][j]; }
    }
    return [a[0][3] / a[0][0], a[1][3] / a[1][1], a[2][3] / a[2][2]];
  }

  function orderQuad(q) {
    const qx = q.reduce((s, p) => s + p[0], 0) / 4, qy = q.reduce((s, p) => s + p[1], 0) / 4;
    q = q.slice().sort((p, r) => Math.atan2(p[1] - qy, p[0] - qx) - Math.atan2(r[1] - qy, r[0] - qx));
    let tl = 0; for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[tl][0] + q[tl][1]) tl = i;
    return [0, 1, 2, 3].map((i) => q[(tl + i) % 4]);
  }

  function isConvexQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const s = Math.sign(cr);
      if (!s || (sign && s !== sign)) return false;
      sign = s;
    }
    return true;
  }

  // Dự phòng: vùng sáng lớn nhất (Otsu)
  function otsuMask(g, w, h) {
    const n = w * h;

    // Otsu
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[Math.min(255, g[i] | 0)]++;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = n - wB; if (!wF) break;
      sB += t * hist[t];
      const mB = sB / wB, mF = (sum - sB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = g[i] > thr ? 1 : 0;

    // thành phần sáng lớn nhất
    const lab = new Int32Array(n);
    const stack = new Int32Array(n);
    let bestLab = 0, bestSize = 0, cur = 0;
    for (let s = 0; s < n; s++) {
      if (!bin[s] || lab[s]) continue;
      cur++; let sp = 0, size = 0;
      stack[sp++] = s; lab[s] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w, y = (p / w) | 0;
        if (x > 0 && bin[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && bin[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && bin[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && bin[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLab = cur; }
    }
    if (bestSize < n * 0.12 || bestSize > n * 0.97) return null;
    const mask = new Uint8Array(n);
    for (let p = 0; p < n; p++) if (lab[p] === bestLab) mask[p] = 1;
    return mask;
  }

  function polyArea(q) { let s = 0; for (let i = 0; i < q.length; i++) { const p = q[i], r = q[(i + 1) % q.length]; s += p[0] * r[1] - r[0] * p[1]; } return s / 2; }
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    const win = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0; const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / win;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / win;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  // ---------- Nắn phẳng phối cảnh ----------
  // q: 4 góc theo pixel [TL,TR,BR,BL] trên canvas nguồn
  // size (tuỳ chọn): [W, H] ép kích thước đầu ra, ví dụ cho thẻ CCCD
  // maxOut: giới hạn cạnh dài (dùng số nhỏ để xem trước cho nhanh)
  function warp(canvas, q, size, maxOut = MAX_OUT) {
    const dist = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    if (size) [W, H] = size;
    const k = Math.min(1, maxOut / Math.max(W, H));
    W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k));

    // Heckbert: hình vuông đơn vị -> tứ giác
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    let a, b, c, d, e, f, g, hh;
    if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) {
      a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; hh = 0;
    } else {
      const det = dx1 * dy2 - dx2 * dy1;
      g = (dx3 * dy2 - dx2 * dy3) / det;
      hh = (dx1 * dy3 - dx3 * dy1) / det;
      a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0;
      d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0;
    }

    const sw = canvas.width, sh = canvas.height;
    // đọc điểm ảnh nguồn một lần rồi giữ lại (xem trước + lưu dùng chung)
    if (!canvas._px) canvas._px = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const sd = canvas._px;
    const out = makeCanvas(W, H);
    const octx = out.getContext('2d');
    const od = octx.createImageData(W, H);
    const o = od.data;
    // Tử số/mẫu số tuyến tính theo x -> chỉ cần cộng dồn mỗi điểm ảnh (nhanh hơn nhân lại từ đầu)
    const du = 1 / W, maxX = sw - 1.001, maxY = sh - 1.001, row = sw * 4;
    const adu = a * du, ddu = d * du, gdu = g * du;
    let i = 0;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H, u0 = 0.5 * du;
      let nx = a * u0 + b * v + c, ny = d * u0 + e * v + f, z = g * u0 + hh * v + 1;
      for (let x = 0; x < W; x++, i += 4, nx += adu, ny += ddu, z += gdu) {
        const iz = 1 / z;
        let sx = nx * iz - 0.5, sy = ny * iz - 0.5;
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy;
        const p = (iy * sw + ix) << 2, p2 = p + row;
        const gx = 1 - fx, gy = 1 - fy;
        const w00 = gx * gy, w10 = fx * gy, w01 = gx * fy, w11 = fx * fy;
        o[i] = sd[p] * w00 + sd[p + 4] * w10 + sd[p2] * w01 + sd[p2 + 4] * w11;
        o[i + 1] = sd[p + 1] * w00 + sd[p + 5] * w10 + sd[p2 + 1] * w01 + sd[p2 + 5] * w11;
        o[i + 2] = sd[p + 2] * w00 + sd[p + 6] * w10 + sd[p2 + 2] * w01 + sd[p2 + 6] * w11;
        o[i + 3] = 255;
      }
    }
    octx.putImageData(od, 0, 0);
    return out;
  }

  // ---------- Bộ lọc ----------
  // Ước lượng nền giấy (độ sáng) theo từng vùng để khử bóng tối / ánh sáng không đều
  function background(lum, w, h) {
    const B = Math.max(8, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
    let grid = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      // lấy phân vị cao (~ sáng nhất) trong ô, bỏ qua vài điểm nhiễu
      const hist = new Uint16Array(64); let cnt = 0;
      const xe = Math.min(w, (gx + 1) * B), ye = Math.min(h, (gy + 1) * B);
      for (let y = gy * B; y < ye; y += 2) for (let x = gx * B; x < xe; x += 2) { hist[lum[y * w + x] >> 2]++; cnt++; }
      let need = cnt * 0.08, v = 63;
      for (; v > 0; v--) { need -= hist[v]; if (need <= 0) break; }
      grid[gy * gw + gx] = v * 4 + 2;
    }
    // giãn rồi làm mờ lưới
    const dil = new Float32Array(grid.length);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      let m = 0;
      for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
        const yy = Math.min(gh - 1, Math.max(0, y + j)), xx = Math.min(gw - 1, Math.max(0, x + k));
        m = Math.max(m, grid[yy * gw + xx]);
      }
      dil[y * gw + x] = m;
    }
    grid = boxBlur(boxBlur(dil, gw, gh, 1), gw, gh, 1);
    return { grid, gw, gh, B };
  }

  function applyFilter(src, mode) {
    const w = src.width, h = src.height;
    const out = makeCanvas(w, h);
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0);
    if (mode === 'original') return out;
    const id = ctx.getImageData(0, 0, w, h), p = id.data, n = w * h;
    const lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) lum[i] = (77 * p[i * 4] + 150 * p[i * 4 + 1] + 29 * p[i * 4 + 2]) >> 8;

    if (mode === 'gray') {
      for (let i = 0; i < n; i++) { const v = lum[i]; p[i * 4] = p[i * 4 + 1] = p[i * 4 + 2] = v; }
    } else {
      // Nền giấy: chế độ Làm nét ước lượng RIÊNG từng kênh R, G, B -> giấy ám vàng/ám đèn vẫn về trắng trung tính
      let grids;
      if (mode === 'magic') {
        const ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
        for (let i = 0; i < n; i++) { ch[0][i] = p[i * 4]; ch[1][i] = p[i * 4 + 1]; ch[2][i] = p[i * 4 + 2]; }
        grids = ch.map((c) => background(c, w, h));
      } else grids = [background(lum, w, h)];
      // bảng tra đường cong tương phản: đẩy chữ đậm hơn, nền trắng tinh
      const curve = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        const t = i / 255;
        curve[i] = Math.round(255 * Math.min(1, Math.max(0, (Math.pow(t, 1.6) - 0.05) / 0.85)));
      }
      // bảng tra Đen trắng theo độ sáng đã chuẩn hoá (0..511)
      const bwLut = new Uint8Array(512);
      for (let v = 0; v < 512; v++) bwLut[v] = v > 205 ? 255 : v < 150 ? 0 : Math.round(((v - 150) / 55) * 255);
      // nội suy nền: tính trước chỉ số cột, mỗi hàng nội suy lưới theo y một lần
      const { gw, gh, B } = grids[0];
      const cI = new Int32Array(w), cF = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const gx = Math.min(gw - 1.001, Math.max(0, x / B - 0.5));
        cI[x] = gx | 0; cF[x] = gx - (gx | 0);
      }
      const rows = grids.map(() => new Float32Array(gw));
      const right = gw > 1 ? 1 : 0;
      const nG = grids.length;
      let i = 0;
      for (let y = 0; y < h; y++) {
        const gy = Math.min(gh - 1.001, Math.max(0, y / B - 0.5));
        const iy = gy | 0, fy = gy - iy, r0 = iy * gw, r1 = gh > 1 ? r0 + gw : r0;
        for (let c = 0; c < nG; c++) {
          const gr = grids[c].grid, row = rows[c];
          for (let k = 0; k < gw; k++) row[k] = gr[r0 + k] * (1 - fy) + gr[r1 + k] * fy;
        }
        for (let x = 0; x < w; x++, i++) {
          const ix = cI[x], fx = cF[x], gx = 1 - fx, q = i << 2;
          if (mode === 'bw') {
            let b = rows[0][ix] * gx + rows[0][ix + right] * fx; if (b < 40) b = 40;
            const v = lum[i] * 255 / b;
            p[q] = p[q + 1] = p[q + 2] = bwLut[v > 511 ? 511 : v | 0];
          } else { // magic
            let bR = rows[0][ix] * gx + rows[0][ix + right] * fx; if (bR < 40) bR = 40;
            let bG = rows[1][ix] * gx + rows[1][ix + right] * fx; if (bG < 40) bG = 40;
            let bB = rows[2][ix] * gx + rows[2][ix + right] * fx; if (bB < 40) bB = 40;
            let r = p[q] * 255 / bR, g2 = p[q + 1] * 255 / bG, b2 = p[q + 2] * 255 / bB;
            if (r > 255) r = 255; if (g2 > 255) g2 = 255; if (b2 > 255) b2 = 255;
            // khử ám màu: điểm ít màu (chữ đen ngả nâu, vệt vàng thấm từ mặt sau) -> xám trung tính;
            // điểm nhiều màu (dấu đỏ, mực xanh, bút dạ) giữ nguyên màu
            const L = 0.299 * r + 0.587 * g2 + 0.114 * b2;
            const mx = r > g2 ? (r > b2 ? r : b2) : (g2 > b2 ? g2 : b2);
            const mn = r < g2 ? (r < b2 ? r : b2) : (g2 < b2 ? g2 : b2);
            const chroma = mx - mn, lo = L > 200 ? 75 : 38;
            const keep = chroma <= lo ? 0 : chroma >= lo + 50 ? 1 : (chroma - lo) / 50;
            r = L + (r - L) * keep; g2 = L + (g2 - L) * keep; b2 = L + (b2 - L) * keep;
            p[q] = curve[r < 0 ? 0 : r | 0];
            p[q + 1] = curve[g2 < 0 ? 0 : g2 | 0];
            p[q + 2] = curve[b2 < 0 ? 0 : b2 | 0];
          }
        }
      }
    }
    if (mode === 'magic' || mode === 'gray') sharpen(p, w, h, mode === 'magic' ? 1.1 : 0.7);
    ctx.putImageData(id, 0, 0);
    return out;
  }

  // Làm sắc nét cạnh chữ (unsharp mask 3×3 trên độ sáng) — giống kiểu chữ "đanh" của app scan chuyên dụng.
  // Chỉ cần thêm 1 mảng độ sáng 8-bit, nhẹ bộ nhớ trên điện thoại.
  function sharpen(p, w, h, amount) {
    const n = w * h, L = new Uint8Array(n);
    for (let i = 0; i < n; i++) L[i] = (77 * p[i * 4] + 150 * p[i * 4 + 1] + 29 * p[i * 4 + 2]) >> 8;
    const k = amount / 9;
    for (let y = 1; y < h - 1; y++) {
      let i = y * w + 1;
      for (let x = 1; x < w - 1; x++, i++) {
        const a = i - w, b = i + w;
        const s = L[a - 1] + L[a] + L[a + 1] + L[i - 1] + L[i] + L[i + 1] + L[b - 1] + L[b] + L[b + 1];
        const d = (9 * L[i] - s) * k; // = amount * (L - trung bình 3×3)
        if (d > -2 && d < 2) continue; // vùng phẳng: giữ nguyên, tránh làm nổi nhiễu
        const q = i << 2;
        let r = p[q] + d, g = p[q + 1] + d, bl = p[q + 2] + d;
        p[q] = r < 0 ? 0 : r > 255 ? 255 : r;
        p[q + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        p[q + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
      }
    }
  }

  const toBlob = (canvas, q = 0.92) => (canvas.convertToBlob
    ? canvas.convertToBlob({ type: 'image/jpeg', quality: q })
    : new Promise((res) => canvas.toBlob(res, 'image/jpeg', q)));

  // Toàn bộ bước làm trang nét đầy đủ (dùng chung cho Worker và trang)
  // job: { src: Blob, rot, corners (0..1), size: [W,H]|null, filter, quality }
  async function processFull(job) {
    const base = await loadToCanvas(job.src);
    const c = rotate(base, job.rot || 0);
    const q = job.corners.map(([u, v]) => [u * c.width, v * c.height]);
    let flat = warp(c, q, job.size || null);
    if (job.flatten) flat = flatten(flat);
    let full = applyFilter(flat, job.filter);
    if (job.clean) full = cleanBorder(full);
    const out = await toBlob(full, job.quality);
    return { out, w: full.width, h: full.height };
  }

  return { makeCanvas, loadToCanvas, rotate, rotateCorners, detect, detectContent, detectAuto, edgeQuads, warp, flatten, cleanBorder, applyFilter, toBlob, processFull, FULL };
})();
