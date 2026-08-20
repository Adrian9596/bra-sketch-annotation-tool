// Detection math primitives: zero-dependency numeric helpers (range clamping,
// Otsu thresholding, 1-2-1 smoothing, symmetry-axis refinement and scoring,
// median-of-non-zero) shared by nearly every detection stage.
//
// This is the first of the src/auto/detect/* parts to load; the ink-mask
// (ink-mask.js), sheet-geometry (view-boxes.js), segmentation (segmentation.js)
// and geometry (geometry-stage.js) stages all build on it.
// Source part for app.js. Run `npm run build` after editing.

  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  // Otsu's method — picks the threshold that maximizes between-class variance.
  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];
    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let bestT = 128;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const diff = mB - mF;
      const v = wB * wF * diff * diff;
      if (v > maxVar) { maxVar = v; bestT = t; }
    }
    if (maxVar < 0) {
      // Degenerate histogram (e.g. a single-valued / blank image): no
      // between-class split exists, so the loop never updated bestT. Return
      // the mean intensity — the single populated bin for a one-value image —
      // instead of a misleading hard-coded 128.
      return total > 0 ? Math.round(sum / total) : 128;
    }
    return bestT;
  }

  // 1-2-1 smoothing kernel — cheap, removes single-row/single-column jitter
  // without flattening real peaks.
  function smooth1D(arr) {
    const n = arr.length;
    const out = new Float32Array(n);
    if (n === 0) return out;
    for (let i = 0; i < n; i += 1) {
      const a = i > 0 ? arr[i - 1] : arr[i];
      const b = arr[i];
      const c = i < n - 1 ? arr[i + 1] : arr[i];
      out[i] = (a + 2 * b + c) / 4;
    }
    return out;
  }

  // Search centroid ± 5% bboxWidth (2px steps) and pick the candidate whose
  // mirror-fold around the binary dark map gives the best symmetry score.
  function refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroid) {
    const searchHalf = Math.max(3, Math.round((maxX - minX) * 0.05));
    const center = Math.round(centroid);
    let bestX = center;
    let bestScore = -1;
    for (let dx = -searchHalf; dx <= searchHalf; dx += 2) {
      const candidate = center + dx;
      if (candidate <= minX + 2 || candidate >= maxX - 2) continue;
      const score = computeSymmetryScore(dark, w, candidate, minX, maxX, minY, maxY);
      if (score > bestScore) { bestScore = score; bestX = candidate; }
    }
    return bestX;
  }

  // Symmetry score: of all dark pixels in scan range, share that have a dark
  // partner mirrored across `axisX`. Subsamples by 2 for speed.
  function computeSymmetryScore(dark, w, axisX, minX, maxX, minY, maxY) {
    const half = Math.min(axisX - minX, maxX - axisX);
    if (half < 4) return 0;
    let matches = 0;
    let total = 0;
    const step = 2;
    for (let y = minY; y <= maxY; y += step) {
      const rowBase = y * w;
      for (let d = 1; d <= half; d += step) {
        const li = rowBase + (axisX - d);
        const ri = rowBase + (axisX + d);
        const ld = dark[li];
        const rd = dark[ri];
        if (ld) { total += 1; if (rd) matches += 1; }
        if (rd) { total += 1; if (ld) matches += 1; }
      }
    }
    return total > 0 ? matches / total : 0;
  }

  function approxMedianNonZero(arr, lo, hi) {
    const vals = [];
    for (let i = lo; i <= hi; i += 1) {
      if (arr[i] > 0) vals.push(arr[i]);
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)];
  }
