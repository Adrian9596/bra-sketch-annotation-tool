// Per-tool library of saved project snapshots.
// Source part for app.js. Run `npm run build` after editing.
//
// Every call to writeProjectFile() appends an entry here (in addition to the
// .json file the browser downloads), so the TD can review and reopen past
// styles inside the tool itself. The append-only design keeps a per-style
// edit history; future learning passes can iterate the raw entries via
// window.__braProjectLibrary as input data.
//
// Storage: IndexedDB
//   db    = 'bra-sketch-project-library'
//   store = 'entries' (keyPath 'id')
//   indexes: 'styleId', 'savedAt'
// Entry shape:
//   { id, styleId, savedAt, annotationCount, imageCount,
//     confirmedPomCount, thumbnailDataURL, snapshot }
// listLibraryEntries returns the same shape with `snapshot` stripped so the
// dialog can render hundreds of rows without pulling every image dataURL.

  const PROJECT_LIBRARY_DB_NAME = 'bra-sketch-project-library';
  const PROJECT_LIBRARY_DB_VERSION = 1;
  const PROJECT_LIBRARY_STORE = 'entries';
  const PROJECT_LIBRARY_THUMBNAIL_SIZE = 240;

  let projectLibraryDbPromise = null;

  function openProjectLibraryDB() {
    if (projectLibraryDbPromise) return projectLibraryDbPromise;
    projectLibraryDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      let req;
      try {
        req = indexedDB.open(PROJECT_LIBRARY_DB_NAME, PROJECT_LIBRARY_DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(PROJECT_LIBRARY_STORE)) {
          const store = db.createObjectStore(PROJECT_LIBRARY_STORE, { keyPath: 'id' });
          store.createIndex('styleId', 'styleId', { unique: false });
          store.createIndex('savedAt', 'savedAt', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open project library DB.'));
      req.onblocked = () => reject(new Error('Library DB upgrade blocked by another tab.'));
    });
    return projectLibraryDbPromise;
  }

  function makeLibraryEntryId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return 'lib-' + crypto.randomUUID();
    }
    return 'lib-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function summarizeProjectSnapshot(snapshot) {
    const annotations = (snapshot && snapshot.state && Array.isArray(snapshot.state.annotations))
      ? snapshot.state.annotations : [];
    const images = (snapshot && snapshot.state && Array.isArray(snapshot.state.images))
      ? snapshot.state.images : [];
    let confirmedPomCount = 0;
    annotations.forEach(ann => {
      if (!ann) return;
      const hasPom = ann.pomNumber != null && ann.pomNumber !== '';
      const confirmed = ann.tdApproved === true || ann.tdEdited === true;
      if (hasPom && confirmed) confirmedPomCount += 1;
    });
    return {
      annotationCount: annotations.length,
      imageCount: images.length,
      confirmedPomCount,
    };
  }

  async function buildLibraryThumbnail(firstImage, maxSize) {
    if (!firstImage || !firstImage.dataURL) return '';
    const size = Math.max(40, maxSize | 0 || PROJECT_LIBRARY_THUMBNAIL_SIZE);
    try {
      const image = await loadImageFromDataURL(firstImage.dataURL);
      const w = image.naturalWidth || image.width || 1;
      const h = image.naturalHeight || image.height || 1;
      const ratio = Math.min(size / w, size / h, 1);
      const tw = Math.max(1, Math.round(w * ratio));
      const th = Math.max(1, Math.round(h * ratio));
      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(image, 0, 0, tw, th);
      return canvas.toDataURL('image/jpeg', 0.78);
    } catch (err) {
      return '';
    }
  }

  async function addLibraryEntry({ styleId, snapshot }) {
    if (!snapshot) throw new Error('addLibraryEntry: snapshot is required.');
    const summary = summarizeProjectSnapshot(snapshot);
    const firstImage = (snapshot.state && Array.isArray(snapshot.state.images))
      ? snapshot.state.images[0]
      : null;
    const thumbnailDataURL = await buildLibraryThumbnail(firstImage, PROJECT_LIBRARY_THUMBNAIL_SIZE);
    const entry = {
      id: makeLibraryEntryId(),
      styleId: typeof styleId === 'string' ? styleId.trim() : '',
      savedAt: (snapshot && snapshot.savedAt) || new Date().toISOString(),
      annotationCount: summary.annotationCount,
      imageCount: summary.imageCount,
      confirmedPomCount: summary.confirmedPomCount,
      thumbnailDataURL,
      snapshot,
    };
    const db = await openProjectLibraryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_LIBRARY_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(PROJECT_LIBRARY_STORE).put(entry);
    });
    return entry;
  }

  function libraryEntryWithoutSnapshot(entry) {
    return {
      id: entry.id,
      styleId: entry.styleId || '',
      savedAt: entry.savedAt || '',
      annotationCount: entry.annotationCount || 0,
      imageCount: entry.imageCount || 0,
      confirmedPomCount: entry.confirmedPomCount || 0,
      thumbnailDataURL: entry.thumbnailDataURL || '',
    };
  }

  async function listLibraryEntries(filter) {
    const styleFilter = filter && typeof filter.styleId === 'string' ? filter.styleId.trim() : '';
    const db = await openProjectLibraryDB();
    const all = await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_LIBRARY_STORE, 'readonly');
      const req = tx.objectStore(PROJECT_LIBRARY_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const trimmed = all.map(libraryEntryWithoutSnapshot);
    const filtered = styleFilter
      ? trimmed.filter(e => e.styleId === styleFilter)
      : trimmed;
    filtered.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    return filtered;
  }

  async function getLibraryEntry(id) {
    if (!id) return null;
    const db = await openProjectLibraryDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_LIBRARY_STORE, 'readonly');
      const req = tx.objectStore(PROJECT_LIBRARY_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteLibraryEntry(id) {
    if (!id) return;
    const db = await openProjectLibraryDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_LIBRARY_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(PROJECT_LIBRARY_STORE).delete(id);
    });
  }

  async function countLibraryEntries() {
    const db = await openProjectLibraryDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PROJECT_LIBRARY_STORE, 'readonly');
      const req = tx.objectStore(PROJECT_LIBRARY_STORE).count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  if (typeof window !== 'undefined') {
    window.__braProjectLibrary = {
      list: listLibraryEntries,
      get: getLibraryEntry,
      delete: deleteLibraryEntry,
      add: addLibraryEntry,
      count: countLibraryEntries,
    };
  }
