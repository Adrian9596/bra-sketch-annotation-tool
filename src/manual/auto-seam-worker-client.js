// US-120: Auto Seam Worker client — the main-thread side of auto-seam-worker.js.
//
// runAutoDetectSeam() used to call analyzeAutoSeamSource() synchronously, so
// a 1600 px technical flat (14 native-resolution ROIs) froze the toolbar for
// the whole analysis. analyzeAutoSeamSourceAsync() runs the SAME pure code in
// a Web Worker. The main thread keeps the only two cheap pixel reads
// (autoSeamReadPixels at 640 and 1600 px, the same DOM-canvas draws the
// synchronous path does) and transfers the RGBA buffers; the worker runs the
// heavy part — masks, histograms, gradients, 14 ROIs of per-column scanning —
// and posts back the plain result object. Everything that touches Board
// state (validation, drafts, history, toasts) still runs here, unchanged, in
// src/manual/auto-seam.js.
//
// Behaviour-preserving by construction: both bundles are built from the same
// src/auto/seam/* parts (AUTO_SEAM_WORKER_PARTS) and the worker sees the very
// bytes the main thread would have analysed (it never resamples — an
// ImageBitmap drawn on an OffscreenCanvas was measured to differ from the DOM
// canvas by ~1e-3 in every 640 px feature). scripts/auto-seam-worker-check
// asserts the result is byte-identical per fixture.
//
// The fallback is NOT silent. When the worker is disabled (?autoSeamWorker=0
// or the debug setter), unsupported, or has failed once this session, the
// analysis runs in-thread and the returned `execution` record says so
// (engine + reason + elapsedMs); the record is kept on
// state.autoSeam.lastExecution and copied into lastRun for the suites.
// Source part for app.js. Run `npm run build` after editing.

  var autoSeamWorkerHandle = null;        // lazily created Worker, reused across runs
  var autoSeamWorkerBroken = false;       // sticky for the session after a load/runtime failure
  var autoSeamWorkerOverride = null;      // debug/test: true/false forces on/off; null = URL flag / default
  var autoSeamWorkerUrlOverride = null;   // debug/test: point at a different (e.g. missing) worker file
  var autoSeamWorkerRequestSeq = 0;
  var AUTO_SEAM_WORKER_TIMEOUT_MS = 30000;

  function autoSeamWorkerUrl() {
    if (autoSeamWorkerUrlOverride) return autoSeamWorkerUrlOverride;
    // AUTO_SEAM_WORKER_URL is injected into the app.js header by
    // scripts/build-app.mjs (content-hashed like app.js?v=). Absent only when
    // a part is parsed in isolation, never in the built bundle.
    return typeof AUTO_SEAM_WORKER_URL === 'string' ? AUTO_SEAM_WORKER_URL : '';
  }

  function autoSeamWorkerEnabled() {
    if (autoSeamWorkerOverride != null) return !!autoSeamWorkerOverride;
    try {
      if (new URLSearchParams(window.location.search).get('autoSeamWorker') === '0') return false;
    } catch (error) { /* no window.location in odd hosts: default on */ }
    return true;
  }

  function autoSeamWorkerSupported() {
    return typeof Worker === 'function' && autoSeamWorkerUrl().length > 0;
  }

  function autoSeamGetWorker() {
    if (!autoSeamWorkerHandle) autoSeamWorkerHandle = new Worker(autoSeamWorkerUrl());
    return autoSeamWorkerHandle;
  }

  function autoSeamDisposeWorker() {
    if (!autoSeamWorkerHandle) return;
    try { autoSeamWorkerHandle.terminate(); } catch (error) { /* already gone */ }
    autoSeamWorkerHandle = null;
  }

  // Debug/test surface (window.__braAutoModeDebug.autoSeam.setWorkerEnabled /
  // setWorkerUrl). Re-enabling also clears the sticky failure so a suite can
  // exercise the broken-URL fallback and then return to the worker.
  function autoSeamSetWorkerEnabled(enabled) {
    autoSeamWorkerOverride = enabled == null ? null : !!enabled;
    if (enabled) autoSeamWorkerBroken = false;
    if (!enabled) autoSeamDisposeWorker();
  }

  function autoSeamSetWorkerUrl(url) {
    autoSeamWorkerUrlOverride = url ? String(url) : null;
    autoSeamWorkerBroken = false;
    autoSeamDisposeWorker();
  }

  // The two scaled reads, done here with the same code and canvas the
  // synchronous path uses; only their RGBA buffers travel to the worker.
  function autoSeamPreReadPixels(sourceImage) {
    const pixels = {};
    const transfer = [];
    for (const maxDimension of AUTO_SEAM_WORKER_PIXEL_DIMENSIONS) {
      const read = autoSeamReadPixels(sourceImage, maxDimension);
      // getImageData() hands back a fresh Uint8ClampedArray over its own
      // buffer, so transferring it detaches nothing the page still uses.
      pixels[maxDimension] = {
        maxDimension: read.maxDimension,
        naturalWidth: read.naturalWidth,
        naturalHeight: read.naturalHeight,
        width: read.width,
        height: read.height,
        buffer: read.rgba.buffer,
      };
      transfer.push(read.rgba.buffer);
    }
    return { pixels, transfer };
  }

  function autoSeamAnalyzeInWorker(sourceImage) {
    const worker = autoSeamGetWorker();
    return Promise.resolve().then(() => autoSeamPreReadPixels(sourceImage)).then(({ pixels, transfer }) => new Promise((resolve, reject) => {
      const requestId = `auto-seam-req-${++autoSeamWorkerRequestSeq}`;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (error) reject(error); else resolve(value);
      };
      const onMessage = (event) => {
        const data = event && event.data ? event.data : {};
        if (data.requestId !== requestId) return;
        if (data.type === 'result') finish(null, data.result);
        else if (data.type === 'error') finish(new Error(data.message || 'worker error'));
      };
      // Fires when the worker script 404s / fails to parse, or throws
      // outside the message handler. Chrome reports a load failure here too.
      const onError = (event) => {
        finish(new Error(event && event.message ? event.message : 'worker failed to load or crashed'));
      };
      const timer = setTimeout(() => finish(new Error('worker-timeout')), AUTO_SEAM_WORKER_TIMEOUT_MS);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'analyze', requestId, source: { pixels } }, transfer);
    }));
  }

  function autoSeamNow() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now() : Date.now();
  }

  // Resolves { result, execution }. `result` is exactly what
  // analyzeAutoSeamSource(sourceImage) returns; `execution` is
  // { engine: 'worker' | 'main-thread', reason, elapsedMs }.
  async function analyzeAutoSeamSourceAsync(sourceImage) {
    const started = autoSeamNow();
    const elapsedMs = () => Math.round((autoSeamNow() - started) * 10) / 10;
    let reason = null;
    if (!autoSeamWorkerEnabled()) reason = 'worker-disabled';
    else if (!autoSeamWorkerSupported()) reason = 'worker-unavailable';
    else if (autoSeamWorkerBroken) reason = 'worker-failed-earlier';
    if (!reason) {
      try {
        const result = await autoSeamAnalyzeInWorker(sourceImage);
        return { result, execution: { engine: 'worker', reason: 'ok', elapsedMs: elapsedMs() } };
      } catch (error) {
        autoSeamWorkerBroken = true;
        autoSeamDisposeWorker();
        reason = `worker-failed: ${error && error.message ? error.message : error}`;
        console.warn(`Auto Detect Seam: ${reason}; analysing on the main thread for the rest of this session.`);
      }
    }
    const result = analyzeAutoSeamSource(sourceImage);
    return { result, execution: { engine: 'main-thread', reason, elapsedMs: elapsedMs() } };
  }
