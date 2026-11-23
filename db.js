// Lưu các trang trong IndexedDB để không mất khi đóng app.
const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('scan-doc', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('pages', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('pages', mode);
      const store = t.objectStore('pages');
      const r = fn(store);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    all: async () => (await tx('readonly', (s) => s.getAll())).sort((a, b) => a.order - b.order),
    put: (page) => tx('readwrite', (s) => s.put(page)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
    clear: () => tx('readwrite', (s) => s.clear()),
  };
})();
