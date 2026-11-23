// Luồng nền xử lý ảnh, để giao diện không bị đứng:
//  - job thường: làm trang nét đầy đủ khi bấm Lưu
//  - job 'preview': làm ảnh xem trước ở bước chọn chế độ (làm phẳng + làm nét + tẩy nền)
importScripts('scan.js');

self.onmessage = async (e) => {
  const { id, job } = e.data;
  try {
    if (job.type === 'preview') {
      const c = new OffscreenCanvas(job.bmp.width, job.bmp.height);
      c.getContext('2d').drawImage(job.bmp, 0, 0);
      job.bmp.close();
      let src = c;
      if (job.flatten) src = Scan.flatten(src);
      const out = Scan.applyFilter(src, job.filter);
      if (job.clean) Scan.cleanBorder(out);
      const bmp = out.transferToImageBitmap();
      self.postMessage({ id, bmp }, [bmp]);
      return;
    }
    const r = await Scan.processFull(job);
    self.postMessage({ id, ...r });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
