// Làm trang nét đầy đủ ở luồng nền, để giao diện không bị đứng khi bấm Lưu.
importScripts('scan.js');

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    const r = await Scan.processFull(job);
    self.postMessage({ id, ...r });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
