// Real OpenCV (opencv.js / WASM) adapter.
//
// Exposes the same surface as opencv_free_api.js so detectSketchFromImage()
// in index.html can switch between them without branching: same input shape,
// same output shape. Runtime picker (getCvApi) prefers this one when ready,
// otherwise falls back to FreeOpenCVAPI. opencv.js itself is loaded async
// from a CDN by a separate <script> tag in index.html.

(function (global) {
  'use strict';

  const VERSION = 'real-opencv-api-20260618';

  // Resolves true once cv.Mat + cv.adaptiveThreshold are available
  // (i.e. WASM finished loading). Resolves false after ~30s if opencv.js
  // never arrives — typically because the CDN is unreachable or the user
  // is offline. We never reject so callers can `await whenReady()` safely.
  let readyPromise = null;

  function probeReady() {
    const cv = global.cv;
    return !!(cv && typeof cv.Mat === 'function' && typeof cv.adaptiveThreshold === 'function');
  }

  function startReadyWatch() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      if (probeReady()) { resolve(true); return; }
      let attempts = 0;
      const poll = setInterval(() => {
        attempts += 1;
        if (probeReady()) {
          clearInterval(poll);
          resolve(true);
        } else if (attempts > 500) {
          // ~30 s at 60 ms — give up so callers don't hang forever.
          clearInterval(poll);
          resolve(false);
        }
      }, 60);
    });
    return readyPromise;
  }

  function whenReady(timeoutMs) {
    const ready = startReadyWatch();
    if (!Number.isFinite(timeoutMs)) return ready;
    return Promise.race([
      ready,
      new Promise((resolve) => setTimeout(() => resolve(probeReady()), timeoutMs)),
    ]);
  }

  function isReady() {
    return probeReady();
  }

  // Reuse FreeOpenCVAPI's downsample helper when available so we share the
  // exact scale / minSize behavior with the legacy detector. Standalone
  // fallback below keeps the module usable on its own.
  function downsampleToRgba(image, options) {
    const free = global.FreeOpenCVAPI;
    if (free && typeof free.imreadFromImage === 'function') {
      return free.imreadFromImage(image, options);
    }
    const opts = options || {};
    const naturalW = image.naturalWidth || image.width || 0;
    const naturalH = image.naturalHeight || image.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');
    const targetWidth = Number(opts.targetWidth) || 480;
    const minSize = Number(opts.minSize) || 32;
    const scale = Math.min(1, targetWidth / naturalW);
    const width = Math.max(minSize, Math.round(naturalW * scale));
    const height = Math.max(minSize, Math.round(naturalH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('offscreen canvas unavailable');
    ctx.drawImage(image, 0, 0, width, height);
    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      throw new Error('cannot read pixels (tainted canvas)');
    }
    return { width, height, scale, data: imageData.data };
  }

  function estimateBackground(rgba, width, height) {
    const free = global.FreeOpenCVAPI;
    if (free && typeof free.estimateBorderBackground === 'function') {
      return free.estimateBorderBackground(rgba, width, height);
    }
    return { r: 255, g: 255, b: 255, lum: 255 };
  }

  function buildStats(mask, width, height) {
    const free = global.FreeOpenCVAPI;
    if (free && typeof free.buildMaskStats === 'function') {
      return free.buildMaskStats(mask, width, height);
    }
    const colDark = new Uint32Array(width);
    const rowDark = new Uint32Array(height);
    let count = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y += 1) {
      const rowBase = y * width;
      for (let x = 0; x < width; x += 1) {
        if (!mask[rowBase + x]) continue;
        colDark[x] += 1;
        rowDark[y] += 1;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { count, minX, minY, maxX, maxY, colDark, rowDark };
  }

  // Adaptive-threshold ink mask. Pipeline:
  //   RGBA → gray → 5x5 Gaussian blur → adaptiveThreshold(GAUSSIAN_C, INV)
  //        → morphology CLOSE 3x3 → 0/1 Uint8Array
  // Block size adapts to image resolution; C=7 from a small sketch panel
  // sweep — high enough to ignore paper grain, low enough to keep faint
  // strap curves.
  function createInkMaskFromImage(image, options) {
    if (!probeReady()) throw new Error('opencv.js not ready');
    const cv = global.cv;

    const sample = downsampleToRgba(image, options);
    const { width, height, scale, data } = sample;
    const total = width * height;
    const background = estimateBackground(data, width, height);

    let src = null;
    let gray = null;
    let blurred = null;
    let mask = null;
    let kernel = null;
    try {
      src = new cv.Mat(height, width, cv.CV_8UC4);
      src.data.set(data);

      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

      blurred = new cv.Mat();
      cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

      mask = new cv.Mat();
      // Odd block size scaled to the image, clamped to a sensible window.
      const raw = Math.round(Math.min(width, height) * 0.04);
      const blockSize = Math.max(15, Math.min(45, raw | 1));
      cv.adaptiveThreshold(
        blurred,
        mask,
        255,
        cv.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv.THRESH_BINARY_INV,
        blockSize,
        7
      );

      kernel = cv.Mat.ones(3, 3, cv.CV_8U);
      cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);

      const out = new Uint8Array(total);
      const buf = mask.data;
      for (let i = 0; i < total; i += 1) out[i] = buf[i] ? 1 : 0;

      return {
        engine: VERSION,
        width,
        height,
        total,
        scale,
        mask: out,
        stats: buildStats(out, width, height),
        // adaptiveThreshold has no single global cutoff; values kept on the
        // object only for telemetry/shape parity with the legacy detector.
        threshold: 0,
        luminanceThreshold: 0,
        background,
        backgroundLum: Math.round(background.lum || 255),
      };
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
      if (blurred) blurred.delete();
      if (mask) mask.delete();
      if (kernel) kernel.delete();
    }
  }

  // 8-connectivity component labeler with the same filtering rules the
  // free fallback uses, so downstream view classification sees the same
  // component shape regardless of which backend ran. Filters out:
  //   - frame artifacts (huge, touches >=2 borders, sparse)
  //   - tiny specks below minCount (unless they're a long stroke)
  function connectedComponentsWithStats(maskInput, width, height, minCount) {
    if (!probeReady()) throw new Error('opencv.js not ready');
    const cv = global.cv;

    let input = null;
    let labels = null;
    let stats = null;
    let centroids = null;
    try {
      input = new cv.Mat(height, width, cv.CV_8UC1);
      const inBuf = input.data;
      for (let i = 0; i < maskInput.length; i += 1) inBuf[i] = maskInput[i] ? 255 : 0;

      labels = new cv.Mat();
      stats = new cv.Mat();
      centroids = new cv.Mat();
      const nLabels = cv.connectedComponentsWithStats(input, labels, stats, centroids, 8, cv.CV_32S);

      const componentCount = Math.max(0, nLabels - 1);
      const components = [];
      const keep = new Uint8Array(nLabels);
      const statsData = stats.data32S;
      const centroidsData = centroids.data64F;

      for (let lbl = 1; lbl < nLabels; lbl += 1) {
        const base = lbl * 5;
        const x = statsData[base];
        const y = statsData[base + 1];
        const w = statsData[base + 2];
        const h = statsData[base + 3];
        const area = statsData[base + 4];

        const minX = x;
        const minY = y;
        const maxX = x + w - 1;
        const maxY = y + h - 1;

        let touches = 0;
        if (minX === 0) touches += 1;
        if (maxX === width - 1) touches += 1;
        if (minY === 0) touches += 1;
        if (maxY === height - 1) touches += 1;

        const bbArea = Math.max(1, w * h);
        const density = area / bbArea;
        const longStroke = Math.max(w, h) >= Math.min(width, height) * 0.08
          && area >= minCount * 0.45;
        const likelyFrame = touches >= 2
          && w > width * 0.82
          && h > height * 0.82
          && density < 0.10;
        if (likelyFrame || (area < minCount && !longStroke)) continue;

        keep[lbl] = 1;
        components.push({
          count: area,
          minX,
          minY,
          maxX,
          maxY,
          width: w,
          height: h,
          area: bbArea,
          density,
          cx: centroidsData[lbl * 2],
          cy: centroidsData[lbl * 2 + 1],
          touches,
        });
      }

      const total = width * height;
      const output = new Uint8Array(total);
      const labelData = labels.data32S;
      for (let i = 0; i < total; i += 1) {
        if (keep[labelData[i]]) output[i] = 1;
      }

      return { mask: output, components, componentCount };
    } finally {
      if (input) input.delete();
      if (labels) labels.delete();
      if (stats) stats.delete();
      if (centroids) centroids.delete();
    }
  }

  global.RealOpenCVAPI = {
    version: VERSION,
    whenReady,
    isReady,
    createInkMaskFromImage,
    connectedComponentsWithStats,
  };

  // Kick the readiness watcher so the polling interval starts the moment
  // this script runs — by the time the user clicks Detect Sketch, opencv.js
  // has usually finished loading from the CDN in the background.
  startReadyWatch();
})(window);
