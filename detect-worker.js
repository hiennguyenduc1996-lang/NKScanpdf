// Dò khung tài liệu ở luồng nền cho camera trực tiếp -> giao diện không bao giờ bị đứng.
importScripts('scan.js');

self.onmessage = (e) => {
  const { id, bmp, mode, allowPaper } = e.data;
  let q = null;
  try {
    // theo chữ: chỉ dùng kết quả theo chữ (không nhảy sang mép giấy), trừ khi đã lâu không thấy gì
    q = mode === 'text' ? Scan.detectContent(bmp, 480) : Scan.detect(bmp, 256);
    if (!q && mode === 'text' && allowPaper) q = Scan.detect(bmp, 256);
  } catch (err) { q = null; }
  try { bmp.close(); } catch (err) { /* bỏ qua */ }
  self.postMessage({ id, q });
};
