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

  function describeAutosaveRecord(record) {
    if (!record || !record.snapshot || !record.snapshot.state) return '';
    const s = record.snapshot.state;
    const anns = Array.isArray(s.annotations) ? s.annotations.length : 0;
    const imgs = Array.isArray(s.images) ? s.images.length : 0;
    const ageMs = Number.isFinite(record.savedAt) ? Date.now() - record.savedAt : null;
    let when = '';
    if (ageMs != null) {
      if (ageMs < 60_000) when = 'a moment ago';
      else if (ageMs < 60 * 60_000) when = Math.round(ageMs / 60_000) + ' min ago';
      else if (ageMs < 24 * 60 * 60_000) when = Math.round(ageMs / (60 * 60_000)) + ' hr ago';
      else when = Math.round(ageMs / (24 * 60 * 60_000)) + ' day(s) ago';
    }
    const parts = [];
    if (anns) parts.push(anns + ' line' + (anns === 1 ? '' : 's'));
    if (imgs) parts.push(imgs + ' image' + (imgs === 1 ? '' : 's'));
    if (record.imagesStripped) parts.push('image bitmap dropped to fit storage');
    return (parts.join(', ') || 'work in progress') + (when ? ' • saved ' + when : '');
  }

  // Non-blocking restore prompt: appears as a floating banner over the
  // board. Kept independent of the toast queue so it can stick around
  // until the TD makes a choice (autosave restore is not a transient
  // notification — losing it silently would defeat the point).
  function maybeOfferAutosaveRestore() {
    if (typeof document === 'undefined') return;
    if (hasUnsavedWork()) return; // The URL / demo loader already put work on the board — do not clobber.
    const record = readAutosave();
    if (!record) return;
    const s = record.snapshot && record.snapshot.state;
    const hasContent = s && ((Array.isArray(s.annotations) && s.annotations.length)
      || (Array.isArray(s.images) && s.images.length));
    if (!hasContent) { clearAutosave(); return; }
    showAutosaveRestoreBanner(record);
  }

  function showAutosaveRestoreBanner(record) {
    const banner = document.createElement('div');
    banner.id = 'autosaveRestoreBanner';
    banner.style.cssText = [
      'position:fixed', 'left:50%', 'top:16px', 'transform:translateX(-50%)',
      'z-index:10000', 'background:#0f172a', 'color:#f8fafc',
      'padding:12px 16px', 'border-radius:10px',
      'box-shadow:0 8px 24px rgba(0,0,0,.28)',
      'display:flex', 'flex-direction:column', 'gap:8px',
      'max-width:520px', 'font:13px/1.4 system-ui,sans-serif',
    ].join(';');

    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:13.5px';
    title.textContent = 'Recovered work available';
    banner.appendChild(title);

    const detail = document.createElement('div');
    detail.style.cssText = 'font-size:12px;color:#cbd5f5';
    detail.textContent = 'We autosaved your last session before it closed — ' + describeAutosaveRecord(record) + '.';
    banner.appendChild(detail);

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:2px';

    const restoreBtn = document.createElement('button');
    restoreBtn.type = 'button';
    restoreBtn.textContent = 'Restore';
    restoreBtn.style.cssText = 'padding:6px 12px;background:#38bdf8;color:#0f172a;border:none;border-radius:6px;font-weight:700;cursor:pointer';
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      restoreBtn.textContent = 'Restoring…';
      try {
        suspendAutosave();
        await loadProject(record.snapshot);
        showToast(record.imagesStripped
          ? 'Restored annotations. The reference image was not saved to storage — please re-add it.'
          : 'Restored your previous session.');
        clearAutosave();
      } catch (err) {
        console.error('[autosave] restore failed:', err);
        showToast('Could not restore the autosaved session.', 4200);
      } finally {
        resumeAutosave();
        banner.remove();
      }
    });
    btnRow.appendChild(restoreBtn);

    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.textContent = 'Discard';
    discardBtn.style.cssText = 'padding:6px 12px;background:transparent;color:#f8fafc;border:1px solid #475569;border-radius:6px;cursor:pointer';
    discardBtn.addEventListener('click', () => {
      clearAutosave();
      banner.remove();
    });
    btnRow.appendChild(discardBtn);

    banner.appendChild(btnRow);
    document.body.appendChild(banner);
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
