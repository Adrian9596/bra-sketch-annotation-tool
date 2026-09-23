// App bootstrap sequencing: init() and the vision-engine warm-up watcher.
// Source part for app.js. Run `npm run build` after editing.

  function init() {
    // S1: start watching the vendored OpenCV build immediately (fire and
    // forget) so the WASM compiles while the TD is still adding the sketch,
    // and the readiness chip never stalls silently on the first Detect.
    warmupVisionEngine();
    bindUI();
    initMainPage();
    initConstruction();
    initBom();
    initPreviewPage();
    initPageNav();
    applyAppCommandShortcutHints();
    // Auto-only build: boot straight into Auto Mode (sets body class,
    // status chip, and locks manual editing paths).
    setAppMode('auto');
    resizeCanvas();
    // US-088: after the first sizing, so the observer's initial callback is a
    // no-op rather than a diff against an unsized canvas.
    initCanvasResizeObserver();
    seedHistory();
    updateUI();
    render();
    maybeShowGroundTruthLabeler();
    // Ground-truth labeling (?label=1) is an ephemeral, one-image-per-URL flow:
    // don't autosave it or offer to restore a prior label session, which would
    // pop a "Recovered work" modal over the board on every reload.
    const labeling = new URLSearchParams(window.location.search).get('label') === '1';
    if (!labeling) armAutosave();
    void loadProjectFromUrl()
      .then(() => (labeling ? null : maybeOfferAutosaveRestore()))
      .then(() => maybeAutoDraftFromUrl());
  }

  // S1: watch the real OpenCV backend's readiness and mirror it into
  // state.visionEngine for the toolbar chip. Does not restart the polling —
  // opencv_real_api.js already began watching when its script loaded; this
  // just observes the same promise. Best-effort: any failure means the app
  // keeps working on the FreeOpenCVAPI fallback exactly as before.
  function warmupVisionEngine() {
    const real = typeof window !== 'undefined' ? window.RealOpenCVAPI : null;
    if (FORCE_FREE_CV || !real || typeof real.whenReady !== 'function') {
      state.visionEngine = 'unavailable';
      return;
    }
    if (typeof real.isReady === 'function' && real.isReady()) {
      state.visionEngine = 'ready';
      return;
    }
    state.visionEngine = 'warming';
    real.whenReady()
      .then((ready) => {
        state.visionEngine = ready ? 'ready' : 'unavailable';
        updateUI();
      })
      .catch(() => {
        state.visionEngine = 'unavailable';
        updateUI();
      });
  }
