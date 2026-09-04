// US-124 Phase 5: DXF Worker entry. The ONLY part built into dxf-worker.js
// and NOT into app.js (see DXF_WORKER_PARTS in scripts/source-parts.mjs).
// Everything above it in the worker bundle is the same pure parse code app.js
// ships, so a result computed here is identical to one computed on the main
// thread — scripts/dxf-worker-check.mjs proves it byte-for-byte on every
// corpus file.
//
// Protocol (one request at a time is all the client ever sends):
//   in : { type: 'parse', requestId, text, options }
//         options = { keepQualityCurves, excludeInstances, diagnostics }
//   out: { type: 'progress', requestId, stage: 'board'|'native', done, total }
//        { type: 'result',   requestId, board, native, elapsedMs }
//        { type: 'error',    requestId, message }
// `board` is parseDxfDocument's result (the same object importDxfText reads
// on the synchronous path; its instanceBlockNames Map survives structured
// cloning), `native` is parseDxfNativeModel's. Progress is one message per
// classified instance, throttled to at most one every 40 ms so a 500-instance
// file does not flood the main thread.
// Source part for dxf-worker.js. Run `npm run build` after editing.

  if (typeof self !== 'undefined' && typeof importScripts === 'function') {
    self.addEventListener('message', (event) => {
      const data = event && event.data ? event.data : {};
      if (data.type !== 'parse') return;
      const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      try {
        const options = Object.assign({}, data.options || {});
        let lastPost = 0;
        const progress = (stage) => (done, total) => {
          const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
          if (done !== total && now - lastPost < 40) return;
          lastPost = now;
          self.postMessage({ type: 'progress', requestId: data.requestId, stage, done, total });
        };
        const board = parseDxfDocument(data.text, Object.assign({}, options, { onProgress: progress('board') }));
        const native = board.ok
          ? parseDxfNativeModel(data.text, Object.assign({}, options, { onProgress: progress('native') }))
          : null;
        const finished = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        self.postMessage({ type: 'result', requestId: data.requestId, board, native, elapsedMs: finished - started });
      } catch (error) {
        self.postMessage({
          type: 'error',
          requestId: data.requestId,
          message: String(error && error.message ? error.message : error),
        });
      }
    });
  }
