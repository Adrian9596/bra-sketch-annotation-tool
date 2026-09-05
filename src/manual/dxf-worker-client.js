// US-124 Phase 5 (ADR 0091): DXF Worker client — the main-thread side of
// dxf-worker.js.
//
// importDxfText() parses synchronously on the main thread, which freezes the
// tab for the duration — fine for the corpus's ≤1 s files, not for a
// full-size-run nest (the 16–36 MB 齐码 exports) or anything with hundreds
// of placement instances. When a file looks large (more top-level INSERTs
// than DXF_PATTERN_BATCH_THRESHOLD, or the TD/debug forces it), the SAME
// pure parse runs in the worker: parseDxfDocument + parseDxfNativeModel on
// the same text with the same options, posting one progress message per
// classified instance. The board mutation (dxfPlaceParsedDocument) still
// runs here, unchanged, once the whole result is back — all-or-nothing, so
// Cancel can never leave a half-placed board.
//
// Behaviour-preserving by construction: both bundles are built from the same
// parts (DXF_WORKER_PARTS) — scripts/dxf-worker-check.mjs asserts the parse
// result is byte-identical per corpus file. The fallback is NOT silent: a
// disabled/unsupported/failed worker parses in-thread and the execution
// record (state.dxfLastImportExecution) says engine + reason.
// Source part for app.js. Run `npm run build` after editing.

  var dxfWorkerHandle = null;         // lazily created Worker, reused across imports
  var dxfWorkerBroken = false;        // sticky for the session after a load/runtime failure
  var dxfWorkerOverride = null;       // debug/test: true/false forces on/off; null = URL flag / default
  var dxfWorkerForce = false;         // debug/test: route EVERY import to the worker regardless of size
  var dxfWorkerUrlOverride = null;    // debug/test: point at a different (e.g. missing) worker file
  var dxfWorkerRequestSeq = 0;
  var dxfWorkerActiveRequest = null;  // { requestId, cancelled } for the import in flight
  var DXF_WORKER_TIMEOUT_MS = 180000; // a 36 MB nest can legitimately take minutes

  function dxfWorkerUrl() {
    if (dxfWorkerUrlOverride) return dxfWorkerUrlOverride;
    return typeof DXF_WORKER_URL === 'string' ? DXF_WORKER_URL : '';
  }

  function dxfWorkerEnabled() {
    if (dxfWorkerOverride != null) return !!dxfWorkerOverride;
    try {
      if (new URLSearchParams(window.location.search).get('dxfWorker') === '0') return false;
    } catch (error) { /* no window.location in odd hosts: default on */ }
    return true;
  }

  function dxfWorkerSupported() {
    return typeof Worker === 'function' && dxfWorkerUrl().length > 0;
  }

  function dxfGetWorker() {
    if (!dxfWorkerHandle) dxfWorkerHandle = new Worker(dxfWorkerUrl());
    return dxfWorkerHandle;
  }

  function dxfDisposeWorker() {
    if (!dxfWorkerHandle) return;
    try { dxfWorkerHandle.terminate(); } catch (error) { /* already gone */ }
    dxfWorkerHandle = null;
  }

  function dxfSetWorkerEnabled(enabled) {
    dxfWorkerOverride = enabled == null ? null : !!enabled;
    if (enabled) dxfWorkerBroken = false;
    if (enabled === false) dxfDisposeWorker();
  }

  function dxfSetWorkerForce(force) { dxfWorkerForce = !!force; }

  // Sticky for the session after a load/runtime failure (the client's own
  // catch and importDxfText's retry both call this).
  function dxfMarkWorkerBroken() {
    dxfWorkerBroken = true;
    dxfDisposeWorker();
  }

  function dxfSetWorkerUrl(url) {
    dxfWorkerUrlOverride = url ? String(url) : null;
    dxfWorkerBroken = false;
    dxfDisposeWorker();
  }

  // Cheap size estimate WITHOUT parsing: top-level INSERTs in ENTITIES. For
  // every grading-nest / CLO export in the corpus one INSERT is one placement
  // instance is one pattern, so this is the pattern count the 120 threshold
  // means. A no-INSERT file estimates 0 and stays synchronous (its cost is
  // the legacy O(n²) grouping, not this story's target).
  function dxfEstimateInstanceCount(text) {
    const s = String(text || '');
    const entities = s.search(/\n\s*2\s*\r?\n\s*ENTITIES\s*\r?\n/);
    if (entities < 0) return 0;
    const tail = s.slice(entities);
    const m = tail.match(/\n\s*0\s*\r?\n\s*INSERT\s*\r?\n/g);
    return m ? m.length : 0;
  }

  // The routing decision importDxfText makes before parsing. Returns
  // { useWorker, reason, estimate }.
  function dxfWorkerRoute(text) {
    const estimate = dxfEstimateInstanceCount(text);
    const large = dxfWorkerForce || estimate > DXF_PATTERN_BATCH_THRESHOLD;
    if (!large) return { useWorker: false, reason: 'under-threshold', estimate };
    if (!dxfWorkerEnabled()) return { useWorker: false, reason: 'worker-disabled', estimate };
    if (!dxfWorkerSupported()) return { useWorker: false, reason: 'worker-unavailable', estimate };
    if (dxfWorkerBroken) return { useWorker: false, reason: 'worker-failed-earlier', estimate };
    return { useWorker: true, reason: 'ok', estimate };
  }

  // Resolves { board, native, elapsedMs, progressEvents }; rejects on worker
  // load/runtime failure or timeout. `onProgress(stage, done, total)` is
  // optional. A cancelled request rejects with Error('cancelled') and the
  // worker is terminated so the heavy parse actually stops.
  function dxfWorkerParse(text, options, onProgress) {
    const worker = dxfGetWorker();
    return new Promise((resolve, reject) => {
      const requestId = 'dxf-req-' + (++dxfWorkerRequestSeq);
      const request = { requestId, cancelled: false };
      dxfWorkerActiveRequest = request;
      let settled = false;
      let progressEvents = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        if (dxfWorkerActiveRequest === request) dxfWorkerActiveRequest = null;
        if (error) reject(error); else resolve(value);
      };
      request.cancel = () => {
        request.cancelled = true;
        dxfDisposeWorker();
        finish(new Error('cancelled'));
      };
      const onMessage = (event) => {
        const data = event && event.data ? event.data : {};
        if (data.requestId !== requestId) return;
        if (data.type === 'progress') { progressEvents += 1; if (onProgress) onProgress(data.stage, data.done, data.total); }
        else if (data.type === 'result') finish(null, { board: data.board, native: data.native, elapsedMs: data.elapsedMs, progressEvents });
        else if (data.type === 'error') finish(new Error(data.message || 'worker error'));
      };
      const onError = (event) => {
        finish(new Error(event && event.message ? event.message : 'worker failed to load or crashed'));
      };
      const timer = setTimeout(() => finish(new Error('worker-timeout')), DXF_WORKER_TIMEOUT_MS);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.postMessage({ type: 'parse', requestId, text, options: options || {} });
    });
  }

  function dxfCancelActiveWorkerImport() {
    if (dxfWorkerActiveRequest && dxfWorkerActiveRequest.cancel) dxfWorkerActiveRequest.cancel();
  }

  // The progress dialog — buildDialog's shell so Esc / click-outside behave
  // like every other modal. Closing it by any route cancels the import: the
  // result is discarded (never placed) and the worker terminated.
  function openDxfImportProgressDialog(fileName, estimate, onCancel) {
    const dlg = buildDialog({
      title: 'Importing large DXF…',
      sub: (fileName ? fileName + ' — ' : '') + 'about ' + estimate.toLocaleString('en-US') + ' placement instances. Parsing off the main thread; the board stays responsive.',
    });
    dlg.overlay.classList.add('dxf-import-progress');
    const body = document.createElement('div');
    body.className = 'dialog-body';
    body.style.cssText = 'display:flex;flex-direction:column;gap:10px;min-width:420px;';
    const bar = document.createElement('progress');
    bar.className = 'dxf-import-progress-bar';
    bar.max = 100; bar.value = 0;
    bar.style.cssText = 'width:100%;height:10px;';
    const text = document.createElement('div');
    text.className = 'dxf-import-progress-text';
    text.style.cssText = 'font-size:12px;color:#444;';
    text.textContent = 'Starting…';
    body.appendChild(bar);
    body.appendChild(text);
    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    footer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn dxf-import-progress-cancel';
    cancelBtn.textContent = 'Cancel import';
    footer.appendChild(cancelBtn);
    dlg.panel.appendChild(body);
    dlg.panel.appendChild(footer);
    let cancelled = false;
    const cancel = () => { if (cancelled) return; cancelled = true; dlg.close(); if (onCancel) onCancel(); };
    cancelBtn.addEventListener('click', cancel);
    // Esc / click-outside / the × go through buildDialog's own close() —
    // detect the overlay leaving the DOM and treat it as Cancel too.
    const observer = new MutationObserver(() => {
      if (!dlg.overlay.isConnected) { observer.disconnect(); cancel(); }
    });
    dlg.open();
    observer.observe(document.body, { childList: true });
    return {
      update(stage, done, total) {
        const stageLabel = stage === 'native' ? 'Building measurement model' : 'Classifying patterns';
        const pct = total ? Math.round((done / total) * 100) : 0;
        bar.value = pct;
        text.textContent = stageLabel + ' — ' + done.toLocaleString('en-US') + ' / ' + total.toLocaleString('en-US') + ' instances';
      },
      close() { observer.disconnect(); cancelled = true; dlg.close(); },
      isCancelled: () => cancelled,
    };
  }

  function dxfNow() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : Date.now();
  }

  function dxfRecordImportExecution(record) {
    state.dxfLastImportExecution = record;
    return record;
  }
