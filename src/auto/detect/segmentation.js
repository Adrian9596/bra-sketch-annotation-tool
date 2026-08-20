// Stage 2 of the detection pipeline: segmentation. Turns the ink analysis from
// ink-mask.js into the cleaned foreground mask the rest of the pipeline reads.
//
// Holds the pluggable external-segmenter registry (the adapter seam consumed by
// src/auto/debug-api.js's test hooks), the backend-id classifier, the
// deterministic segmentation-quality score and its serializable view, the mask
// statistics / bounds helpers, the in-house connected-component ink filter, and
// the segmentSketch stage itself.
//
// Depends on ink-mask.js and math-utils.js.
// Source part for app.js. Run `npm run build` after editing.

  // -------- Segmentation adapter seam (Engineering Workflow Phase 3, item 4) --------
  //
  // A single, null-guarded plug point for a future SAM-like segmenter. The
  // contract mirrors the built-in ink-mask adapters (createInkMaskFromImage):
  // an adapter receives the source bitmap + options and returns the SAME ink
  // analysis shape { engine, width, height, total, mask, stats, threshold,
  // luminanceThreshold, backgroundLum, ... }. When registered it is tried
  // first in buildInkAnalysisFromImage and, on any failure or bad shape, the
  // pipeline falls back to OpenCV / legacy exactly as before.
  //
  // HARD OFFLINE RULE: an adapter MUST run fully locally. It may wrap a
  // vendored/WASM model, but it MUST NOT make any network call that carries
  // sketch or measurement data. Nothing here reaches the network; the default
  // is null, so the runtime is unchanged until a caller opts in.
  let externalSegmentationAdapter = null;
  function registerSegmentationAdapter(fn) {
    externalSegmentationAdapter = (typeof fn === 'function') ? fn : null;
    return !!externalSegmentationAdapter;
  }
  function clearSegmentationAdapter() { externalSegmentationAdapter = null; }
  function getSegmentationAdapter() { return externalSegmentationAdapter; }

  // Normalize the many possible ink-mask engine strings into a small, stable
  // set of backend ids so downstream code / debug summaries never have to
  // pattern-match version-stamped strings.
  function classifySegmentationBackend(engine) {
    const e = String(engine || '');
    if (/^real-opencv/.test(e)) return 'opencv-real';
    if (/^free-opencv/.test(e)) return 'opencv-free';
    if (/^offline-vision-legacy/.test(e)) return 'legacy';
    if (/^external/.test(e)) return 'external-adapter';
    if (/^synthetic/.test(e)) return 'synthetic';
    return e || 'unknown';
  }

  // Deterministic segmentation-quality score in [0,1], derived only from
  // signals the segmentation stage already computes. Same mask in → same
  // number out (no timing, no randomness). Low quality is a review signal,
  // not a failure: the mask still flows downstream, but callers can flag the
  // POMs for extra TD scrutiny.
  //
  // Sub-scores (each in [0,1]):
  //   coverage      — ink is a small-but-real fraction of the canvas; near-zero
  //                   means "found nothing", near-total means "flooded / frame".
  //   retention     — share of raw ink that survived component cleanup; a clean
  //                   line drawing keeps almost all of it, a noisy scan loses a
  //                   lot of speckle.
  //   fragmentation — few raw components is good; hundreds is speckle / dashes.
  //   presence      — at least one ink component survived cleanup.
  // A fail-open ink-cleanup revert halves the score (the mask may carry the
  // page frame / speckle the filter tried to strip).
  function computeSegmentationQuality(sig) {
    const coverage = Number.isFinite(sig.coverage) ? sig.coverage : 0;
    const retainedInk = Number.isFinite(sig.retainedInk) ? sig.retainedInk : 0;
    const componentCount = Number.isFinite(sig.componentCount) ? sig.componentCount : 0;
    const keptComponentCount = Number.isFinite(sig.keptComponentCount) ? sig.keptComponentCount : 0;
    const inkCleanupReverted = !!sig.inkCleanupReverted;

    const c01 = (v) => Math.max(0, Math.min(1, v));
    const rampUp = (v, lo, hi) => (hi <= lo ? (v >= hi ? 1 : 0) : c01((v - lo) / (hi - lo)));
    const rampDown = (v, lo, hi) => (hi <= lo ? (v <= lo ? 1 : 0) : c01((hi - v) / (hi - lo)));

    const coverageScore = Math.min(rampUp(coverage, 0.002, 0.01), rampDown(coverage, 0.35, 0.55));
    const retentionScore = rampUp(retainedInk, 0.45, 0.85);
    const fragScore = rampDown(componentCount, 60, 220);
    const presenceScore = keptComponentCount > 0 ? 1 : 0;

    let quality = c01(
      0.38 * coverageScore
      + 0.30 * retentionScore
      + 0.20 * fragScore
      + 0.12 * presenceScore
    );
    if (inkCleanupReverted) quality = c01(quality * 0.5);
    quality = Math.round(quality * 1e4) / 1e4;

    const reasons = [];
    if (coverage < 0.004) reasons.push('very little ink coverage — segmentation may have missed the garment');
    if (coverage > 0.45) reasons.push('very high ink coverage — segmentation may include the page frame or a fill');
    if (retainedInk < 0.5 && !inkCleanupReverted) reasons.push('component cleanup discarded a large share of the ink — noisy or fragmented source');
    if (componentCount > 160) reasons.push('many disconnected components — speckle or dashed line art');
    if (keptComponentCount === 0 && !inkCleanupReverted) reasons.push('no ink component survived cleanup');
    if (inkCleanupReverted) reasons.push('ink-cleanup revert fired — the outline may include page edges or speckle');

    const weak = inkCleanupReverted || quality < 0.45;
    return {
      quality,
      weak,
      reviewRequired: weak,
      reasons,
      subScores: {
        coverage: Math.round(coverageScore * 1e4) / 1e4,
        retention: Math.round(retentionScore * 1e4) / 1e4,
        fragmentation: Math.round(fragScore * 1e4) / 1e4,
        presence: presenceScore,
      },
    };
  }

  // Serializable view of the normalized segmentation-stage result: everything
  // except the raw mask typed array (the mask travels separately as
  // detection.inkMask, exposed by dimensions only so a JSON clone can't
  // explode it into one key per pixel).
  function serializeSegmentation(seg) {
    if (!seg) return null;
    const { mask, ...rest } = seg;
    return {
      ...rest,
      hasMask: !!mask,
    };
  }

  function buildMaskStats(mask, w, h, bounds) {
    const x0 = bounds ? clamp(Math.floor(bounds.minX), 0, w - 1) : 0;
    const y0 = bounds ? clamp(Math.floor(bounds.minY), 0, h - 1) : 0;
    const x1 = bounds ? clamp(Math.ceil(bounds.maxX), 0, w - 1) : w - 1;
    const y1 = bounds ? clamp(Math.ceil(bounds.maxY), 0, h - 1) : h - 1;
    const colDark = new Uint32Array(w);
    const rowDark = new Uint32Array(h);
    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = y0; y <= y1; y += 1) {
      const base = y * w;
      for (let x = x0; x <= x1; x += 1) {
        if (!mask[base + x]) continue;
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

  function statsToBounds(stats) {
    return {
      minX: stats.minX,
      minY: stats.minY,
      maxX: stats.maxX,
      maxY: stats.maxY,
      count: stats.count,
    };
  }

  function normalizeBounds(bounds, w, h) {
    return {
      x: clamp01(bounds.minX / w),
      y: clamp01(bounds.minY / h),
      width: clamp01((bounds.maxX - bounds.minX + 1) / w),
      height: clamp01((bounds.maxY - bounds.minY + 1) / h),
      count: bounds.count || 0,
    };
  }

  function filterInkComponents(rawMask, w, h, minCount) {
    const total = w * h;
    const visited = new Uint8Array(total);
    const out = new Uint8Array(total);
    const queue = new Int32Array(total);
    const keptComponents = [];
    let componentCount = 0;

    for (let start = 0; start < total; start += 1) {
      if (!rawMask[start] || visited[start]) continue;
      componentCount += 1;
      let head = 0, tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let count = 0;
      let minX = w, minY = h, maxX = -1, maxY = -1;
      let sumX = 0, sumY = 0;
      let touches = 0;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = Math.floor(idx / w);
        count += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        for (let yy = y - 1; yy <= y + 1; yy += 1) {
          if (yy < 0 || yy >= h) continue;
          const rowBase = yy * w;
          for (let xx = x - 1; xx <= x + 1; xx += 1) {
            if (xx < 0 || xx >= w || (xx === x && yy === y)) continue;
            const ni = rowBase + xx;
            if (visited[ni] || !rawMask[ni]) continue;
            visited[ni] = 1;
            queue[tail++] = ni;
          }
        }
      }

      if (minX === 0) touches += 1;
      if (maxX === w - 1) touches += 1;
      if (minY === 0) touches += 1;
      if (maxY === h - 1) touches += 1;

      const width = maxX - minX + 1;
      const height = maxY - minY + 1;
      const area = Math.max(1, width * height);
      const density = count / area;
      const longStroke = Math.max(width, height) >= Math.min(w, h) * 0.08 && count >= minCount * 0.45;
      const likelyFrame = touches >= 2 && width > w * 0.82 && height > h * 0.82 && density < 0.10;
      const keep = !likelyFrame && (count >= minCount || longStroke);
      if (!keep) continue;

      for (let i = 0; i < tail; i += 1) out[queue[i]] = 1;
      keptComponents.push({
        count, minX, minY, maxX, maxY, width, height, area, density,
        cx: sumX / count,
        cy: sumY / count,
        touches,
      });
    }

    return { mask: out, keptComponents, componentCount };
  }

  // ---- Stage 2: segmentation (ink mask + connected-component cleanup) ----
  // Input: the ink analysis (mask + stats + thresholds) from
  // buildInkAnalysisFromImage. Output: the cleaned foreground mask (`dark`),
  // its stats, the kept components, and the raw fallbacks. Returns
  // { earlyReturn } when there is not enough ink to proceed.
  function segmentSketch(cvAnalysis, ctx) {
    const { cv, stageTimingsMs } = ctx;
    const _stageMark = ctx.mark;

    const w = cvAnalysis.width;
    const h = cvAnalysis.height;
    const total = cvAnalysis.total;
    const threshold = cvAnalysis.threshold;
    const luminanceThreshold = cvAnalysis.luminanceThreshold;
    const rawDark = cvAnalysis.mask;
    const rawStats = cvAnalysis.stats;
    _stageMark('inkMaskIngest');

    const backend = classifySegmentationBackend(cvAnalysis.engine);

    if (rawStats.maxX < 0 || rawStats.maxY < 0 || rawStats.count < 80) {
      // Too little ink to segment. Still emit a normalized (weak) segmentation
      // block so the "no detection" path is measurable rather than opaque.
      const emptyCoverage = rawStats.count / total;
      const emptyQuality = computeSegmentationQuality({
        coverage: emptyCoverage, retainedInk: 0,
        componentCount: 0, keptComponentCount: 0, inkCleanupReverted: false,
      });
      return {
        earlyReturn: {
          coverage: emptyCoverage, threshold, luminanceThreshold, stageTimingsMs,
          segmentation: {
            backend,
            engine: cvAnalysis.engine || null,
            componentsBackend: cv ? 'opencv' : 'inhouse',
            maskW: w, maskH: h,
            bbox: null,
            coverage: Number(emptyCoverage.toFixed(6)),
            rawCoverage: Number(emptyCoverage.toFixed(6)),
            retainedInk: 0,
            componentCount: 0,
            keptComponentCount: 0,
            inkCleanupReverted: false,
            emptyMask: true,
            ...emptyQuality,
          },
        },
      };
    }

    // ---- Stage: connected-component cleanup ----
    const minComponentCount = Math.max(8, Math.round(rawStats.count * 0.0015));
    let filtered;
    // Reuse the SAME backend that built the ink mask — the caller threads it in
    // via opts.cv (detectSketchFromImage passes cvAnalysis.inkBackend). Picking
    // a backend here with getCvApi() let opencv.js finish loading mid-pipeline
    // and feed a free-path mask into the real-backend component pass — an
    // untested, nondeterministic mixed path. One backend per detection keeps the
    // pipeline coherent and tuning meaningful.
    const componentsApi = cv;
    if (componentsApi && typeof componentsApi.connectedComponentsWithStats === 'function') {
      const cvComponents = componentsApi.connectedComponentsWithStats(rawDark, w, h, minComponentCount);
      filtered = {
        mask: cvComponents.mask,
        keptComponents: cvComponents.components || [],
        componentCount: cvComponents.componentCount || 0,
      };
    } else {
      filtered = filterInkComponents(rawDark, w, h, minComponentCount);
    }
    let dark = filtered.mask;
    let globalStats = buildMaskStats(dark, w, h);
    // D7: when this fail-open revert fires it restores the RAW mask, which can
    // re-introduce the scanned-page frame / speckle that component filtering
    // just stripped — contaminating bbox / axis / every normalized coord. Flag
    // it so the result carries a review hint instead of "succeeding" silently.
    let inkCleanupReverted = false;
    if (globalStats.count < Math.max(60, rawStats.count * 0.20)) {
      // If filtering was too aggressive, fall back to the raw mask. This keeps
      // faint/dashed sketches usable instead of failing closed.
      dark = rawDark;
      globalStats = rawStats;
      filtered.keptComponents = [];
      inkCleanupReverted = true;
    }

    _stageMark('connectedComponents');

    // ---- Normalized segmentation-stage output (Phase 3) ----
    // One shape for every backend (OpenCV real / free, in-house legacy, or a
    // registered adapter): the cleaned foreground mask, its bbox, a backend
    // id, and a deterministic quality score. The mask reference stays here for
    // in-process consumers; the serializable detection view drops it (the mask
    // travels as detection.inkMask, by dimensions only).
    const coverage = globalStats.count / total;
    const rawCoverage = rawStats.count / total;
    const retainedInk = rawStats.count > 0 ? globalStats.count / rawStats.count : 0;
    const componentCount = filtered.componentCount || 0;
    const keptComponentCount = (filtered.keptComponents || []).length;
    const segBbox = globalStats.maxX >= 0
      ? normalizeBounds(statsToBounds(globalStats), w, h)
      : null;
    const segQuality = computeSegmentationQuality({
      coverage, retainedInk, componentCount, keptComponentCount, inkCleanupReverted,
    });
    const segmentation = {
      backend,
      engine: cvAnalysis.engine || null,
      componentsBackend: cv ? 'opencv' : 'inhouse',
      mask: dark,
      maskW: w,
      maskH: h,
      bbox: segBbox,
      coverage: Number(coverage.toFixed(6)),
      rawCoverage: Number(rawCoverage.toFixed(6)),
      retainedInk: Number(retainedInk.toFixed(4)),
      componentCount,
      keptComponentCount,
      inkCleanupReverted,
      emptyMask: false,
      ...segQuality,
    };

    return {
      w, h, total, threshold, luminanceThreshold,
      rawDark, rawStats, dark, globalStats, filtered, inkCleanupReverted,
      segmentation,
    };
  }
