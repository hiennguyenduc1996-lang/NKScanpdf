// Tạo file PDF từ các ảnh JPEG (không cần thư viện ngoài, chạy offline).
const PDF = (() => {
  const A4 = [595.28, 841.89];
  const MM = 72 / 25.4;
  const CARD = [85.6 * MM, 53.98 * MM]; // thẻ chuẩn ID-1 (CCCD, thẻ ngân hàng)

  // imgs: [{ bytes: Uint8Array (JPEG), w, h, card: bool }]; size: 'a4' | 'fit'
  // Trả về danh sách trang PDF: { pw, ph, items: [{ img, x, y, w, h }] } (toạ độ PDF, gốc dưới-trái)
  function layout(imgs, size) {
    const sheets = [];
    if (size === 'fit') {
      for (const img of imgs) {
        const k = A4[1] / Math.max(img.w, img.h);
        sheets.push({ pw: img.w * k, ph: img.h * k, items: [{ img, x: 0, y: 0, w: img.w * k, h: img.h * k }] });
      }
      return sheets;
    }
    for (let i = 0; i < imgs.length; i++) {
      const img = imgs[i];
      if (img.card) {
        // gom 2 thẻ liên tiếp (mặt trước trái + mặt sau phải) trên 1 hàng của trang A4, đúng kích thước thật
        const group = [img];
        if (imgs[i + 1] && imgs[i + 1].card) group.push(imgs[++i]);
        const [pw, ph] = A4;
        const gap = 10 * MM;
        const dims = group.map((g) => (g.w >= g.h ? CARD : [CARD[1], CARD[0]]));
        const rowW = dims.reduce((s, [w]) => s + w, 0) + gap * (group.length - 1);
        const rowH = Math.max(...dims.map(([, h]) => h));
        const top = ph - 30 * MM;
        let x = (pw - rowW) / 2;
        const items = group.map((g, k) => {
          const [w, h] = dims[k];
          const it = { img: g, x, y: top - rowH + (rowH - h) / 2, w, h };
          x += w + gap;
          return it;
        });
        sheets.push({ pw, ph, items });
      } else {
        const [pw, ph] = img.w > img.h ? [A4[1], A4[0]] : A4;
        const k = Math.min(pw / img.w, ph / img.h);
        const w = img.w * k, h = img.h * k;
        sheets.push({ pw, ph, items: [{ img, x: (pw - w) / 2, y: (ph - h) / 2, w, h }] });
      }
    }
    return sheets;
  }

  function build(imgs, size = 'a4', title = 'Scan') {
    const sheets = layout(imgs, size);
    const enc = new TextEncoder();
    const chunks = [];
    const offsets = [];
    let pos = 0;
    const push = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; chunks.push(b); pos += b.length; };
    const obj = (id, body) => { offsets[id] = pos; push(`${id} 0 obj\n`); body(); push('\nendobj\n'); };
    const f = (v) => v.toFixed(2);

    // cấp số đối tượng: 1 catalog, 2 pages, 3 info, sau đó mỗi trang: page, content, rồi các ảnh
    let next = 4;
    const plan = sheets.map((s) => ({ s, pid: next++, cid: next++, iids: s.items.map(() => next++) }));
    const total = next;

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
    obj(1, () => push('<< /Type /Catalog /Pages 2 0 R >>'));
    obj(2, () => push(`<< /Type /Pages /Count ${plan.length} /Kids [${plan.map((p) => `${p.pid} 0 R`).join(' ')}] >>`));
    obj(3, () => push(`<< /Title (${pdfText(title)}) /Producer (NKScanpdf) >>`));

    for (const { s, pid, cid, iids } of plan) {
      const xo = iids.map((id, k) => `/Im${k} ${id} 0 R`).join(' ');
      obj(pid, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(s.pw)} ${f(s.ph)}] ` +
        `/Resources << /XObject << ${xo} >> /ProcSet [/PDF /ImageC] >> /Contents ${cid} 0 R >>`));
      const content = s.items.map((it, k) => `q ${f(it.w)} 0 0 ${f(it.h)} ${f(it.x)} ${f(it.y)} cm /Im${k} Do Q`).join('\n');
      obj(cid, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
      s.items.forEach((it, k) => obj(iids[k], () => {
        const g = it.img;
        push(`<< /Type /XObject /Subtype /Image /Width ${g.w} /Height ${g.h} /ColorSpace /DeviceRGB ` +
          `/BitsPerComponent 8 /Filter /DCTDecode /Length ${g.bytes.length} >>\nstream\n`);
        push(g.bytes);
        push('\nendstream');
      }));
    }

    const xref = pos;
    let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
    for (let id = 1; id < total; id++) x += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    push(x);
    push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return { blob: new Blob(chunks, { type: 'application/pdf' }), sheets: plan.length };
  }

  // Tiêu đề PDF dạng UTF-16BE để giữ tiếng Việt
  function pdfText(s) {
    let out = '\xFE\xFF';
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c > 0xFFFF) continue;
      out += String.fromCharCode(c >> 8, c & 255);
    }
    return out.replace(/[\\()]/g, (m) => '\\' + m).replace(/[\x80-\xFF]/g, (m) => '\\' + m.charCodeAt(0).toString(8).padStart(3, '0'))
      .replace(/[\x00-\x1F]/g, (m) => '\\' + m.charCodeAt(0).toString(8).padStart(3, '0'));
  }

  return { build };
})();
