// Durable source contract for the newest imported DXF pattern. Pattern
// measurements remain session-only; this record carries only the factory DXF
// text and the import mapping needed to rebuild a fresh native session after
// Project Open, Project Library reopen, or autosave Restore (ADR 0088).
// Source part for app.js. Run `npm run build` after editing.

  const DXF_PATTERN_SOURCE_VERSION = 1;
  const DXF_AUTOSAVE_DB_NAME = 'bra-sketch-dxf-autosave';
  const DXF_AUTOSAVE_DB_VERSION = 1;
  const DXF_AUTOSAVE_STORE = 'sources';
  const DXF_AUTOSAVE_ACTIVE_KEY = 'active';
  let dxfAutosaveDbPromise = null;

  // Two independently-seeded FNV-1a passes plus the exact string length make
  // a compact deterministic content address without making import async.
  function dxfPatternFingerprint(text) {
    const value = String(text || '');
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      a ^= code;
      a = Math.imul(a, 0x01000193);
      b ^= code + i;
      b = Math.imul(b, 0x85ebca6b);
    }
    return 'fnv1a2-' + (a >>> 0).toString(16).padStart(8, '0')
      + (b >>> 0).toString(16).padStart(8, '0') + '-' + value.length;
  }

  function dxfPatternRound(value) {
    return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
  }

  function dxfPatternRelativePoint(point, origin) {
    if (!point || !origin) return null;
    return [dxfPatternRound(point.x - origin.x), dxfPatternRound(point.y - origin.y)];
  }

  // Translation-invariant by piece: moving an entire imported piece is safe,
  // while deleting, simplifying, or reshaping even one member changes this
  // payload and prevents a native session from attaching to stale geometry.
  function dxfPatternGeometryFingerprint(source) {
    if (!source || !Array.isArray(source.pieceAnnotationIds)) return null;
    const payload = [];
    for (let pieceIndex = 0; pieceIndex < source.pieceAnnotationIds.length; pieceIndex += 1) {
      const ids = source.pieceAnnotationIds[pieceIndex];
      const groupId = source.groupIds && source.groupIds[pieceIndex];
      if (!Array.isArray(ids) || !ids.length || !groupId) return null;
      const annotations = ids.map(id => state.annotations.find(ann => ann && ann.id === id));
      if (annotations.some(ann => !ann || ann.templateGroupId !== groupId || !ann.start)) return null;
      const origin = annotations[0].start;
      payload.push(annotations.map(ann => ({
        id: ann.id,
        type: ann.type,
        start: dxfPatternRelativePoint(ann.start, origin),
        end: dxfPatternRelativePoint(ann.end, origin),
        control1: dxfPatternRelativePoint(ann.control1, origin),
        control2: dxfPatternRelativePoint(ann.control2, origin),
      })));
    }
    return dxfPatternFingerprint(JSON.stringify(payload));
  }

  function dxfPatternSourceIsCompatible(source) {
    if (!source || source.version !== DXF_PATTERN_SOURCE_VERSION) return false;
    if (!source.fingerprint || !source.geometryFingerprint) return false;
    return dxfPatternGeometryFingerprint(source) === source.geometryFingerprint;
  }

  function makeDxfPatternSource(text, fileName, bounds, transform, pieceFirstAnnotationIds, pieceAnnotationIds, groupIds, importOptions) {
    const source = {
      version: DXF_PATTERN_SOURCE_VERSION,
      fileName: String(fileName || 'Imported DXF'),
      fingerprint: dxfPatternFingerprint(text),
      text: String(text || ''),
      bounds: clone(bounds),
      transform: clone(transform),
      pieceFirstAnnotationIds: (pieceFirstAnnotationIds || []).slice(),
      pieceAnnotationIds: (pieceAnnotationIds || []).map(ids => ids.slice()),
      groupIds: (groupIds || []).slice(),
      // Phase 3 (ADR 0091): additive. The native rebuild must drop the same
      // quality-curve twins the board import did; absent (older source) means
      // the default, drop.
      importOptions: {
        keepQualityCurves: !!(importOptions && importOptions.keepQualityCurves),
        // Phase 4: the placement instances the TD deselected in the
        // pre-placement picker; the native rebuild must skip the same ones.
        excludeInstances: (importOptions && Array.isArray(importOptions.excludeInstances)) ? importOptions.excludeInstances.slice() : [],
      },
      // Phase 6 (ADR 0091): which grouping built this board. Additive —
      // sources saved before the field existed have none and mean 1.
      pipelineVersion: (importOptions && importOptions.pipelineVersion === 1) ? 1 : DXF_PIPELINE_VERSION,
      geometryFingerprint: null,
    };
    source.geometryFingerprint = dxfPatternGeometryFingerprint(source);
    return source;
  }

  function setDxfPatternSource(source) {
    state.dxfPatternSource = source || null;
    if (source && source.text) {
      persistDxfPatternSourceForAutosave(source).catch(err => {
        console.warn('[dxf-source] Could not persist autosave source:', err);
      });
    }
  }

  function clearDxfPatternSource(options) {
    state.dxfPatternSource = null;
    resetDxfMeasureSession();
    if (!options || options.clearStored !== false) {
      deleteDxfPatternAutosaveSource().catch(() => {});
    }
  }

  function invalidateDxfPatternSource(reason, announce) {
    const hadSource = !!state.dxfPatternSource || !!state.dxfMeasureSession;
    clearDxfPatternSource();
    if (announce !== false && hadSource) {
      showToast(reason || 'Pattern Measure cleared because the imported DXF geometry changed. Reopen the DXF to measure again.');
    }
  }

  function serializeDxfPatternSourceForProject(mode) {
    const source = state.dxfPatternSource;
    if (!source) return null;
    if (!source.text || dxfPatternFingerprint(source.text) !== source.fingerprint
        || !dxfPatternSourceIsCompatible(source)) {
      invalidateDxfPatternSource('Pattern Measure source no longer matches the board. Reopen the DXF to measure again.', false);
      return null;
    }
    const serialized = clone(source);
    if (mode === 'reference') {
      serialized.text = null;
      serialized.storage = 'indexeddb';
    } else {
      delete serialized.storage;
    }
    return serialized;
  }

  function openDxfAutosaveDB() {
    if (dxfAutosaveDbPromise) return dxfAutosaveDbPromise;
    dxfAutosaveDbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this browser.'));
        return;
      }
      const req = indexedDB.open(DXF_AUTOSAVE_DB_NAME, DXF_AUTOSAVE_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DXF_AUTOSAVE_STORE)) {
          db.createObjectStore(DXF_AUTOSAVE_STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Could not open DXF autosave storage.'));
      req.onblocked = () => reject(new Error('DXF autosave storage is blocked by another tab.'));
    });
    return dxfAutosaveDbPromise;
  }

  async function persistDxfPatternSourceForAutosave(source) {
    if (!source || !source.text || dxfPatternFingerprint(source.text) !== source.fingerprint) return false;
    const db = await openDxfAutosaveDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DXF_AUTOSAVE_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not store DXF autosave source.'));
      tx.objectStore(DXF_AUTOSAVE_STORE).put({
        id: DXF_AUTOSAVE_ACTIVE_KEY,
        fingerprint: source.fingerprint,
        text: source.text,
        savedAt: Date.now(),
      });
    });
    return true;
  }

  async function readDxfPatternAutosaveSource(fingerprint) {
    const db = await openDxfAutosaveDB();
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(DXF_AUTOSAVE_STORE, 'readonly');
      const req = tx.objectStore(DXF_AUTOSAVE_STORE).get(DXF_AUTOSAVE_ACTIVE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Could not read DXF autosave source.'));
    });
    if (!record || record.fingerprint !== fingerprint
        || dxfPatternFingerprint(record.text) !== fingerprint) return null;
    return record.text;
  }

  async function deleteDxfPatternAutosaveSource() {
    if (typeof indexedDB === 'undefined') return;
    const db = await openDxfAutosaveDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DXF_AUTOSAVE_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not clear DXF autosave source.'));
      tx.objectStore(DXF_AUTOSAVE_STORE).delete(DXF_AUTOSAVE_ACTIVE_KEY);
    });
  }

  function rebuildDxfMeasureSessionFromActiveSource() {
    const source = state.dxfPatternSource;
    if (!source || !source.text || dxfPatternFingerprint(source.text) !== source.fingerprint
        || !dxfPatternSourceIsCompatible(source)) return false;
    resetDxfMeasureSession();
    // Phase 6: the rebuild parses with the SOURCE's own pipeline version (a
    // pre-ADR-0091 project carries none → 1), so the native pieces pair with
    // the saved board pieces by index instead of silently nulling every
    // pieceAnchor.
    return !!startDxfMeasureSession(
      source.text,
      source.bounds,
      source.transform,
      source.pieceFirstAnnotationIds,
      Object.assign({}, source.importOptions || {}, { pipelineVersion: source.pipelineVersion === 2 ? 2 : 1 })
    );
  }

  async function restoreDxfPatternSource(savedSource) {
    state.dxfPatternSource = null;
    resetDxfMeasureSession();
    if (!savedSource) return { ok: false, reason: 'absent' };
    const source = clone(savedSource);
    let text = typeof source.text === 'string' && source.text ? source.text : null;
    if (!text && source.storage === 'indexeddb' && source.fingerprint) {
      try { text = await readDxfPatternAutosaveSource(source.fingerprint); }
      catch (err) { console.warn('[dxf-source] Could not read autosave source:', err); }
    }
    if (!text) {
      showToast('Pattern geometry restored, but its DXF source is missing. Reopen the DXF to measure again.', 5200);
      return { ok: false, reason: 'missing-source' };
    }
    if (dxfPatternFingerprint(text) !== source.fingerprint) {
      showToast('Pattern geometry restored, but its DXF source does not match. Reopen the DXF to measure again.', 5200);
      return { ok: false, reason: 'fingerprint-mismatch' };
    }
    source.text = text;
    delete source.storage;
    if (!dxfPatternSourceIsCompatible(source)) {
      showToast('Pattern geometry restored, but it no longer matches the saved DXF source. Reopen the DXF to measure again.', 5200);
      return { ok: false, reason: 'geometry-mismatch' };
    }
    state.dxfPatternSource = source;
    if (!rebuildDxfMeasureSessionFromActiveSource()) {
      state.dxfPatternSource = null;
      return { ok: false, reason: 'native-rebuild-failed' };
    }
    persistDxfPatternSourceForAutosave(source).catch(err => {
      console.warn('[dxf-source] Could not refresh autosave source:', err);
    });
    return { ok: true };
  }
