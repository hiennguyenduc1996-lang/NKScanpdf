// Dò khung tài liệu ở luồng nền cho camera trực tiếp -> giao diện không bao giờ bị đứng.
// Dùng CÙNG hàm nhận diện với bước cắt sau khi chụp (Scan.detectAuto) -> khung trên camera = khung cắt.
importScripts('scan.js');

self.onmessage = (e) => {
  const { id, bmp, mode } = e.data;
  let q = null;
  try { q = Scan.detectAuto(bmp, mode, true); } catch (err) { q = null; }
  try { bmp.close(); } catch (err) { /* bỏ qua */ }
  self.postMessage({ id, q });
};
