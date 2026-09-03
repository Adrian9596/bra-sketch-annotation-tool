// US-120: Auto Seam Worker entry. The ONLY part that is built into
// auto-seam-worker.js and NOT into app.js (see AUTO_SEAM_WORKER_PARTS in
// scripts/source-parts.mjs). Everything above it in the worker bundle is the
// same src/auto/seam/* code app.js ships, so a result computed here is
// identical to one computed on the main thread — the client
// (src/manual/auto-seam-worker-client.js) relies on that, and
// scripts/auto-seam-worker-check.mjs proves it byte-for-byte per fixture.
//
// Protocol (one request at a time is all the client ever sends):
//   in : { type: 'analyze', requestId, source: { pixels: { [maxDimension]:
//          { maxDimension, naturalWidth, naturalHeight, width, height,
//            buffer: ArrayBuffer /* RGBA */ } } } }        (buffers transferred)
//   out: { type: 'result', requestId, result }              (structured clone)
//        { type: 'error',  requestId, message }
// The pixels are read on the MAIN thread by autoSeamReadPixels() with the
// same DOM canvas the synchronous path uses, so this worker never resamples
// an image itself — that is what keeps its result byte-identical.
// Source part for auto-seam-worker.js. Run `npm run build` after editing.

  // The seam lanes call clone() for result records. In app.js it comes from
  // src/manual/annotation-lookup.js, which is Board code this bundle must not
  // carry, so the worker declares the identical one-liner here. Keep the two
  // in lockstep: both are JSON round-trips, so results serialize the same.
  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  if (typeof self !== 'undefined' && typeof importScripts === 'function') {
    self.addEventListener('message', (event) => {
      const data = event && event.data ? event.data : {};
      if (data.type !== 'analyze') return;
      try {
        // Rebuild the sourceImage shape pixel-model.js reads: no img (there is
        // nothing to draw), only pre-read pixels keyed by maxDimension. No id,
        // dataURL or Board state ever crosses into here.
        const pixels = {};
        const incoming = (data.source && data.source.pixels) || {};
        for (const key of Object.keys(incoming)) {
          const entry = incoming[key];
          pixels[key] = {
            maxDimension: entry.maxDimension,
            naturalWidth: entry.naturalWidth,
            naturalHeight: entry.naturalHeight,
            width: entry.width,
            height: entry.height,
            rgba: new Uint8ClampedArray(entry.buffer),
          };
        }
        const result = analyzeAutoSeamSource({ img: null, pixels });
        self.postMessage({ type: 'result', requestId: data.requestId, result });
      } catch (error) {
        self.postMessage({
          type: 'error',
          requestId: data.requestId,
          message: String(error && error.message ? error.message : error),
        });
      }
    });
  }
