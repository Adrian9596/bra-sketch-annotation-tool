// Crash-safe autosave to localStorage plus a beforeunload reload guard.
// Source part for app.js. Run `npm run build` after editing.
//
// scheduleAutosave() is debounced from pushHistoryIfChanged() so every
// edit reaches durable storage within a second. writeAutosave() first
// tries the full project snapshot (annotations + images); if that trips
// the localStorage quota it retries without image data URLs so at least
// the geometry survives. The beforeunload handler pops the browser's
// native "Leave site?" dialog whenever the board has work on it — this
// is what stops an accidental reload from wiping the whole session even
// on a page that has locked up mid-detect.

  const AUTOSAVE_KEY = 'bra-sketch-autosave-v1';
  const AUTOSAVE_DEBOUNCE_MS = 800;
  const AUTOSAVE_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  let autosaveTimer = null;
  let autosaveArmed = false;
  let autosaveSuspended = false;

  function armAutosave() {
    autosaveArmed = true;
    installBeforeUnloadGuard();
  }

  function suspendAutosave() { autosaveSuspended = true; }
  function resumeAutosave() { autosaveSuspended = false; }

  function scheduleAutosave() {
    if (!autosaveArmed || autosaveSuspended) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      // requestIdleCallback where available so the JSON.stringify +
      // setItem work (which can be a few hundred milliseconds when
      // an image is pasted in) does not stall a live paint or drag.
      const runWrite = () => writeAutosave();
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(runWrite, { timeout: 1500 });
      } else {
        runWrite();
      }
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function flushAutosave() {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
    // Synchronous write on flush — this path runs from beforeunload,
    // where the browser is already about to teardown the page and we
    // cannot yield to an idle callback.
    if (autosaveArmed && !autosaveSuspended) writeAutosave();
  }

  // Anything worth warning about before close: real annotations, images
  // added to the board, or unapplied Auto Mode drafts. Empty boards
  // don't trigger the dialog because there is nothing to lose.
  function hasUnsavedWork() {
    if (!state) return false;
    if (state.annotations && state.annotations.length > 0) return true;
    if (state.images && state.images.length > 0) return true;
    // US-092: a board holding only text notes is still work worth saving.
    if (state.notes && state.notes.length > 0) return true;
    if (typeof hasMeaningfulConstructionWork === 'function' && hasMeaningfulConstructionWork()) return true;
    if (typeof hasMeaningfulBomWork === 'function' && hasMeaningfulBomWork()) return true;
    if (state.autoMode && state.autoMode.draftAnnotations && state.autoMode.draftAnnotations.length > 0) return true;
    return false;
  }

  function writeAutosave() {
    if (typeof localStorage === 'undefined') return;
    if (!hasUnsavedWork()) {
      // Empty board — remove any leftover autosave so a stale one does
      // not resurface after the user clears the workspace intentionally.
      clearAutosave();
      return;
    }
    const snapshot = buildProjectSnapshot();
    const record = {
      savedAt: Date.now(),
      appVersion: (typeof AUTO_TEMPLATE_VERSION !== 'undefined') ? AUTO_TEMPLATE_VERSION : null,
      snapshot,
    };
    // First attempt: full snapshot including image data URLs.
    if (tryWriteAutosave(record)) return;
    // Second attempt: strip image bitmap data so a large paste doesn't
    // starve the quota. Annotation geometry survives; the user has to
    // re-add the reference image, but the actual work is intact.
    if (record.snapshot && record.snapshot.state && Array.isArray(record.snapshot.state.images)) {
      record.imagesStripped = true;
      record.snapshot.state.images = record.snapshot.state.images.map((img) => ({
        ...img, dataURL: null,
      }));
      const bom = record.snapshot.state.bom;
      if (bom && bom.images) {
        record.bomImagesStripped = true;
        ['solid', 'lace'].forEach(variant => {
          bom.images[variant] = (bom.images[variant] || []).map(image => ({ ...image, dataURL: null }));
        });
      }
      const construction = record.snapshot.state.construction;
      if (construction && construction.images) {
        record.constructionImagesStripped = true;
        ['solid', 'lace'].forEach(sheet => {
          ['outer', 'inner'].forEach(view => {
            if (!construction.images[sheet]) return;
            construction.images[sheet][view] = (construction.images[sheet][view] || [])
              .map(image => ({ ...image, dataURL: null }));
          });
        });
      }
    }
    if (tryWriteAutosave(record)) return;
    console.warn('[autosave] Could not persist even the annotation-only snapshot; localStorage is full.');
  }

  function tryWriteAutosave(record) {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(record));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readAutosave() {
    if (typeof localStorage === 'undefined') return null;
    let raw;
    try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (_) { return null; }
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) {
      // Corrupt entry — clear it so we do not offer it again.
      clearAutosave();
      return null;
    }
    if (!parsed || !parsed.snapshot || typeof parsed.snapshot !== 'object') {
      clearAutosave();
      return null;
    }
    if (Number.isFinite(parsed.savedAt) && Date.now() - parsed.savedAt > AUTOSAVE_STALE_AGE_MS) {
      clearAutosave();
      return null;
    }
    return parsed;
  }

  function clearAutosave() {
    if (typeof localStorage === 'undefined') return;
    try { localStorage.removeItem(AUTOSAVE_KEY); } catch (_) { /* ignore */ }
  }

  // beforeunload guard. Setting event.returnValue to any string triggers
  // Chrome/Safari/Firefox's built-in "Reload site?" prompt. We only wire
  // it up when there is actually work on the board, and the message is
  // ignored by modern browsers anyway (they show a generic warning) —
  // what matters is that the confirm dialog appears at all.
  let beforeUnloadGuardInstalled = false;
  function installBeforeUnloadGuard() {
    if (beforeUnloadGuardInstalled || typeof window === 'undefined') return;
    beforeUnloadGuardInstalled = true;
    window.addEventListener('beforeunload', (event) => {
      // Flush any pending autosave so the very latest edit persists even
      // when the user forces a reload after a UI freeze.
      try { flushAutosave(); } catch (_) { /* best effort */ }
      if (!hasUnsavedWork()) return;
      event.preventDefault();
      event.returnValue = '';
      return '';
    });
  }
