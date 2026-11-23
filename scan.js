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
  function detect(canvas) {
    const S = 320;
    const k = Math.min(1, S / Math.max(canvas.width, canvas.height));
    const w = Math.max(8, Math.round(canvas.width * k));
    const h = Math.max(8, Math.round(canvas.height * k));
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const n = w * h;
    let g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    g = boxBlur(boxBlur(g, w, h, 2), w, h, 2);

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

    const pts = [];
    let cx = 0, cy = 0;
    for (let p = 0; p < n; p++) if (lab[p] === bestLab) {
      const x = p % w, y = (p / w) | 0;
      // chỉ lấy điểm biên để nhanh
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          lab[p - 1] !== bestLab || lab[p + 1] !== bestLab || lab[p - w] !== bestLab || lab[p + w] !== bestLab) {
        pts.push([x, y]); cx += x; cy += y;
      }
    }
    if (pts.length < 8) return null;
    cx /= pts.length; cy /= pts.length;
    const far = (from) => { let b = null, bd = -1; for (const p of pts) { const dd = (p[0] - from[0]) ** 2 + (p[1] - from[1]) ** 2; if (dd > bd) { bd = dd; b = p; } } return b; };
    const a = far([cx, cy]);
    const b = far(a);
    let c1 = null, c2 = null, m1 = 0, m2 = 0;
    for (const p of pts) {
      const cr = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (cr > m1) { m1 = cr; c1 = p; }
      if (cr < m2) { m2 = cr; c2 = p; }
    }
    if (!c1 || !c2) return null;
    let quad = [a, c1, b, c2];
    // sắp theo góc quanh tâm (chiều kim đồng hồ trên màn hình) rồi xoay để TL đứng đầu
    const qx = quad.reduce((s, p) => s + p[0], 0) / 4, qy = quad.reduce((s, p) => s + p[1], 0) / 4;
    quad.sort((p, q) => Math.atan2(p[1] - qy, p[0] - qx) - Math.atan2(q[1] - qy, q[0] - qx));
    let tl = 0; for (let i = 1; i < 4; i++) if (quad[i][0] + quad[i][1] < quad[tl][0] + quad[tl][1]) tl = i;
    quad = [0, 1, 2, 3].map((i) => quad[(tl + i) % 4]);
    // diện tích tứ giác phải đủ lớn
    const area = Math.abs(polyArea(quad));
    if (area < n * 0.1) return null;
    return quad.map(([x, y]) => [clamp01((x + 0.5) / w), clamp01((y + 0.5) / h)]);
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
      const bg = background(lum, w, h);
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
      const { grid, gw, gh, B } = bg;
      const cI = new Int32Array(w), cF = new Float32Array(w);
      for (let x = 0; x < w; x++) {
        const gx = Math.min(gw - 1.001, Math.max(0, x / B - 0.5));
        cI[x] = gx | 0; cF[x] = gx - (gx | 0);
      }
      const rowBg = new Float32Array(gw);
      const right = gw > 1 ? 1 : 0;
      let i = 0;
      for (let y = 0; y < h; y++) {
        const gy = Math.min(gh - 1.001, Math.max(0, y / B - 0.5));
        const iy = gy | 0, fy = gy - iy, r0 = iy * gw, r1 = gh > 1 ? r0 + gw : r0;
        for (let k = 0; k < gw; k++) rowBg[k] = grid[r0 + k] * (1 - fy) + grid[r1 + k] * fy;
        for (let x = 0; x < w; x++, i++) {
          const ix = cI[x], fx = cF[x];
          let b = rowBg[ix] * (1 - fx) + rowBg[ix + right] * fx;
          if (b < 40) b = 40;
          const s = 255 / b;
          const q = i << 2;
          if (mode === 'bw') {
            const v = lum[i] * s;
            p[q] = p[q + 1] = p[q + 2] = bwLut[v > 511 ? 511 : v | 0];
          } else { // magic
            let r = p[q] * s, g2 = p[q + 1] * s, b2 = p[q + 2] * s;
            p[q] = curve[r > 255 ? 255 : r | 0];
            p[q + 1] = curve[g2 > 255 ? 255 : g2 | 0];
            p[q + 2] = curve[b2 > 255 ? 255 : b2 | 0];
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
    const full = applyFilter(warp(c, q, job.size || null), job.filter);
    const out = await toBlob(full, job.quality);
    return { out, w: full.width, h: full.height };
  }

  return { makeCanvas, loadToCanvas, rotate, rotateCorners, detect, warp, applyFilter, toBlob, processFull, FULL };
})();
