// Ink-mask acquisition: how the detector gets a binary ink mask off the source
// bitmap. Holds the detection resolution / tuning-parameter block, the DOM
// pixel-read edge (offscreen canvas), the legacy no-OpenCV thresholding path,
// the paper-background estimator, and the adapter/OpenCV/legacy selection in
// buildInkAnalysisFromImage.
//
// Depends on math-utils.js (otsuThreshold). The mask it produces is consumed by
// the segmentation stage in segmentation.js.
// Source part for app.js. Run `npm run build` after editing.

  // Detection analysis resolution. Higher = better small-feature accuracy
  // (cleavage point, hook profile, strap attach) at the cost of CPU. Offline
  // detection is local so this trades CPU for accuracy, not latency or $.
  const DETECTION_TARGET_WIDTH = 1024;
  const DETECTION_DEFAULT_PARAMS = {
    bandSearchStartRatio: 0.58,
    bandPreferredRatio: 0.82,
    rowNoiseMultiplier: 1,
    colNoiseMultiplier: 1,
  };

  function getDefaultDetectionParams() {
    return { ...DETECTION_DEFAULT_PARAMS };
  }

  function normalizeDetectionParams(input) {
    const base = getDefaultDetectionParams();
    const src = input && typeof input === 'object' ? input : {};
    return {
      bandSearchStartRatio: clampNumber(src.bandSearchStartRatio, 0.50, 0.68, base.bandSearchStartRatio),
      bandPreferredRatio: clampNumber(src.bandPreferredRatio, 0.72, 0.90, base.bandPreferredRatio),
      rowNoiseMultiplier: clampNumber(src.rowNoiseMultiplier, 0.75, 1.25, base.rowNoiseMultiplier),
      colNoiseMultiplier: clampNumber(src.colNoiseMultiplier, 0.75, 1.25, base.colNoiseMultiplier),
    };
  }

  function activeDetectionParams(options) {
    const sources = [];
    if (!(options && options.skipLearningParams) && typeof getLearnedDetectionParams === 'function') {
      sources.push(getLearnedDetectionParams());
    }
    if (options && options.params) sources.push(options.params);
    return normalizeDetectionParams(Object.assign({}, ...sources));
  }

  // Side-effect-only: reads RGBA pixels off the source image via an offscreen
  // canvas. Returns the data the rest of the detection pipeline needs, with no
  // further dependency on the DOM. Split out of createLegacyInkAnalysis so the
  // pure pixel-math stages below can be unit-tested from Node without a canvas.
  function readSourceImagePixels(src, targetWidth) {
    const naturalW = src.naturalWidth || src.width || 0;
    const naturalH = src.naturalHeight || src.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');
    const TARGET_WIDTH = targetWidth || DETECTION_TARGET_WIDTH;
    const scale = Math.min(1, TARGET_WIDTH / naturalW);
    const w = Math.max(32, Math.round(naturalW * scale));
    const h = Math.max(32, Math.round(naturalH * scale));

    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const offCtx = off.getContext('2d', { willReadFrequently: true });
    if (!offCtx) throw new Error('offscreen canvas unavailable');
    offCtx.drawImage(src, 0, 0, w, h);

    let pixels;
    try {
      pixels = offCtx.getImageData(0, 0, w, h).data;
    } catch (err) {
      throw new Error('cannot read pixels (tainted canvas)');
    }
    return { pixels, width: w, height: h, naturalWidth: naturalW, naturalHeight: naturalH };
  }

  function createLegacyInkAnalysis(src, naturalW, naturalH) {
    const { pixels, width: w, height: h } = readSourceImagePixels(src);
    return pixelsToLegacyInkAnalysis(pixels, w, h);
  }

  // Pure ink-mask stage: rgba pixels → { mask, stats, threshold, ... }.
  // Takes a fixed Uint8ClampedArray + dimensions; returns deterministic output.
  // No DOM, no state, no globals — safe to call from a Node test harness.
  function pixelsToLegacyInkAnalysis(pixels, w, h) {
    const total = w * h;
    const lumGrid = new Uint8ClampedArray(total);
    const inkGrid = new Uint8ClampedArray(total);
    const lumHist = new Uint32Array(256);
    const inkHist = new Uint32Array(256);
    const background = estimateBorderBackground(pixels, w, h);
    for (let i = 0, p = 0; p < total; i += 4, p += 1) {
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const bgDiff = Math.max(0, background.lum - lum);
      const colorDiff = Math.hypot(r - background.r, g - background.g, b - background.b);
      const chromaInk = chroma > 18 && lum < background.lum - 6 ? chroma * 0.7 : 0;
      const ink = clamp(Math.round(Math.max(bgDiff, colorDiff * 0.78, chromaInk)), 0, 255);
      lumGrid[p] = lum;
      inkGrid[p] = ink;
      lumHist[lum] += 1;
      inkHist[ink] += 1;
    }

    const otsuInk = otsuThreshold(inkHist, total);
    const otsuLum = otsuThreshold(lumHist, total);
    const threshold = Math.max(22, Math.min(96, otsuInk));
    const luminanceThreshold = Math.max(55, Math.min(190, otsuLum - 8));
    const rawDark = new Uint8Array(total);
    for (let p = 0; p < total; p += 1) {
      const ink = inkGrid[p];
      const lum = lumGrid[p];
      const localInk = ink >= threshold;
      const darkByLum = lum < luminanceThreshold && background.lum - lum > 18;
      // (Dropped a dead `ink > threshold * 1.45` clause: localInk already
      // covers ink >= threshold, and threshold >= 22 > 0, so that term could
      // never be the deciding condition.)
      if (localInk || darkByLum) rawDark[p] = 1;
    }

    return {
      engine: 'offline-vision-legacy-threshold',
      width: w,
      height: h,
      total,
      mask: rawDark,
      stats: buildMaskStats(rawDark, w, h),
      threshold,
      luminanceThreshold,
      backgroundLum: Math.round(background.lum || 255),
    };
  }

  // DOM I/O edge: builds the ink-mask analysis for the source image, either via
  // the OpenCV adapter (which reads the canvas itself) or via the pure
  // legacy-pixel pipeline. Returns the same { mask, stats, threshold, ... }
  // shape from either path so the rest of the pipeline never branches on it.
  function buildInkAnalysisFromImage(image) {
    const src = image.img;
    if (!src) throw new Error('image has no bitmap');
    const naturalW = src.naturalWidth || src.width || 0;
    const naturalH = src.naturalHeight || src.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');

    let cvAnalysis = null;
    // Record which backend ACTUALLY produced the mask so the components stage
    // can reuse the same one. getCvApi() can flip (real opencv.js finishes
    // compiling) between calls, so we must not re-pick later — see
    // detectSketchFromImage.
    let inkBackend = null;

    // Phase 3 seam: a registered SAM-like segmentation adapter gets first
    // refusal. Default is null (see registerSegmentationAdapter), so this
    // branch is skipped entirely in normal offline runs. An adapter mask keeps
    // the in-house components path (inkBackend stays null) unless the adapter
    // also exposes connectedComponentsWithStats — same rule as the legacy path.
    const adapter = getSegmentationAdapter();
    if (adapter) {
      try {
        const adapted = adapter(src, { targetWidth: DETECTION_TARGET_WIDTH, minSize: 32 });
        if (adapted && adapted.mask && adapted.stats) {
          cvAnalysis = adapted;
          if (!cvAnalysis.engine) cvAnalysis.engine = 'external-segmentation-adapter';
          inkBackend = (typeof adapted.connectedComponentsWithStats === 'function') ? adapted : null;
        }
      } catch (err) {
        console.warn('[Auto Mode] segmentation adapter failed; using built-in detector:', err);
        cvAnalysis = null;
        inkBackend = null;
      }
    }

    const cv = getCvApi();
    if (!cvAnalysis && cv && typeof cv.createInkMaskFromImage === 'function') {
      try {
        cvAnalysis = cv.createInkMaskFromImage(src, { targetWidth: DETECTION_TARGET_WIDTH, minSize: 32 });
        if (cvAnalysis && cvAnalysis.mask && cvAnalysis.stats) inkBackend = cv;
      } catch (err) {
        console.warn('[Auto Mode] OpenCV ink mask failed; using legacy detector:', err);
      }
    }
    if (!cvAnalysis || !cvAnalysis.mask || !cvAnalysis.stats) {
      // In-house pixel path → keep the components stage in-house too (null).
      cvAnalysis = createLegacyInkAnalysis(src, naturalW, naturalH);
      inkBackend = null;
    }
    cvAnalysis.inkBackend = inkBackend;
    return cvAnalysis;
  }

  function estimateBorderBackground(pixels, w, h) {
    const samples = [];
    const step = Math.max(1, Math.floor(Math.min(w, h) / 40));
    const add = (x, y) => {
      const i = (y * w + x) * 4;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push({ r, g, b, lum });
    };
    for (let x = 0; x < w; x += step) {
      add(x, 0);
      add(x, h - 1);
    }
    // Start at `step` and stop before the last row so the four corners aren't
    // sampled twice (the top/bottom loop already covered y = 0 and y = h - 1),
    // which slightly over-weighted them in the brightest-40% background mean.
    for (let y = step; y < h - 1; y += step) {
      add(0, y);
      add(w - 1, y);
    }
    if (!samples.length) return { r: 255, g: 255, b: 255, lum: 255 };
    samples.sort((a, b) => a.lum - b.lum);
    const start = Math.floor(samples.length * 0.60);
    const bright = samples.slice(start);
    const src = bright.length ? bright : samples;
    let r = 0, g = 0, b = 0, lum = 0;
    for (const s of src) {
      r += s.r; g += s.g; b += s.b; lum += s.lum;
    }
    const n = src.length || 1;
    return { r: r / n, g: g / n, b: b / n, lum: lum / n };
  }
