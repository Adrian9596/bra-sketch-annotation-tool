// Auto Mode boundaries, offline sketch detection, feature extraction, anchor seeding and dragging.
// Source part for app.js. Run `npm run build` after editing.

  // =============================================================
  // Auto Mode — offline sketch detection + anchor-driven POM drafting.
  // Drafts live entirely outside state.annotations until an
  // explicit, atomic Apply moves approved rows into the project.
  // =============================================================

  function setAppMode(mode) {
    if (mode !== 'manual' && mode !== 'auto') return;
    state.appMode = mode;
    document.body.classList.toggle('app-auto', mode === 'auto');
    el.modeManualBtn.classList.toggle('active', mode === 'manual');
    el.modeAutoBtn.classList.toggle('active', mode === 'auto');
    // visibility handled by body.app-auto CSS class

    if (mode === 'auto') {
      // Force the user out of any creation-flavored tool so manual line
      // creation cannot fire while project annotations are locked.
      state.drawSession = null;
      state.eraseSession = null;
      state.tool = 'select';
      document.body.classList.remove('tool-eraser');
      // Clear any project selection so the user does not accidentally edit
      // locked annotations.
      if (state.selection.kind === 'annotation' || state.selection.kind === 'image') {
        state.selection = { kind: null, id: null };
      }
      ensureAutoModeStatus();
    } else {
      // Leaving Auto Mode: clear draft selection + drop detection /
      // anchors so nothing leaks into Manual rendering.
      if (state.selection.kind === 'draft') {
        state.selection = { kind: null, id: null };
      }
      state.autoMode.detection = null;
      state.autoMode.anchors = [];
      state.autoMode.anchorSelectedId = null;
    }
    updateUI();
    // Showing/hiding the Auto toolbar changes the canvas' page position and
    // available height. Recompute immediately so subsequent clicks map to the
    // correct world coordinates.
    resizeCanvas();
  }

  function requestAppModeChange(mode) {
    if (mode === state.appMode) return;
    if (mode === 'manual' && !canLeaveAutoMode()) {
      const drafts = state.autoMode.draftAnnotations;
      const approvedCount = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
      openAutoModeExitDialog({
        approvedCount,
        totalCount: drafts.length,
      }).then(choice => {
        if (choice === 'apply') {
          const applied = applyApprovedDraftsAtomically();
          if (!applied) return;
          if (state.autoMode.draftAnnotations.length > 0) {
            showToast('Some drafts remain. Resolve them before leaving Auto Mode.');
            return;
          }
          setAppMode('manual');
        } else if (choice === 'discard') {
          discardAutoDrafts(true);
          setAppMode('manual');
        }
        // 'stay' = no-op: user keeps Auto Mode and their drafts.
      });
      return;
    }
    setAppMode(mode);
  }

  function canLeaveAutoMode() {
    return state.autoMode.draftAnnotations.length === 0;
  }

  function ensureAutoModeStatus() {
    // Status priority:
    //   reviewing > detected > ready > idle
    // Drafts win because they need the most attention. Detection (with
    // anchors seeded) is next so the chip reflects "you can generate now".
    if (state.autoMode.draftAnnotations.length > 0) {
      state.autoMode.status = 'reviewing';
      return;
    }
    if (state.autoMode.detection) {
      state.autoMode.status = 'detected';
      return;
    }
    state.autoMode.status = pickAutoSourceImage() ? 'ready' : 'idle';
  }

  function pickAutoSourceImage() {
    // Use the currently selected image; otherwise the first image.
    const selected = getSelectedImage();
    if (selected) return selected;
    return state.images[0] || null;
  }

  // -------- Offline sketch detection --------
  //
  // First pass of "Detect Sketch": pure pixel analysis on the source image,
  // no model. Estimates a bounding box of the dark line art, the vertical
  // symmetry axis, and the bottom-band y. These will feed anchor placement
  // in the next phase. Everything is normalized to the image's native
  // pixel space [0, 1]^2 so it survives image scaling / canvas pans.

  async function runOfflineDetection() {
    if (state.appMode !== 'auto') {
      showToast('Switch to Auto Mode first.');
      return;
    }
    const sourceImage = pickAutoSourceImage();
    if (!sourceImage) {
      showToast('Add or select an image first, then click Detect Sketch.', 3600);
      return;
    }
    if (!sourceImage.img || !sourceImage.img.complete) {
      showToast('Source image is not ready yet — try again in a moment.');
      return;
    }

    state.autoMode.status = 'detecting';
    state.autoMode.lastError = null;
    updateUI();
    requestRender();

    // Yield so the toolbar shows the "detecting" chip before the (sync)
    // pixel scan runs — large sketches can take 50–200ms.
    await new Promise((r) => setTimeout(r, 0));

    // Give real opencv.js a short grace window to finish loading from CDN.
    // On warm cache / repeat detects this resolves immediately. If the CDN
    // never arrives (offline / blocked), the wait caps at 2.5s and the
    // detector silently uses FreeOpenCVAPI via getCvApi().
    if (window.RealOpenCVAPI && typeof window.RealOpenCVAPI.whenReady === 'function') {
      try { await window.RealOpenCVAPI.whenReady(2500); } catch (_) { /* fall through */ }
    }

    let detection;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    try {
      detection = detectSketchFromImage(sourceImage);
    } catch (err) {
      console.warn('[Auto Mode] Detect Sketch failed:', err);
      state.autoMode.status = 'error';
      state.autoMode.lastError = 'Detect Sketch failed: ' + (err && err.message ? err.message : err);
      showToast(state.autoMode.lastError, 4200);
      updateUI();
      requestRender();
      return;
    }
    const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    if (!detection || !detection.bbox || detection.coverage < 0.001) {
      state.autoMode.detection = null;
      state.autoMode.status = state.autoMode.draftAnnotations.length > 0 ? 'reviewing' : 'ready';
      state.autoMode.lastError = 'Detect Sketch found no dark line art in the source image.';
      showToast(state.autoMode.lastError, 4200);
      updateUI();
      requestRender();
      return;
    }

    detection.sourceImageId = sourceImage.id;
    detection.computedAt = new Date().toISOString();
    detection.durationMs = Math.round(t1 - t0);

    // Vector tracing pass — runs after the raster feature pass so curved
    // landmarks (cup arcs, strap, back hook) have real bezier control points
    // available to the POM generator. Failure is non-fatal: the rest of the
    // pipeline keeps working with the hand-tuned curves.
    const mask = detection._mask;
    const maskW = detection._maskW;
    const maskH = detection._maskH;
    delete detection._mask;
    delete detection._maskW;
    delete detection._maskH;
    if (mask && maskW && maskH) {
      const traceT0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      try {
        const traced = await tracePotraceFromMask(mask, maskW, maskH);
        if (traced) {
          detection.contours = traced;
          detection.contourCount = traced.paths.length;
          detection.traceDurationMs = Math.round(
            (typeof performance !== 'undefined' ? performance.now() : Date.now()) - traceT0
          );
          detection.engine += '+potrace';
        }
      } catch (err) {
        console.warn('[Auto Mode] Potrace tracing failed:', err);
      }
    }

    state.autoMode.detection = detection;
    maybePromptForViewRoles(detection);
    // Seed anchors from the new detection. If anchors already exist for a
    // PRIOR detection we replace them — re-detecting is the explicit signal
    // that the old seeds are stale. The TD can still drag any wrong ones,
    // and "Reset Anchors" re-derives them.
    state.autoMode.anchors = seedAnchorsFromDetection(detection, sourceImage);
    state.autoMode.anchorSelectedId = null;
    state.autoMode.status = 'detected';
    state.autoMode.lastError = null;

    pushHistoryIfChanged();
    updateUI();
    requestRender();
    const traceInfo = detection.contours
      ? ' + ' + detection.contourCount + ' contours (' + detection.traceDurationMs + 'ms)'
      : '';
    showToast('Detected sketch (' + detection.durationMs + 'ms)' + traceInfo + '. Anchors seeded — drag any that look wrong, then Generate POM Drafts.');
  }

  function maybePromptForViewRoles(detection) {
    if (!detection || !Array.isArray(detection.views) || detection.views.length < 2) return;
    if (!detection.viewRoleReviewRequired && !detection.views.some(v => !v.viewRole || v.viewRole === 'unknown')) return;
    if (typeof window === 'undefined' || typeof window.prompt !== 'function') return;
    const params = new URLSearchParams(window.location.search || '');
    if (params.has('autoDraft') || params.has('smoke') || params.has('learningTests') || params.has('meaningTests')) return;
    const current = detection.views
      .map((v, i) => (i + 1) + ':' + shortViewRole(v.viewRole || v.role || 'unknown'))
      .join(', ');
    const answer = window.prompt(
      'Confirm view roles. Use F=Front Outer, B=Back, I=Front Inner, U=Unknown.\n' +
      'Current: ' + current + '\n' +
      'Enter one letter per detected view, left to right:',
      detection.views.map(v => roleToPromptLetter(v.viewRole || v.role)).join('')
    );
    if (!answer) return;
    const letters = String(answer).toUpperCase().replace(/[^FBIU]/g, '').split('');
    if (!letters.length) return;
    const roleByLetter = { F: 'front_outer', B: 'back', I: 'front_inner', U: 'unknown' };
    for (let i = 0; i < detection.views.length && i < letters.length; i += 1) {
      const role = roleByLetter[letters[i]] || 'unknown';
      detection.views[i].viewRole = role;
      detection.views[i].role = role;
      if (detection.viewBoxes && detection.viewBoxes[i]) {
        detection.viewBoxes[i].viewRole = role;
        detection.viewBoxes[i].role = role === 'front_outer' ? 'front' : role;
      }
    }
    syncDetectionRoleIndexes(detection);
    detection.viewRoleReviewRequired = false;
  }

  function roleToPromptLetter(role) {
    if (role === 'front_outer' || role === 'front') return 'F';
    if (role === 'back') return 'B';
    if (role === 'front_inner') return 'I';
    return 'U';
  }

  function shortViewRole(role) {
    if (role === 'front_outer' || role === 'front') return 'F';
    if (role === 'back') return 'B';
    if (role === 'front_inner') return 'I';
    return 'U';
  }

  function syncDetectionRoleIndexes(detection) {
    const views = detection.views || detection.viewBoxes || [];
    const roleAt = (role) => views.findIndex(v => v && (v.viewRole === role || v.role === role));
    detection.frontOuterViewIndex = roleAt('front_outer');
    detection.frontViewIndex = detection.frontOuterViewIndex;
    detection.backViewIndex = roleAt('back');
    detection.frontInnerViewIndex = roleAt('front_inner');
    detection.primaryViewIndex = detection.frontOuterViewIndex >= 0
      ? detection.frontOuterViewIndex
      : (detection.primaryViewIndex || 0);
  }

  // Prefer real opencv.js when its WASM has finished loading; fall back
  // to the in-house FreeOpenCVAPI when offline or while the CDN script
  // is still downloading. Both adapters return the same data shape, so
  // detectSketchFromImage() never branches on which one it got.
  function getCvApi() {
    if (typeof window === 'undefined') return null;
    const real = window.RealOpenCVAPI;
    if (real && typeof real.isReady === 'function' && real.isReady()) return real;
    return window.FreeOpenCVAPI || null;
  }

  // Detection analysis resolution. Higher = better small-feature accuracy
  // (cleavage point, hook profile, strap attach) at the cost of CPU. Offline
  // detection is local so this trades CPU for accuracy, not latency or $.
  const DETECTION_TARGET_WIDTH = 1024;

  function createLegacyInkAnalysis(src, naturalW, naturalH) {
    const TARGET_WIDTH = DETECTION_TARGET_WIDTH;
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
      if (localInk || darkByLum || ink > threshold * 1.45) rawDark[p] = 1;
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

  // detectSketchFromImage — offline shape analysis pipeline.
  //
  // Reads pixels into an offscreen canvas, estimates the paper/background,
  // builds an "ink" mask, removes speckle via connected components, groups
  // likely sketch views, then picks a primary view for landmark extraction.
  // Feature detection is still fully local: no API, no network, no model.
  //
  // All returned coordinates are normalized [0, 1] relative to the source
  // image's native pixel size so they travel with the image.
  function detectSketchFromImage(image) {
    const src = image.img;
    if (!src) throw new Error('image has no bitmap');
    const naturalW = src.naturalWidth || src.width || 0;
    const naturalH = src.naturalHeight || src.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');

    let cvAnalysis = null;
    const cv = getCvApi();
    if (cv && typeof cv.createInkMaskFromImage === 'function') {
      try {
        cvAnalysis = cv.createInkMaskFromImage(src, { targetWidth: DETECTION_TARGET_WIDTH, minSize: 32 });
      } catch (err) {
        console.warn('[Auto Mode] OpenCV ink mask failed; using legacy detector:', err);
      }
    }
    if (!cvAnalysis || !cvAnalysis.mask || !cvAnalysis.stats) {
      cvAnalysis = createLegacyInkAnalysis(src, naturalW, naturalH);
    }

    const w = cvAnalysis.width;
    const h = cvAnalysis.height;
    const total = cvAnalysis.total;
    const threshold = cvAnalysis.threshold;
    const luminanceThreshold = cvAnalysis.luminanceThreshold;
    const rawDark = cvAnalysis.mask;
    const rawStats = cvAnalysis.stats;

    if (rawStats.maxX < 0 || rawStats.maxY < 0 || rawStats.count < 80) {
      return { coverage: rawStats.count / total, threshold, luminanceThreshold };
    }

    // ---- Pass 3: connected-component cleanup + view grouping ----
    const minComponentCount = Math.max(8, Math.round(rawStats.count * 0.0015));
    let filtered;
    // Re-pick the API for components in case real OpenCV finished loading
    // between the ink-mask call above and now. Either backend is safe;
    // both return the same { mask, components, componentCount } shape.
    const componentsApi = getCvApi();
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
    if (globalStats.count < Math.max(60, rawStats.count * 0.20)) {
      // If filtering was too aggressive, fall back to the raw mask. This keeps
      // faint/dashed sketches usable instead of failing closed.
      dark = rawDark;
      globalStats = rawStats;
      filtered.keptComponents = [];
    }

    let viewBoxesPx = detectSketchViewBoxes(filtered.keptComponents, globalStats, w, h);
    // If the component grouping returned a single wide bbox covering most of
    // the canvas, that's usually two views merged by stray ink. Try to split
    // it by finding the empty vertical alley in the middle.
    if (viewBoxesPx.length === 1) {
      const subdivided = splitMergedViewByVerticalValley(dark, w, h, viewBoxesPx[0]);
      if (subdivided.length > 1) viewBoxesPx = subdivided;
    }
    // Flexible view-role classification. Supports a two-view layout
    // (front_outer + back) and a three-view layout (front_outer + back +
    // front_inner). Role metadata, rather than image position, drives later
    // POM placement.
    const viewClassification = classifySketchViewRoles(dark, w, h, viewBoxesPx);
    const symPrimaryIndex = choosePrimaryViewBox(viewBoxesPx, dark, w, h);
    const primaryViewIndex = viewClassification.frontOuterIndex >= 0
      ? viewClassification.frontOuterIndex
      : symPrimaryIndex;
    const primaryBounds = viewBoxesPx[primaryViewIndex] || statsToBounds(globalStats);
    let localStats = buildMaskStats(dark, w, h, primaryBounds);
    if (localStats.count < 80) localStats = globalStats;

    const colDark = localStats.colDark;
    const rowDark = localStats.rowDark;
    const darkCount = localStats.count;
    let minX = localStats.minX;
    let minY = localStats.minY;
    let maxX = localStats.maxX;
    let maxY = localStats.maxY;

    if (maxX < 0 || maxY < 0 || darkCount < 80) {
      return { coverage: globalStats.count / total, threshold, luminanceThreshold };
    }

    // Bounding box: pad by 1 pixel and clip.
    const padMinX = Math.max(0, minX - 1);
    const padMinY = Math.max(0, minY - 1);
    const padMaxX = Math.min(w - 1, maxX + 1);
    const padMaxY = Math.min(h - 1, maxY + 1);
    const bbox = {
      x: padMinX / w,
      y: padMinY / h,
      width: (padMaxX - padMinX + 1) / w,
      height: (padMaxY - padMinY + 1) / h,
    };
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;

    // ---- Center axis: centroid candidate → symmetry-refined ----
    let xSum = 0, xWeight = 0;
    for (let x = minX; x <= maxX; x += 1) {
      xSum += x * colDark[x];
      xWeight += colDark[x];
    }
    const centroidX = xWeight > 0 ? xSum / xWeight : (minX + maxX) / 2;
    const axisXpx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const axisX = axisXpx / w;
    const symmetry = computeSymmetryScore(dark, w, axisXpx, minX, maxX, minY, maxY);

    // ---- Horizontal features (band, chest, cradle) via smoothed peaks ----
    const rowSmooth = smooth1D(rowDark);
    const rowSpan = computeRowSpans(dark, w, minX, maxX, minY, maxY);
    const medianRow = approxMedianNonZero(rowDark, minY, maxY);
    const rowNoiseFloor = Math.max(5, medianRow);
    const rowPeakScore = (y, preferredY, spread) => {
      const spanNorm = clamp01(rowSpan[y] / Math.max(1, bboxW));
      const base = rowSmooth[y] * (0.58 + spanNorm * 0.42);
      if (preferredY == null) return base;
      const pos = 1 - Math.min(1, Math.abs(y - preferredY) / Math.max(1, spread));
      return base * (0.82 + pos * 0.18);
    };

    // Band: long horizontal ink near the bottom, not just the single darkest row.
    const bandStart = Math.round(minY + bboxH * 0.58);
    let bandRow = -1;
    let bandStrength = 0;
    const bandPreferred = minY + bboxH * 0.82;
    for (let y = bandStart; y <= maxY; y += 1) {
      const score = rowPeakScore(y, bandPreferred, bboxH * 0.22);
      if (score > bandStrength) {
        bandStrength = score;
        bandRow = y;
      }
    }
    const bandY = bandRow >= 0 ? bandRow / h : (minY + maxY) / 2 / h;

    // Chest: long row in the upper cup/underarm zone. Skip the top few rows
    // so straps or page crop marks don't win.
    const chestStart = Math.round(minY + bboxH * 0.08);
    const chestEnd = Math.round(minY + bboxH * 0.50);
    let chestRow = -1;
    let chestStrength = 0;
    const chestPreferred = minY + bboxH * 0.30;
    for (let y = chestStart; y <= chestEnd; y += 1) {
      const score = rowPeakScore(y, chestPreferred, bboxH * 0.26);
      if (score > chestStrength) {
        chestStrength = score;
        chestRow = y;
      }
    }
    const chestY = (chestRow >= 0 && chestStrength > rowNoiseFloor * 1.5)
      ? chestRow / h : null;

    // Cradle / cup-bottom — peak between chest and band, separated from each
    // by at least 5% of bbox height. Used to seed inner-cup-bottom.
    const peakSep = Math.max(4, Math.round(bboxH * 0.05));
    const cradleLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.40)) + peakSep;
    const cradleHi = bandRow - peakSep;
    let cradleRow = -1;
    let cradleStrength = 0;
    for (let y = cradleLo; y <= cradleHi; y += 1) {
      const score = rowPeakScore(y, minY + bboxH * 0.64, bboxH * 0.24);
      if (score > cradleStrength) {
        cradleStrength = score;
        cradleRow = y;
      }
    }
    const cradleY = (cradleRow >= 0 && cradleStrength > rowNoiseFloor * 1.3)
      ? cradleRow / h : null;

    // Chest line (POM 3): the horizontal row in the cup zone where the
    // sketch's outline is widest. In a flat technical sketch this row is
    // (a) the cup-bottom seam (a solid line), OR (b) the bust-point row where
    // the cup outline is at its widest horizontal extent — both register as
    // "row with max left-to-right ink span". We search BETWEEN the upper
    // chest peak and the band, so the band itself isn't a candidate. The
    // preference pulls us toward ~62% bbox height where the cup widens.
    const underbustLo = (chestRow > 0 ? chestRow : Math.round(minY + bboxH * 0.30)) + peakSep;
    const underbustHi = (bandRow > 0 ? bandRow : maxY) - peakSep;
    let underbustRow = -1;
    let underbustStrength = 0;
    const underbustPreferred = minY + bboxH * 0.62;
    const underbustSpread = Math.max(1, bboxH * 0.28);
    const minRowSpan = Math.max(20, Math.round(bboxW * 0.70));
    for (let y = underbustLo; y <= underbustHi; y += 1) {
      const span = rowSpan[y];
      if (span < minRowSpan) continue;
      const pos = 1 - Math.min(1, Math.abs(y - underbustPreferred) / underbustSpread);
      const score = span * (0.7 + pos * 0.3);
      if (score > underbustStrength) {
        underbustStrength = score;
        underbustRow = y;
      }
    }
    const underbustRunPx = underbustRow >= 0 ? rowSpan[underbustRow] : 0;
    const underbustY = underbustRow >= 0 ? underbustRow / h : null;

    // ---- Vertical features (side seams) ----
    // Scan the FULL bbox height (minY → bandRow), not just chestRow → bandRow.
    // On longline / high-cut / plunge styles the side seam extends well above
    // the chest line; clipping the scan at chestRow throws away the bulk of
    // that ink and the real edge column never beats the noise floor.
    const seamTop = minY;
    const seamBottom = bandRow > 0 ? bandRow : maxY;
    const colTorso = countDarkByColumnInRange(dark, w, minX, maxX, seamTop, seamBottom);
    const colSmooth = smooth1D(colTorso);
    // Noise floor from the inner 20–80% of columns only. On 3-part cups or
    // styles with heavy internal construction (cup seams, underwire channels)
    // every column carries ink — taking the median across the full bbox width
    // inflates the floor and kills the thin outer edge signal. The inner band
    // captures "construction density" without poisoning the floor with the
    // outer silhouette itself.
    const innerLo = minX + Math.round(bboxW * 0.20);
    const innerHi = minX + Math.round(bboxW * 0.80);
    const medianCol = approxMedianNonZero(colTorso, innerLo, innerHi);
    const colNoiseFloor = Math.max(4, medianCol);
    // Keep a guard band around the axis so the center-front seam doesn't win.
    const axisGuard = Math.max(4, Math.round(bboxW * 0.08));
    const axisPx = Math.round(axisXpx);
    // Edge-proximity prior: rewards columns near bbox left/right edges so the
    // outer silhouette outscores interior cup seams (side-panel attach lines)
    // even when those carry more total ink. Linear falloff over a half-width;
    // beyond 50% of bboxW from the relevant edge the bonus is zero.
    const edgeBiasMax = 0.45;
    const colPeakScore = (x, edgePx) => {
      const axisDist = Math.abs(x - axisPx) / Math.max(1, bboxW);
      const edgeDist = Math.abs(x - edgePx) / Math.max(1, bboxW);
      const edgeBias = 1 + edgeBiasMax * Math.max(0, 1 - edgeDist * 2);
      return colSmooth[x] * (0.78 + Math.min(1, axisDist * 2.2) * 0.22) * edgeBias;
    };

    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      const score = colPeakScore(x, minX);
      if (score > sideLeftStrength) {
        sideLeftStrength = score;
        sideLeftCol = x;
      }
    }
    const sideLeftX = (sideLeftCol > 0 && sideLeftStrength > colNoiseFloor * 1.3)
      ? sideLeftCol / w : null;

    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      const score = colPeakScore(x, maxX);
      if (score > sideRightStrength) {
        sideRightStrength = score;
        sideRightCol = x;
      }
    }
    const sideRightX = (sideRightCol > 0 && sideRightStrength > colNoiseFloor * 1.3)
      ? sideRightCol / w : null;

    // ---- Apex + strap search ----
    const bounds = { minX, minY, maxX, maxY };
    const apexLeftInfo = findCupApexFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow, -1);
    const apexRightInfo = findCupApexFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow, +1);
    const apexLeft = apexLeftInfo ? apexLeftInfo.point : null;
    const apexRight = apexRightInfo ? apexRightInfo.point : null;
    const strapInfo = findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow);

    // ---- Inner-cup top + side-seam top (underarm) — see audit POMs 9, 10, 11 ----
    const innerCupTopInfo = findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow);
    const sideTopLeftInfo = findSideTopFromInk(dark, w, h, bounds, sideLeftCol, chestRow, -1);
    const sideTopRightInfo = findSideTopFromInk(dark, w, h, bounds, sideRightCol, chestRow, +1);

    // ---- Front-view ink endpoints (chest L/R, band L/R, CF top) ----
    // The pipeline already detects chest/band ROWS from ink; walk along those
    // rows to find the ink ENDPOINTS too so chest-left/right and band-left/
    // right snap to actual line ends instead of view-box corners.
    const halfRowBand = Math.max(2, Math.round(bboxH * 0.012));
    const halfColBand = Math.max(2, Math.round(bboxW * 0.018));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandRow  > 0 ? findHorizontalInkBound(dark, w, bandRow,  halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandRow  > 0 ? findHorizontalInkBound(dark, w, bandRow,  halfRowBand, maxX, minX, -1) : -1;
    const underbustLeftPx  = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, minX, maxX, +1) : -1;
    const underbustRightPx = underbustRow > 0 ? findHorizontalInkBound(dark, w, underbustRow, halfRowBand, maxX, minX, -1) : -1;
    const cfTopPx      = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const chestLeftX  = chestLeftPx  > 0 ? chestLeftPx  / w : null;
    const chestRightX = chestRightPx > 0 ? chestRightPx / w : null;
    const bandLeftX   = bandLeftPx   > 0 ? bandLeftPx   / w : null;
    const bandRightX  = bandRightPx  > 0 ? bandRightPx  / w : null;
    const underbustLeftX  = underbustLeftPx  > 0 ? underbustLeftPx  / w : null;
    const underbustRightX = underbustRightPx > 0 ? underbustRightPx / w : null;
    const cfTopY      = cfTopPx      >= 0 ? cfTopPx     / h : null;

    // ---- Back view: center axis + back-center-top + back-center-bottom ----
    // Use the front/back classifier's pick when it produced one. Fall back to
    // "largest non-primary view" only when the classifier is unsure (e.g. one
    // view in the source, or two ambiguous views). These seed back-top /
    // back-bottom for POM 12.
    let backViewIndex = viewClassification.backIndex;
    if (backViewIndex < 0 && viewBoxesPx.length > 1) {
      const candidates = viewBoxesPx
        .map((view, index) => ({ view, index }))
        .filter(item => item.index !== primaryViewIndex)
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0));
      if (candidates.length) backViewIndex = candidates[0].index;
    }
    const backInfo = (backViewIndex >= 0 && viewBoxesPx[backViewIndex])
      ? findBackCenterLandmarks(dark, w, h, viewBoxesPx[backViewIndex])
      : null;
    // Per-view feature pass for the back view. Gives the back view its OWN
    // axis, chest/band rows, side seams, and ink endpoints so back-view
    // anchors can snap to ink instead of view-box proportions. The legacy
    // backInfo above is kept for the panel-top/panel-bottom signal it already
    // produces — both feed seedAnchorsFromDetection.
    const backFeatures = (backViewIndex >= 0 && viewBoxesPx[backViewIndex])
      ? detectFeaturesInViewBox(dark, w, h, viewBoxesPx[backViewIndex])
      : null;
    // Back-panel top/bottom from contour-following at ~22% from the back-view
    // left edge — replaces the hardcoded inView(b, 0.225, 0.439/1.005)
    // (off-image) fallbacks for POM 13.
    const backPanelInfo = (backViewIndex >= 0 && viewBoxesPx[backViewIndex])
      ? findBackPanelEdges(dark, w, h, viewBoxesPx[backViewIndex])
      : null;
    // Back-view strap-top: topmost ink in the back's left strap zone, just
    // above the back chest row. Replaces the hardcoded inView(b, 0.187, 0.405)
    // seed in the back-view seed block — POM 14.
    const backStrapTopInfo = (backViewIndex >= 0 && viewBoxesPx[backViewIndex])
      ? findBackStrapTopFromInk(
          dark, w, h, viewBoxesPx[backViewIndex],
          backFeatures && backFeatures.chestY != null
            ? Math.round(backFeatures.chestY * h)
            : -1
        )
      : null;
    // Back-view side-top: topmost ink at the left-edge column of the back
    // panel. Fixes POM 11 — previously side-top Y came from bChestY (the
    // strongest horizontal row in the back view's top 50%), which locks onto
    // strap hardware rather than the true underarm seam top. Scanning the
    // full height of the left-edge column finds the actual outline start.
    const backSideTopInfo = (backViewIndex >= 0 && viewBoxesPx[backViewIndex])
      ? findSideTopFromInk(
          dark, w, h, viewBoxesPx[backViewIndex],
          viewBoxesPx[backViewIndex].minX + 1,  // left-edge column
          -1,                                    // search full back bbox height
          -1                                     // left side
        )
      : null;

    // ---- Confidence per feature (signal strength / noise floor) ----
    const sigConf = (peak, floor) => clamp01((peak - floor) / Math.max(1, floor * 2));
    const confidence = {
      axis: clamp01(symmetry),
      band: sigConf(bandStrength, rowNoiseFloor),
      chest: chestY != null ? sigConf(chestStrength, rowNoiseFloor) : 0,
      cradle: cradleY != null ? sigConf(cradleStrength, rowNoiseFloor) : 0,
      sideLeft: sideLeftX != null ? sigConf(sideLeftStrength, colNoiseFloor) : 0,
      sideRight: sideRightX != null ? sigConf(sideRightStrength, colNoiseFloor) : 0,
      apexLeft: apexLeftInfo ? apexLeftInfo.confidence : 0,
      apexRight: apexRightInfo ? apexRightInfo.confidence : 0,
      strap: strapInfo ? strapInfo.confidence : 0,
      back: backInfo ? backInfo.confidence : 0,
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.confidence : 0,
      sideTopLeft: sideTopLeftInfo ? sideTopLeftInfo.confidence : 0,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.confidence : 0,
      backPanel: backPanelInfo ? backPanelInfo.confidence : 0,
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.confidence : 0,
    };
    // Overall detection quality: weighted mix of axis symmetry and band/chest
    // strength. Surfaces in the spec-panel header so the TD knows whether to
    // trust the seeds or expect to drag a lot.
    const quality = clamp01(
      0.45 * confidence.axis
      + 0.30 * confidence.band
      + 0.15 * (confidence.chest || 0.25)
      + 0.05 * (confidence.sideLeft || 0)
      + 0.05 * (confidence.sideRight || 0)
    );

    return {
      bbox,
      axisX,
      bandY,
      chestY,
      cradleY,
      sideLeftX,
      sideRightX,
      apexLeft,
      apexRight,
      // Front-view ink endpoints — see "Front-view ink endpoints" pass above.
      chestLeftX,
      chestRightX,
      bandLeftX,
      bandRightX,
      underbustY,
      underbustLeftX,
      underbustRightX,
      underbustRunPx,
      underbustRowPx: underbustRow,
      underbustMinSpanPx: minRowSpan,
      cfTopY,
      strapTop: strapInfo ? strapInfo.top : null,
      strapBottom: strapInfo ? strapInfo.bottom : null,
      back: backInfo,
      backFeatures,
      // Audit-driven extra signals (POMs 9, 10, 11, 13).
      innerCupTop: innerCupTopInfo ? innerCupTopInfo.point : null,
      sideTopLeft:  sideTopLeftInfo  ? sideTopLeftInfo.point  : null,
      sideTopRight: sideTopRightInfo ? sideTopRightInfo.point : null,
      backPanel: backPanelInfo,
      backStrapTop: backStrapTopInfo ? backStrapTopInfo.point : null,
      backSideTop: backSideTopInfo ? backSideTopInfo.point : null,
      coverage: globalStats.count / total,
      primaryCoverage: darkCount / total,
      sampleWidth: w,
      sampleHeight: h,
      threshold,
      luminanceThreshold,
      backgroundLum: Math.round(cvAnalysis.backgroundLum || 255),
      componentCount: filtered.componentCount,
      keptComponentCount: filtered.keptComponents.length,
      views: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      viewBoxes: viewBoxesPx.map((box, index) => {
        const role = viewClassification.roles[index] || 'unknown';
        const legacyRole = role === 'front_outer' ? 'front' : role;
        const score = viewClassification.scores[index] || null;
        return {
          ...normalizeBounds(box, w, h),
          role: legacyRole,
          viewRole: role,
          roleConfidence: score && score.roleConfidence != null
            ? Number(score.roleConfidence.toFixed(3))
            : null,
          centroidX: score ? Number(score.centroidX.toFixed(3)) : null,
          widthRatio: score ? Number(score.widthRatio.toFixed(3)) : null,
        };
      }),
      primaryViewIndex,
      frontViewIndex: viewClassification.frontOuterIndex,
      frontOuterViewIndex: viewClassification.frontOuterIndex,
      frontInnerViewIndex: viewClassification.frontInnerIndex,
      backViewIndex,
      viewRoleReviewRequired: viewClassification.reviewRequired,
      symmetry,
      quality,
      confidence,
      engine: (cvAnalysis.engine || 'offline-vision-legacy-threshold') + '+auto-pom-v3',
      // Non-serializable side channel for the Potrace tracer in
      // runOfflineDetection. Stripped before the detection is stored.
      _mask: dark,
      _maskW: w,
      _maskH: h,
    };
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
    for (let y = 0; y < h; y += step) {
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

  function detectSketchViewBoxes(components, fallbackStats, w, h) {
    if (!components || !components.length) {
      return fallbackStats && fallbackStats.maxX >= 0 ? [statsToBounds(fallbackStats)] : [];
    }
    const largest = components.reduce((m, c) => Math.max(m, c.count), 0);
    const minCount = Math.max(8, largest * 0.04);
    const candidates = components
      .filter(c => c.count >= minCount || c.area >= w * h * 0.002)
      .sort((a, b) => a.minX - b.minX);
    if (!candidates.length) return [statsToBounds(fallbackStats)];

    const groups = [];
    for (const c of candidates) {
      const last = groups[groups.length - 1];
      if (!last) {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
        continue;
      }
      const gap = c.minX - last.maxX;
      const lastW = Math.max(1, last.maxX - last.minX + 1);
      const cW = Math.max(1, c.maxX - c.minX + 1);
      const yOverlap = Math.max(0, Math.min(last.maxY, c.maxY) - Math.max(last.minY, c.minY) + 1);
      const yOverlapRatio = yOverlap / Math.max(1, Math.min(last.maxY - last.minY + 1, c.maxY - c.minY + 1));
      const allowedGap = Math.max(10, Math.min(lastW, cW) * 0.28, w * 0.035);
      const alignedCloseGap = gap <= Math.max(allowedGap, w * 0.08) && yOverlapRatio > 0.55;
      if (gap <= allowedGap || alignedCloseGap) {
        last.minX = Math.min(last.minX, c.minX);
        last.minY = Math.min(last.minY, c.minY);
        last.maxX = Math.max(last.maxX, c.maxX);
        last.maxY = Math.max(last.maxY, c.maxY);
        last.count += c.count;
      } else {
        groups.push({ minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY, count: c.count });
      }
    }
    return groups;
  }

  function choosePrimaryViewBox(viewBoxes, dark, w, h) {
    if (!viewBoxes || !viewBoxes.length) return -1;
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < viewBoxes.length; i += 1) {
      const b = viewBoxes[i];
      const width = Math.max(1, b.maxX - b.minX + 1);
      const height = Math.max(1, b.maxY - b.minY + 1);
      const centroid = (b.minX + b.maxX) / 2;
      const axis = refineAxisBySymmetry(dark, w, b.minX, b.maxX, b.minY, b.maxY, centroid);
      const sym = computeSymmetryScore(dark, w, axis, b.minX, b.maxX, b.minY, b.maxY);
      const center = (b.minX + b.maxX) / 2 / w;
      const centerBonus = 1 - Math.min(1, Math.abs(center - 0.5) * 1.4);
      const shapeBonus = Math.min(1, height / Math.max(1, width)) * 0.18;
      const score = (b.count || 1) * (0.62 + sym * 0.55 + centerBonus * 0.10 + shapeBonus);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    return bestIndex;
  }

  function computeRowSpans(mask, w, minX, maxX, minY, maxY) {
    const spans = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let left = -1, right = -1;
      for (let x = minX; x <= maxX; x += 1) {
        if (!mask[base + x]) continue;
        if (left < 0) left = x;
        right = x;
      }
      spans[y] = left >= 0 ? right - left + 1 : 0;
    }
    return spans;
  }

  // Longest contiguous dark run per row. Solid seam lines have a long single
  // run; dense lace patterns have many short runs at high total density. This
  // is the signal that lets the underbust-seam detector beat the lace band.
  function computeRowMaxRun(mask, w, minX, maxX, minY, maxY) {
    const runs = new Uint32Array(maxY + 1);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let cur = 0, best = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) {
          cur += 1;
          if (cur > best) best = cur;
        } else {
          cur = 0;
        }
      }
      runs[y] = best;
    }
    return runs;
  }

  function countDarkByColumnInRange(mask, w, minX, maxX, minY, maxY) {
    const counts = new Uint32Array(w);
    const y0 = Math.max(0, minY);
    const y1 = Math.max(y0, maxY);
    for (let y = y0; y <= y1; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (mask[base + x]) counts[x] += 1;
      }
    }
    return counts;
  }

  // Walk inward along a horizontal band of rows and return the first column
  // where ink appears. Used to snap chest-left/right (and band-left/right) to
  // the actual ink endpoints instead of view-box edges. halfBand widens the
  // search vertically so a slightly-off chest row still finds the line.
  function findHorizontalInkBound(dark, w, rowCenter, halfBand, fromX, toX, direction) {
    const yLo = Math.max(0, rowCenter - halfBand);
    const yHi = rowCenter + halfBand;
    if (direction > 0) {
      for (let x = fromX; x <= toX; x += 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    } else {
      for (let x = fromX; x >= toX; x -= 1) {
        for (let y = yLo; y <= yHi; y += 1) {
          if (dark[y * w + x]) return x;
        }
      }
    }
    return -1;
  }

  // Walk vertically along a thin column-band and return the first row with
  // ink. Used to snap CF-top to where the cleavage actually begins instead of
  // a hardcoded 4% offset from the view-box top.
  function findVerticalInkBound(dark, w, colCenter, halfBand, fromY, toY, direction) {
    const xLo = Math.max(0, colCenter - halfBand);
    const xHi = colCenter + halfBand;
    if (direction > 0) {
      for (let y = fromY; y <= toY; y += 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    } else {
      for (let y = fromY; y >= toY; y -= 1) {
        const base = y * w;
        for (let x = xLo; x <= xHi; x += 1) {
          if (dark[base + x]) return y;
        }
      }
    }
    return -1;
  }

  // Potrace vector tracer — wraps the singleton Potrace API (potrace.js) into
  // a Promise that takes the ink mask and returns normalized contour paths.
  //
  // Why we trace at all: the row/column peak detector finds straight reference
  // lines well (chest, band, axis), but cup arcs, strap curves and the back
  // hook are curved. Tracing gives real cubic-Bezier control points instead of
  // hand-tuned guesses.
  //
  // Returns: { paths: [{ start: {x,y}, segments: [{type:'C'|'L', c1?, c2?, end}], bbox }], sampleWidth, sampleHeight }
  // All coordinates are normalized to [0,1] of the source image.
  function tracePotraceFromMask(dark, w, h) {
    if (typeof Potrace === 'undefined' || !Potrace || typeof Potrace.process !== 'function') {
      return Promise.resolve(null);
    }
    // Render the binary mask as black ink on white background. Potrace
    // expects a normal raster image; it re-binarises from luminance.
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let p = 0, i = 0; p < dark.length; p += 1, i += 4) {
      const v = dark[p] ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    let url;
    try {
      url = off.toDataURL('image/png');
    } catch (err) {
      console.warn('[Auto Mode] Potrace: cannot encode mask to PNG:', err);
      return Promise.resolve(null);
    }

    // Tracing params tuned for technical-sketch ink: small turdsize so we
    // keep thin strap edges; alphamax 1.0 keeps smooth curves; optcurve so we
    // emit beziers instead of dense polylines.
    Potrace.setParameter({
      turdsize: 4,
      alphamax: 1.0,
      optcurve: true,
      opttolerance: 0.2,
      turnpolicy: 'minority',
    });
    Potrace.loadImageFromUrl(url);

    return new Promise((resolve) => {
      let waited = 0;
      function tick() {
        // potrace.js sets isReady inside img.onload — poll until it flips.
        if (!Potrace.img || !Potrace.img.complete) {
          waited += 1;
          if (waited > 200) { resolve(null); return; } // 4s ceiling
          setTimeout(tick, 20);
          return;
        }
        try {
          Potrace.process(() => {
            try {
              const svg = Potrace.getSVG(1, 'curve');
              const paths = parsePotraceSvgPaths(svg, w, h);
              resolve({ paths, sampleWidth: w, sampleHeight: h });
            } catch (err) {
              console.warn('[Auto Mode] Potrace: SVG parse failed:', err);
              resolve(null);
            }
          });
        } catch (err) {
          console.warn('[Auto Mode] Potrace.process failed:', err);
          resolve(null);
        }
      }
      tick();
    });
  }

  // Parse the SVG that Potrace emits. The SVG contains one <path d="...">
  // built from absolute M / C / L commands (no relatives, no arcs). We split
  // on M to get subpaths, then walk each subpath's commands.
  function parsePotraceSvgPaths(svg, w, h) {
    const match = /<path[^>]*\sd="([^"]+)"/.exec(svg);
    if (!match) return [];
    const d = match[1];
    // Tokens: command letter OR a signed decimal number.
    const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) || [];
    const paths = [];
    let current = null;
    let cursorX = 0, cursorY = 0;
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === 'M') {
        if (current && current.segments.length) paths.push(finalizePath(current, w, h));
        cursorX = num(); cursorY = num();
        current = { start: { x: cursorX, y: cursorY }, segments: [] };
      } else if (t === 'L' && current) {
        const ex = num(); const ey = num();
        current.segments.push({ type: 'L', end: { x: ex, y: ey } });
        cursorX = ex; cursorY = ey;
      } else if (t === 'C' && current) {
        const c1x = num(); const c1y = num();
        const c2x = num(); const c2y = num();
        const ex  = num(); const ey  = num();
        current.segments.push({
          type: 'C',
          c1: { x: c1x, y: c1y },
          c2: { x: c2x, y: c2y },
          end:{ x: ex,  y: ey  },
        });
        cursorX = ex; cursorY = ey;
      } else {
        // Unknown token — number outside a command (shouldn't happen with
        // Potrace's output). Skip.
      }
    }
    if (current && current.segments.length) paths.push(finalizePath(current, w, h));
    return paths;
  }

  function finalizePath(path, w, h) {
    const pts = [path.start, ...path.segments.map(s => s.end)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Normalize to [0,1] over the source image so the consumer doesn't need
    // to know the analysis sample dimensions.
    const norm = (p) => ({ x: p.x / w, y: p.y / h });
    return {
      start: norm(path.start),
      segments: path.segments.map(s => {
        if (s.type === 'C') return { type: 'C', c1: norm(s.c1), c2: norm(s.c2), end: norm(s.end) };
        return { type: 'L', end: norm(s.end) };
      }),
      bbox: {
        x: minX / w,
        y: minY / h,
        width: (maxX - minX) / w,
        height: (maxY - minY) / h,
      },
      pointCount: pts.length,
    };
  }

  // Score how well a traced contour fits the line segment AB. The returned
  // shape contains bezier control points sampled from the matching arc — the
  // POM generator uses these for POM 9 / 10 / 14 instead of guessed S-curves.
  //
  // "preferThin" weights thin contours (real seam lines, strap edges) higher
  // than the bra outline.
  function matchContourForCurve(paths, A, B, options) {
    if (!paths || !paths.length || !A || !B) return null;
    const preferThin = !!(options && options.preferThin);
    const ax = A.x, ay = A.y, bx = B.x, by = B.y;
    const lineLen = Math.hypot(bx - ax, by - ay);
    if (lineLen < 1e-6) return null;
    // Tolerance: how far from the AB line a contour's nearest sample can be.
    const tol = Math.max(0.04, lineLen * 0.35);

    let best = null;
    let bestScore = -Infinity;
    for (const path of paths) {
      if (!path || !path.segments || !path.segments.length) continue;
      const bbox = path.bbox || { width: 1, height: 1 };
      // Reject paths whose bbox can't possibly contain both endpoints.
      const x0 = bbox.x - tol, y0 = bbox.y - tol;
      const x1 = bbox.x + bbox.width + tol, y1 = bbox.y + bbox.height + tol;
      if (ax < x0 || ax > x1 || bx < x0 || bx > x1 ||
          ay < y0 || ay > y1 || by < y0 || by > y1) continue;
      const samples = samplePathPoints(path);
      if (samples.length < 4) continue;
      let nearestA = Infinity, nearestB = Infinity;
      let idxA = -1, idxB = -1;
      for (let i = 0; i < samples.length; i += 1) {
        const dA = Math.hypot(samples[i].x - ax, samples[i].y - ay);
        const dB = Math.hypot(samples[i].x - bx, samples[i].y - by);
        if (dA < nearestA) { nearestA = dA; idxA = i; }
        if (dB < nearestB) { nearestB = dB; idxB = i; }
      }
      if (nearestA > tol || nearestB > tol) continue;
      // Thin contours score higher when preferThin is set — strap edges /
      // seam lines beat the bra outline.
      const aspect = Math.min(bbox.width, bbox.height) / Math.max(1e-6, Math.max(bbox.width, bbox.height));
      const thinness = preferThin ? clamp01(1 - aspect) : 0;
      const proximity = 1 - clamp01((nearestA + nearestB) / (2 * tol));
      const score = proximity * 1.0 + thinness * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { path, samples, idxA, idxB };
      }
    }
    if (!best) return null;

    // Walk the closed contour from idxA → idxB the short way around (the seam
    // is one side of the loop). Sample 4 evenly-spaced points along that arc
    // and fit a cubic bezier to them by setting c1/c2 at the 1/3 and 2/3
    // sample positions.
    const arc = takeShortestArc(best.samples, best.idxA, best.idxB);
    if (arc.length < 4) return null;
    const p1 = arc[Math.floor(arc.length / 3)];
    const p2 = arc[Math.floor((2 * arc.length) / 3)];
    // Clamp output to [0,1] just in case.
    return {
      c1: { x: clamp01(p1.x), y: clamp01(p1.y) },
      c2: { x: clamp01(p2.x), y: clamp01(p2.y) },
      arcLength: arc.length,
      score: bestScore,
    };
  }

  // Convert a path into a flat array of polyline samples. Cubic-segment
  // sampling at 6 points is enough to find the nearest-to-endpoint vertex.
  function samplePathPoints(path) {
    const out = [path.start];
    for (const seg of path.segments) {
      if (seg.type === 'C') {
        const prev = out[out.length - 1];
        for (let t = 0.2; t < 1; t += 0.2) {
          out.push(cubicBezierPoint(prev, seg.c1, seg.c2, seg.end, t));
        }
        out.push(seg.end);
      } else {
        out.push(seg.end);
      }
    }
    return out;
  }

  function cubicBezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const uu = u * u;
    const uuu = uu * u;
    const tt = t * t;
    const ttt = tt * t;
    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    };
  }

  function takeShortestArc(samples, idxA, idxB) {
    if (samples.length === 0) return [];
    const n = samples.length;
    let a = idxA, b = idxB;
    if (a === b) return [samples[a]];
    // Forward arc length idxA→idxB
    const forwardLen = (b - a + n) % n;
    const backwardLen = n - forwardLen;
    const arc = [];
    if (forwardLen <= backwardLen) {
      for (let k = 0; k <= forwardLen; k += 1) arc.push(samples[(a + k) % n]);
    } else {
      for (let k = 0; k <= backwardLen; k += 1) arc.push(samples[(a - k + n) % n]);
    }
    return arc;
  }

  // Per-view feature pass: a self-contained mini-detector that runs inside a
  // single view's bounding box. Used to give the back view its own axis,
  // chest/band rows, side seams, and ink endpoints — so back-view anchors
  // snap to actual ink rather than hardcoded view-box ratios.
  function detectFeaturesInViewBox(dark, w, h, viewBoxPx) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;

    // Local row/column ink counts restricted to the view box.
    const rowDark = new Uint32Array(h);
    const colDark = new Uint32Array(w);
    let count = 0;
    let xSum = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      let rowCount = 0;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) {
          rowCount += 1;
          colDark[x] += 1;
          xSum += x;
          count += 1;
        }
      }
      rowDark[y] = rowCount;
    }
    if (count < 60) return null;
    const centroidX = xSum / count;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);

    // Smoothed peak picks (mirror of the front-view logic).
    const rowSmooth = smooth1D(rowDark);
    const colSmooth = smooth1D(colDark);

    // Band: bottom 40% of the view height, strongest horizontal row.
    const bandStart = Math.round(minY + bh * 0.58);
    let bandRow = -1; let bandStrength = 0;
    for (let y = bandStart; y <= maxY; y += 1) {
      if (rowSmooth[y] > bandStrength) { bandStrength = rowSmooth[y]; bandRow = y; }
    }
    // Chest / top-band: upper 50% of the view height.
    const chestEnd = Math.round(minY + bh * 0.50);
    let chestRow = -1; let chestStrength = 0;
    for (let y = minY + Math.round(bh * 0.06); y <= chestEnd; y += 1) {
      if (rowSmooth[y] > chestStrength) { chestStrength = rowSmooth[y]; chestRow = y; }
    }

    // Side seams: strongest verticals on either side of the axis, with a
    // small guard band so the centerline doesn't win.
    const axisGuard = Math.max(4, Math.round(bw * 0.08));
    let sideLeftCol = -1, sideLeftStrength = 0;
    for (let x = minX + 1; x <= axisPx - axisGuard; x += 1) {
      if (colSmooth[x] > sideLeftStrength) { sideLeftStrength = colSmooth[x]; sideLeftCol = x; }
    }
    let sideRightCol = -1, sideRightStrength = 0;
    for (let x = axisPx + axisGuard; x <= maxX - 1; x += 1) {
      if (colSmooth[x] > sideRightStrength) { sideRightStrength = colSmooth[x]; sideRightCol = x; }
    }

    // Walk inward along chest / band rows to find ink endpoints.
    const halfRowBand = Math.max(2, Math.round(bh * 0.012));
    const chestLeftPx  = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, minX, maxX, +1) : -1;
    const chestRightPx = chestRow > 0 ? findHorizontalInkBound(dark, w, chestRow, halfRowBand, maxX, minX, -1) : -1;
    const bandLeftPx   = bandRow > 0 ? findHorizontalInkBound(dark, w, bandRow,  halfRowBand, minX, maxX, +1) : -1;
    const bandRightPx  = bandRow > 0 ? findHorizontalInkBound(dark, w, bandRow,  halfRowBand, maxX, minX, -1) : -1;

    // Walk down the symmetry axis to find the topmost ink (cleavage / strap
    // notch). halfColBand widens it slightly so a center-line off by 1px
    // still scores.
    const halfColBand = Math.max(2, Math.round(bw * 0.020));
    const axisTopPx = findVerticalInkBound(dark, w, axisPx, halfColBand, minY, maxY, +1);
    const axisBottomPx = findVerticalInkBound(dark, w, axisPx, halfColBand, maxY, minY, -1);

    return {
      bbox: {
        x: minX / w, y: minY / h,
        width: bw / w, height: bh / h,
      },
      axisX: axisPx / w,
      chestY:    chestRow >= 0 ? chestRow / h : null,
      bandY:     bandRow  >= 0 ? bandRow  / h : null,
      sideLeftX: sideLeftCol  > 0 ? sideLeftCol  / w : null,
      sideRightX:sideRightCol > 0 ? sideRightCol / w : null,
      chestLeftX:  chestLeftPx  > 0 ? chestLeftPx  / w : null,
      chestRightX: chestRightPx > 0 ? chestRightPx / w : null,
      bandLeftX:   bandLeftPx   > 0 ? bandLeftPx   / w : null,
      bandRightX:  bandRightPx  > 0 ? bandRightPx  / w : null,
      axisTopY:    axisTopPx    >= 0 ? axisTopPx    / h : null,
      axisBottomY: axisBottomPx >= 0 ? axisBottomPx / h : null,
    };
  }

  function findCupApexFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow, side) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const guard = Math.max(3, Math.round(bboxW * 0.055));
    const y1 = Math.max(bounds.minY, (chestRow > 0 ? chestRow : bounds.minY + Math.round(bboxH * 0.28)) + Math.round(bboxH * 0.03));
    const y2 = Math.min(bounds.maxY, (bandRow > 0 ? bandRow : bounds.maxY) - Math.round(bboxH * 0.08));
    const x1 = side < 0 ? bounds.minX + Math.round(bboxW * 0.03) : axisPx + guard;
    const x2 = side < 0 ? axisPx - guard : bounds.maxX - Math.round(bboxW * 0.03);
    if (x2 <= x1 || y2 <= y1) return null;

    let count = 0;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    let sumX = 0, sumY = 0;
    for (let y = y1; y <= y2; y += 1) {
      const base = y * w;
      for (let x = x1; x <= x2; x += 1) {
        if (!dark[base + x]) continue;
        count += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const regionArea = Math.max(1, (x2 - x1 + 1) * (y2 - y1 + 1));
    if (count < Math.max(8, regionArea * 0.002)) return null;
    const centroidX = sumX / count;
    const centroidY = sumY / count;
    const boxCenterX = (minX + maxX) / 2;
    const boxCenterY = (minY + maxY) / 2;
    const px = boxCenterX * 0.62 + centroidX * 0.38;
    const py = boxCenterY * 0.68 + centroidY * 0.32;
    const density = count / regionArea;
    const confidence = clamp01(0.25 + density * 12 + Math.min(0.25, count / 300));
    return {
      point: { x: px / w, y: py / h },
      confidence,
    };
  }

  function findStrapLandmarksFromInk(dark, w, h, bounds, axisPx, chestRow) {
    const bboxW = bounds.maxX - bounds.minX + 1;
    const bboxH = bounds.maxY - bounds.minY + 1;
    const y1 = bounds.minY;
    const y2 = Math.min(bounds.maxY, chestRow > 0 ? chestRow : bounds.minY + Math.round(bboxH * 0.34));
    if (y2 <= y1 + 3) return null;

    const scanSide = (side) => {
      const x1 = side < 0 ? bounds.minX : axisPx + Math.round(bboxW * 0.08);
      const x2 = side < 0 ? axisPx - Math.round(bboxW * 0.08) : bounds.maxX;
      if (x2 <= x1) return null;
      let count = 0;
      let topY = h, topXSum = 0, topCount = 0;
      let bottomY = -1, bottomXSum = 0, bottomCount = 0;
      for (let y = y1; y <= y2; y += 1) {
        const base = y * w;
        let rowXSum = 0, rowCount = 0;
        for (let x = x1; x <= x2; x += 1) {
          if (!dark[base + x]) continue;
          count += 1;
          rowXSum += x;
          rowCount += 1;
        }
        if (rowCount > 0) {
          if (y < topY) { topY = y; topXSum = rowXSum; topCount = rowCount; }
          if (y > bottomY) { bottomY = y; bottomXSum = rowXSum; bottomCount = rowCount; }
        }
      }
      if (count < Math.max(6, (x2 - x1 + 1) * (y2 - y1 + 1) * 0.0015)) return null;
      return {
        count,
        top: { x: (topXSum / Math.max(1, topCount)) / w, y: topY / h },
        bottom: { x: (bottomXSum / Math.max(1, bottomCount)) / w, y: bottomY / h },
      };
    };

    const left = scanSide(-1);
    const right = scanSide(+1);
    const chosen = right && (!left || right.count >= left.count * 0.85) ? right : left;
    if (!chosen) return null;
    return {
      top: chosen.top,
      bottom: chosen.bottom,
      confidence: clamp01(0.25 + Math.min(0.65, chosen.count / Math.max(1, bboxW * bboxH * 0.03))),
    };
  }

  // Back-view strap-top: walk the left strap zone above the back chest row to
  // find the topmost ink. On a back technical sketch the strap rises from the
  // back-panel top toward the shoulder; the topmost ink in that column is
  // POM 14's start point. Returns null when the strap zone has no ink.
  function findBackStrapTopFromInk(dark, w, h, viewBoxPx, chestRow) {
    if (!viewBoxPx) return null;
    const minX = viewBoxPx.minX;
    const minY = viewBoxPx.minY;
    const maxX = viewBoxPx.maxX;
    const maxY = viewBoxPx.maxY;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw < 16 || bh < 16) return null;
    const yEnd = (chestRow > 0 && chestRow > minY)
      ? Math.min(maxY, chestRow)
      : minY + Math.round(bh * 0.45);
    const xLo = minX + Math.round(bw * 0.05);
    const xHi = minX + Math.round(bw * 0.32);
    if (xHi <= xLo) return null;
    let total = 0;
    for (let y = minY; y <= yEnd; y += 1) {
      const base = y * w;
      let rowCount = 0;
      let rowXSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowCount += 1; rowXSum += x; }
      }
      total += rowCount;
      if (rowCount > 0) {
        const cx = rowXSum / rowCount;
        return {
          point: { x: cx / w, y: y / h },
          confidence: clamp01(0.3 + Math.min(0.55, total / Math.max(1, bw * bh * 0.02))),
        };
      }
    }
    return null;
  }

  // Back-view landmarks. Given the back view's pixel-space bbox, finds:
  //   - the back symmetry axis (vertical line through the center-back seam)
  //   - back-center-top: topmost ink in a thin strip around the axis. On a
  //     U-cutout back this is the bottom of the U; on a closed top this is the
  //     band's top edge.
  //   - back-center-bottom: bottommost ink in the same strip. The band's
  //     bottom edge at center.
  // POM 12 (back center length) is back-center-top → back-center-bottom.
  function findBackCenterLandmarks(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 8 || bboxH < 8) return null;

    let xSum = 0, xWeight = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) { xSum += x; xWeight += 1; }
      }
    }
    if (xWeight === 0) return null;
    const centroidX = xSum / xWeight;
    const axisPx = refineAxisBySymmetry(dark, w, minX, maxX, minY, maxY, centroidX);
    const symmetry = computeSymmetryScore(dark, w, axisPx, minX, maxX, minY, maxY);

    // Strip half-width around the axis. Wide enough to survive a faint U-curve
    // crossing the axis at an angle, narrow enough to skip strap tabs at the
    // top corners.
    const halfStripPx = Math.max(2, Math.round(bboxW * 0.035));
    const xLo = Math.max(minX, axisPx - halfStripPx);
    const xHi = Math.min(maxX, axisPx + halfStripPx);

    let topY = -1;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { topY = y; break; }
      }
    }
    let bottomY = -1;
    for (let y = maxY; y >= minY && bottomY < 0; y -= 1) {
      const base = y * w;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { bottomY = y; break; }
      }
    }
    if (topY < 0 || bottomY < 0) return null;
    const spanPx = bottomY - topY;
    if (spanPx < bboxH * 0.15) return null;

    // Refine X at the top/bottom rows by taking the centroid of ink in the
    // strip on that row. This keeps the point on the actual edge ink instead
    // of pinning to the global symmetry axis when the edge curls slightly.
    const rowCentroid = (y) => {
      const base = y * w;
      let sum = 0, count = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { sum += x; count += 1; }
      }
      return count > 0 ? sum / count : axisPx;
    };
    const topX = rowCentroid(topY);
    const botX = rowCentroid(bottomY);

    return {
      axisX: axisPx / w,
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: bottomY / h },
      symmetry,
      bandHeightFrac: spanPx / Math.max(1, bboxH),
      confidence: clamp01(0.30 + 0.45 * symmetry + Math.min(0.25, spanPx / Math.max(1, bboxH))),
    };
  }

  // Topmost dark pixel in the +/-30% horizontal strip around the axis, BELOW
  // chestRow. This is the high point of the inner-cup construction curves —
  // the audit's anchor for POM 9 (inner cup height) and POM 10 (inner cup
  // width). Returns { point: {x, y}, confidence } in normalized coords.
  function findInnerCupTopFromInk(dark, w, h, bounds, axisPx, chestRow, bandRow) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 12 || bboxH < 12) return null;
    const stripHalf = Math.max(4, Math.round(bboxW * 0.30));
    const xLo = Math.max(minX, axisPx - stripHalf);
    const xHi = Math.min(maxX, axisPx + stripHalf);
    // Skip the chest-row band itself so we don't pin to the chest line ink.
    const guardBelowChest = Math.max(3, Math.round(bboxH * 0.04));
    const yLo = (chestRow > 0 ? chestRow : minY + Math.round(bboxH * 0.30)) + guardBelowChest;
    const yHi = (bandRow > 0 ? bandRow : maxY) - Math.max(4, Math.round(bboxH * 0.10));
    if (yHi <= yLo || xHi <= xLo) return null;
    // Find first row in [yLo, yHi] with at least a few ink pixels in strip.
    const minInkPerRow = Math.max(2, Math.round((xHi - xLo + 1) * 0.05));
    let topY = -1, topX = axisPx, topInk = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let inkCount = 0, xSum = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { inkCount += 1; xSum += x; }
      }
      if (inkCount >= minInkPerRow) {
        topY = y;
        topX = xSum / inkCount;
        topInk = inkCount;
        break;
      }
    }
    if (topY < 0) return null;
    // Confidence scales with how much ink we found on the winning row.
    const confidence = clamp01(0.35 + Math.min(0.45, topInk / Math.max(1, xHi - xLo + 1)));
    return { point: { x: topX / w, y: topY / h }, confidence };
  }

  // Underarm notch on one side: starting at the detected side-seam column,
  // scan upward from chestRow looking for the topmost dark pixel within a
  // small lateral window. The result is the side-top anchor for POM 11.
  function findSideTopFromInk(dark, w, h, bounds, sideCol, chestRow, side) {
    if (sideCol == null || sideCol < 0) return null;
    const { minX, minY, maxX } = bounds;
    const bboxW = maxX - minX + 1;
    const lateralHalf = Math.max(3, Math.round(bboxW * 0.025));
    const xLo = Math.max(minX, sideCol - lateralHalf);
    const xHi = Math.min(maxX, sideCol + lateralHalf);
    const yLo = minY;
    const yHi = chestRow > 0 ? chestRow : bounds.maxY;
    if (yHi <= yLo || xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = yLo; y <= yHi; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) {
        topY = y; topXSum = rowSum; topCount = rowCount;
        break;
      }
    }
    if (topY < 0) return null;
    const topX = topXSum / topCount;
    const confidence = clamp01(0.4 + Math.min(0.4, (chestRow > 0 ? (chestRow - topY) / Math.max(1, bounds.maxY - bounds.minY) : 0) * 1.5));
    return { point: { x: topX / w, y: topY / h }, confidence, side };
  }

  // Back-panel edges: contour-following at ~22% from the back-view's left.
  // The audit calls out the existing inView(b, 0.225, 0.439) and especially
  // inView(b, 0.232, 1.005) — the latter clamps off-image. Find real ink
  // top/bottom along that strip instead.
  function findBackPanelEdges(dark, w, h, bounds) {
    const { minX, minY, maxX, maxY } = bounds;
    const bboxW = maxX - minX + 1;
    const bboxH = maxY - minY + 1;
    if (bboxW < 16 || bboxH < 16) return null;
    // Find the strongest vertical-ink column in the inner 10–45% zone of the
    // back view. This adapts to panel width instead of assuming a fixed 22.5%.
    // A minimum ink count guards against stray dots winning over real seams.
    const searchLo = minX + Math.round(bboxW * 0.10);
    const searchHi = minX + Math.round(bboxW * 0.45);
    const colCounts = new Uint32Array(w);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = searchLo; x <= searchHi; x += 1) {
        if (dark[base + x]) colCounts[x] += 1;
      }
    }
    let bestCol = -1, bestCount = 0;
    for (let x = searchLo; x <= searchHi; x += 1) {
      if (colCounts[x] > bestCount) { bestCount = colCounts[x]; bestCol = x; }
    }
    // Require meaningful ink density — rejects empty strips and stray dots.
    if (bestCol < 0 || bestCount < Math.max(8, Math.round(bboxH * 0.15))) return null;
    const stripCenter = bestCol;
    const stripHalf = Math.max(3, Math.round(bboxW * 0.04));
    const xLo = Math.max(minX, stripCenter - stripHalf);
    const xHi = Math.min(maxX, stripCenter + stripHalf);
    if (xHi <= xLo) return null;
    let topY = -1, topXSum = 0, topCount = 0;
    for (let y = minY; y <= maxY && topY < 0; y += 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { topY = y; topXSum = rowSum; topCount = rowCount; }
    }
    let botY = -1, botXSum = 0, botCount = 0;
    for (let y = maxY; y >= minY && botY < 0; y -= 1) {
      const base = y * w;
      let rowSum = 0, rowCount = 0;
      for (let x = xLo; x <= xHi; x += 1) {
        if (dark[base + x]) { rowSum += x; rowCount += 1; }
      }
      if (rowCount > 0) { botY = y; botXSum = rowSum; botCount = rowCount; }
    }
    if (topY < 0 || botY < 0 || botY <= topY) return null;
    // Reject if the span is implausibly small (likely a stray dot).
    if ((botY - topY) < bboxH * 0.20) return null;
    const topX = topXSum / topCount;
    const botX = botXSum / botCount;
    const confidence = clamp01(0.30 + Math.min(0.45, (botY - topY) / Math.max(1, bboxH)));
    return {
      top: { x: topX / w, y: topY / h },
      bottom: { x: botX / w, y: botY / h },
      confidence,
    };
  }

  // When the connected-component grouping returns ONE bbox that spans a wide
  // chunk of the canvas, the most common reason is that two technical-sketch
  // views (front + back) got merged because stray ink (background texture,
  // lace mesh) connects them through the gap. Detect such a "merged" view by
  // looking for a low-density vertical alley in its middle and, if found,
  // split it into [leftSub, rightSub]. Returns [view] unchanged when no
  // confident alley is detected.
  function splitMergedViewByVerticalValley(dark, w, h, view) {
    const { minX, minY, maxX, maxY } = view;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Require a fairly wide bbox before we even try to split — narrow boxes
    // are almost certainly a single view that just happens to be off-center.
    if (bw < w * 0.50 || bh < 16) return [view];

    // Column density restricted to the view's bbox.
    const colDark = new Uint32Array(bw);
    for (let y = minY; y <= maxY; y += 1) {
      const base = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        if (dark[base + x]) colDark[x - minX] += 1;
      }
    }
    // Walk the center 30..70% range, looking for the LONGEST run of columns
    // whose density is below 8% of the bbox height (i.e. nearly empty).
    const lo = Math.floor(bw * 0.30);
    const hi = Math.floor(bw * 0.70);
    const emptyThreshold = Math.max(1, Math.round(bh * 0.08));
    let bestStart = -1, bestEnd = -1;
    let curStart = -1;
    for (let i = lo; i <= hi; i += 1) {
      if (colDark[i] <= emptyThreshold) {
        if (curStart < 0) curStart = i;
        if (i - curStart > (bestEnd - bestStart)) {
          bestStart = curStart;
          bestEnd = i;
        }
      } else {
        curStart = -1;
      }
    }
    const runLen = bestEnd - bestStart + 1;
    // Need a noticeable alley — at least 4% of the bbox width — before splitting.
    if (bestStart < 0 || runLen < Math.max(4, bw * 0.04)) return [view];

    // Use the MIDDLE of the alley as the split point. Recompute each sub-view's
    // ink-bbox by scanning its columns; this snaps the bbox to the actual ink
    // (so the FRONT/BACK overlay doesn't include the gap or stray ink).
    const splitX = minX + Math.round((bestStart + bestEnd) / 2);
    const subBounds = (xStart, xEnd) => {
      let lMinX = w, lMaxX = -1, lMinY = h, lMaxY = -1, lCount = 0;
      for (let y = minY; y <= maxY; y += 1) {
        const base = y * w;
        for (let x = xStart; x <= xEnd; x += 1) {
          if (!dark[base + x]) continue;
          lCount += 1;
          if (x < lMinX) lMinX = x;
          if (x > lMaxX) lMaxX = x;
          if (y < lMinY) lMinY = y;
          if (y > lMaxY) lMaxY = y;
        }
      }
      return lMaxX < 0 ? null : { minX: lMinX, minY: lMinY, maxX: lMaxX, maxY: lMaxY, count: lCount };
    };
    const left = subBounds(minX, splitX - 1);
    const right = subBounds(splitX + 1, maxX);
    if (!left || !right) return [view];
    // Sanity check the split: each side should hold a non-trivial share of
    // the original ink. Otherwise the alley was probably just a real empty
    // space inside a single view (e.g. a deep V neckline).
    const total = Math.max(1, view.count || (left.count + right.count));
    const minShare = 0.20;
    if (left.count / total < minShare || right.count / total < minShare) return [view];
    return [left, right];
  }

  // Decide each detected garment component's semantic role. Visual features
  // get first vote; layout only breaks ties. This keeps two-view styles
  // working while allowing a third inner-cup/front-lining detail view.
  function classifySketchViewRoles(dark, w, h, viewBoxes) {
    const scores = (viewBoxes || []).map((view) => scoreViewLayout(view, w, dark, h));
    const roles = new Array(scores.length).fill('unknown');
    if (!viewBoxes || !viewBoxes.length) {
      return {
        roles,
        frontOuterIndex: -1,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }
    if (viewBoxes.length === 1) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.55;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: false,
      };
    }

    const largest = viewBoxes.reduce((m, v) => Math.max(m, v.count || 0), 0);
    const minQualifyingCount = Math.max(1, largest * 0.05);
    const eligible = viewBoxes
      .map((view, index) => ({ view, index, score: scores[index] }))
      .filter((item) => (item.view.count || 0) >= minQualifyingCount);
    if (!eligible.length) {
      roles[0] = 'front_outer';
      scores[0].roleConfidence = 0.35;
      return {
        roles,
        frontOuterIndex: 0,
        backIndex: -1,
        frontInnerIndex: -1,
        scores,
        reviewRequired: true,
      };
    }

    const assignBest = (role, metric, exclude) => {
      let best = null;
      for (const item of eligible) {
        if (exclude && exclude.has(item.index)) continue;
        if (!best || item.score[metric] > best.score[metric]) best = item;
      }
      if (!best) return -1;
      roles[best.index] = role;
      return best.index;
    };

    const used = new Set();
    let backIndex = assignBest('back', 'backScore', used);
    if (backIndex >= 0) used.add(backIndex);

    let frontInnerIndex = -1;
    if (eligible.length >= 3) {
      frontInnerIndex = assignBest('front_inner', 'frontInnerScore', used);
      if (frontInnerIndex >= 0) used.add(frontInnerIndex);
    }

    let frontOuterIndex = assignBest('front_outer', 'frontOuterScore', used);
    if (frontOuterIndex < 0) {
      const fallback = eligible
        .filter(item => !used.has(item.index))
        .sort((a, b) => a.score.centroidX - b.score.centroidX)[0] || eligible[0];
      frontOuterIndex = fallback.index;
      roles[frontOuterIndex] = 'front_outer';
    }

    const roleConfidence = (index, metric) => {
      if (index < 0 || !scores[index]) return 0;
      const values = eligible
        .filter(item => item.index !== index)
        .map(item => item.score[metric])
        .sort((a, b) => b - a);
      const runnerUp = values.length ? values[0] : 0;
      return clamp01(0.45 + (scores[index][metric] - runnerUp) * 0.55);
    };
    if (frontOuterIndex >= 0) scores[frontOuterIndex].roleConfidence = roleConfidence(frontOuterIndex, 'frontOuterScore');
    if (backIndex >= 0) scores[backIndex].roleConfidence = roleConfidence(backIndex, 'backScore');
    if (frontInnerIndex >= 0) scores[frontInnerIndex].roleConfidence = roleConfidence(frontInnerIndex, 'frontInnerScore');

    const reviewRequired =
      eligible.length > 3 ||
      eligible.some(item => roles[item.index] === 'unknown') ||
      eligible.some(item => {
        const role = roles[item.index];
        if (role === 'front_outer') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'front_inner') return (scores[item.index].roleConfidence || 0) < 0.52;
        if (role === 'back') return (scores[item.index].roleConfidence || 0) < 0.52;
        return true;
      });

    return { roles, frontOuterIndex, backIndex, frontInnerIndex, scores, reviewRequired };
  }

  // Back-compat wrapper for any older debug/test code that still asks for
  // front/back indexes.
  function classifyViewsAsFrontBack(dark, w, h, viewBoxes) {
    const result = classifySketchViewRoles(dark, w, h, viewBoxes);
    return {
      frontIndex: result.frontOuterIndex,
      backIndex: result.backIndex,
      scores: result.scores,
    };
  }

  function scoreViewLayout(view, w, dark, h) {
    const bw = (view.maxX - view.minX + 1);
    const bh = (view.maxY - view.minY + 1);
    const cx = (view.minX + view.maxX) / 2;
    const ink = view.count || 1;
    let innerInk = 0;
    let edgeInk = 0;
    let centerVerticalInk = 0;
    if (dark && w && h && bw > 0 && bh > 0) {
      const insetX = Math.max(2, Math.round(bw * 0.16));
      const insetY = Math.max(2, Math.round(bh * 0.12));
      const centerLo = Math.round(view.minX + bw * 0.42);
      const centerHi = Math.round(view.minX + bw * 0.58);
      for (let y = view.minY; y <= view.maxY; y += 1) {
        const base = y * w;
        for (let x = view.minX; x <= view.maxX; x += 1) {
          if (!dark[base + x]) continue;
          const inInner = x >= view.minX + insetX && x <= view.maxX - insetX
            && y >= view.minY + insetY && y <= view.maxY - insetY;
          if (inInner) innerInk += 1;
          else edgeInk += 1;
          if (x >= centerLo && x <= centerHi) centerVerticalInk += 1;
        }
      }
    }
    const widthRatio = w > 0 ? bw / w : 0;
    const aspect = bh / Math.max(1, bw);
    const innerRatio = innerInk / ink;
    const edgeRatio = edgeInk / ink;
    const centerVerticalRatio = centerVerticalInk / ink;
    const leftness = 1 - clamp01(cx / Math.max(1, w));
    const rightness = clamp01(cx / Math.max(1, w));
    const symmetry = computeSymmetryScore(
      dark,
      w,
      Math.round(cx),
      view.minX,
      view.maxX,
      view.minY,
      view.maxY
    );
    const frontOuterScore =
      symmetry * 0.34 +
      widthRatio * 0.22 +
      edgeRatio * 0.16 +
      leftness * 0.14 +
      (1 - clamp01(Math.abs(aspect - 1.05))) * 0.14;
    const backScore =
      rightness * 0.30 +
      centerVerticalRatio * 0.24 +
      edgeRatio * 0.20 +
      clamp01(aspect / 1.45) * 0.16 +
      (1 - symmetry) * 0.10;
    const frontInnerScore =
      innerRatio * 0.38 +
      symmetry * 0.18 +
      (1 - edgeRatio) * 0.18 +
      (1 - rightness * 0.45) * 0.10 +
      (1 - clamp01(Math.abs(aspect - 1.0))) * 0.16;
    return {
      centroidX: w > 0 ? cx / w : 0,
      widthRatio,
      count: view.count || 0,
      innerRatio,
      edgeRatio,
      centerVerticalRatio,
      symmetry,
      frontOuterScore,
      backScore,
      frontInnerScore,
      roleConfidence: 0,
    };
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

  // -------- Anchor layer (Phase 2 of the offline engine) --------
  //
  // Anchors live between detection and POM generation. Detect Sketch seeds
  // them with rough positions; the TD drags any wrong ones; the POM
  // generator then reads anchor positions to lay down 16 draft lines.
  // Anchors x/y are normalized [0, 1] in the source image's pixel space, so
  // they travel with the image (pan / zoom / resize / save).

  function seedAnchorsFromDetection(detection, sourceImage, options) {
    if (!detection || !detection.bbox || !sourceImage) return [];

    const views = Array.isArray(detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection.viewBoxes) ? detection.viewBoxes : []);
    // Prefer the explicit front/back classification produced by detection.
    // Older detection blobs (no classifier output) fall back to "primary view
    // is front, largest non-primary is back" so saved projects still load.
    const frontIdx = Number.isFinite(detection.frontViewIndex) && detection.frontViewIndex >= 0
      ? detection.frontViewIndex
      : (Number.isFinite(detection.primaryViewIndex) ? detection.primaryViewIndex : 0);
    const frontView = views[frontIdx] || detection.bbox;
    const frontInnerView = findDetectionViewByRole(detection, 'front_inner');
    let backView = null;
    if (Number.isFinite(detection.backViewIndex) && detection.backViewIndex >= 0) {
      backView = views[detection.backViewIndex] || null;
    } else if (views.length > 1) {
      const fallback = views
        .map((view, index) => ({ view, index }))
        .filter(item => item.index !== frontIdx)
        .sort((a, b) => (b.view.count || 0) - (a.view.count || 0))[0];
      backView = fallback ? fallback.view : null;
    }
    const inView = (view, rx, ry) => ({
      x: clamp01(view.x + view.width * rx),
      y: clamp01(view.y + view.height * ry),
    });
    const roleByKind = Object.create(null);
    for (const schema of ANCHOR_SCHEMA) {
      roleByKind[schema.kind] = defaultViewRoleForAnchorKind(schema.kind);
    }

    const bb = detection.bbox;
    const left  = bb.x;
    const right = bb.x + bb.width;
    const top   = bb.y;
    const halfW = bb.width / 2;
    const ax    = detection.axisX;
    const band  = detection.bandY;
    // Chest fallback: 30% down from bbox top if detection didn't surface one.
    const chest = detection.chestY != null
      ? detection.chestY
      : top + bb.height * 0.30;
    // Cup-bottom (cradle) fallback: midpoint between chest and band.
    const cradle = detection.cradleY != null
      ? detection.cradleY
      : chest + (band - chest) * 0.85;
    // Mid-cup y for inner-cup-width placement.
    const cupMid = chest + (band - chest) * 0.55;

    // Apex offset: prefer the detector's apex finding when available; falls
    // back to ~38% of half-width from the axis.
    const apexDX = halfW * 0.38;
    const apexL = detection.apexLeft  || { x: clamp01(ax - apexDX), y: clamp01(cupMid - (band - chest) * 0.10) };
    const apexR = detection.apexRight || { x: clamp01(ax + apexDX), y: clamp01(cupMid - (band - chest) * 0.10) };

    // Side seams: prefer detected columns; fall back to bbox edges with a
    // small inset so the seed doesn't sit literally on the bbox line.
    const sideL = detection.sideLeftX  != null ? detection.sideLeftX  : clamp01(left  + bb.width * 0.02);
    const sideR = detection.sideRightX != null ? detection.sideRightX : clamp01(right - bb.width * 0.02);

    const det = detection.confidence || {};

    // Inner cup sits on the side with the stronger local cup signal. Default
    // to the left cup because the bundled reference sketch shows it clearly.
    const icSide = (det.apexRight || 0) > (det.apexLeft || 0) + 0.08 ? +1 : -1;
    const icX    = ax + icSide * halfW * 0.12;
    const icHalf = halfW * 0.18;
    const strapTop = detection.strapTop || { x: clamp01(ax + halfW * 0.45), y: clamp01(top + bb.height * 0.01) };
    const strapBottom = detection.strapBottom || { x: clamp01(ax + halfW * 0.30), y: clamp01(chest - (chest - top) * 0.10) };

    let seeds = {
      'cf-top':         { x: ax, y: clamp01(top + bb.height * 0.04) },
      'cf-bottom':      { x: ax, y: clamp01(band) },
      'band-left':      { x: clamp01(left),  y: clamp01(band) },
      'band-right':     { x: clamp01(right), y: clamp01(band) },
      'chest-left':     { x: clamp01(left),  y: clamp01(chest) },
      'chest-right':    { x: clamp01(right), y: clamp01(chest) },
      'inner-cup-top':    { x: clamp01(icX), y: clamp01(chest + (band - chest) * 0.10) },
      'inner-cup-bottom': { x: clamp01(icX + icSide * halfW * 0.02), y: clamp01(cradle) },
      'inner-cup-left':   { x: clamp01(icX - icHalf), y: clamp01(cupMid) },
      'inner-cup-right':  { x: clamp01(icX + icHalf), y: clamp01(cupMid) },
      'side-top':       { x: clamp01(sideR), y: clamp01(chest) },
      'side-bottom':    { x: clamp01(sideR), y: clamp01(band) },
      'apex-left':      { x: clamp01(apexL.x), y: clamp01(apexL.y) },
      'apex-right':     { x: clamp01(apexR.x), y: clamp01(apexR.y) },
      'strap-top':      { x: clamp01(strapTop.x), y: clamp01(strapTop.y) },
      'strap-bottom':   { x: clamp01(strapBottom.x), y: clamp01(strapBottom.y) },
      'back-top':       { x: clamp01(sideL), y: clamp01(chest) },
      'back-bottom':    { x: clamp01(sideL), y: clamp01(band) },
    };

    // Prefer ink-derived inner-cup top / side-top from the audit-driven
    // detectors. Each helper returns null when the signal is too weak, so
    // formula-based fallbacks below still apply.
    const innerCupTopInk = detection.innerCupTop || null;
    const sideTopRightInk = detection.sideTopRight || null;
    const sideTopLeftInk  = detection.sideTopLeft  || null;
    const backPanelInk = detection.backPanel || null;

    if (frontView && frontView.width > 0 && frontView.height > 0) {
      const f = frontView;
      // Prefer ink-derived endpoints (chest L/R, band L/R, CF top) from the
      // detection pass; fall back to view-box ratios when the walker didn't
      // find ink. Ratios come from bra technical-sketch geometry — they map
      // a fitted view box to landmarks a TD usually expects.
      // In a typical flat technical sketch the POM 3 "chest line" is drawn at
      // the cup-bottom seam (underbust ridge), not at the strap-zigzag row.
      // The underbust seam is detected separately via longest-run scoring so
      // dense lace bands don't beat it. Prefer it whenever the detector found
      // a confident seam; fall back to the upper chest row otherwise.
      const chestSeedY = detection.underbustY != null
        ? detection.underbustY
        : (detection.chestY != null ? detection.chestY : (f.y + f.height * 0.615));
      const chestSeedLeftX = detection.underbustLeftX != null
        ? detection.underbustLeftX
        : (detection.chestLeftX != null ? detection.chestLeftX : null);
      const chestSeedRightX = detection.underbustRightX != null
        ? detection.underbustRightX
        : (detection.chestRightX != null ? detection.chestRightX : null);
      const bandYf  = detection.bandY  != null ? detection.bandY  : (f.y + f.height * 0.978);
      const useChestL = chestSeedLeftX  != null ? { x: chestSeedLeftX,  y: chestSeedY } : inView(f, 0.004, 0.615);
      const useChestR = chestSeedRightX != null ? { x: chestSeedRightX, y: chestSeedY } : inView(f, 0.990, 0.605);
      const useBandL  = detection.bandLeftX   != null ? { x: detection.bandLeftX,   y: bandYf  } : inView(f, 0.063, 0.978);
      const useBandR  = detection.bandRightX  != null ? { x: detection.bandRightX,  y: bandYf  } : inView(f, 0.936, 0.978);
      const useCfTop  = detection.cfTopY      != null ? { x: detection.axisX,       y: detection.cfTopY }
                                                      : inView(f, 0.505, 0.485);
      // Prefer detected inner-cup top; fall back to view-box fraction. The
      // detected point already lives on the high arc of the inner-cup curve
      // (audit POM 9 fix).
      const useIcTop = innerCupTopInk
        ? { x: clamp01(innerCupTopInk.x), y: clamp01(innerCupTopInk.y) }
        : inView(f, 0.145, 0.276);
      // POM 10 (inner-cup width) X positions stay where the existing
      // geometry puts them (cup edge → CF axis); the audit only complains
      // about Y placement. When the IC top is detected, raise the width
      // line so it lives at the cup's mid-section instead of the legacy
      // ratio anchored to chest. The X anchors are kept as fallback.
      const icWidthY = innerCupTopInk
        ? clamp01(innerCupTopInk.y + Math.max(0.05, (band - innerCupTopInk.y) * 0.45))
        : null;
      const fallbackIcLeft  = inView(f, 0.022, 0.664);
      const fallbackIcRight = inView(f, 0.496, 0.662);
      const useIcLeft  = icWidthY != null
        ? { x: fallbackIcLeft.x,  y: icWidthY }
        : fallbackIcLeft;
      const useIcRight = icWidthY != null
        ? { x: fallbackIcRight.x, y: icWidthY }
        : fallbackIcRight;
      // Side-top: underarm notch detected by walking up from the side-seam
      // column. Falls back to chest-line height on the side seam.
      const useSideTop = sideTopRightInk
        ? { x: clamp01(sideTopRightInk.x), y: clamp01(sideTopRightInk.y) }
        : { x: clamp01(sideR), y: clamp01(chest) };
      const useApexL = detection.apexLeft
        ? { x: clamp01(detection.apexLeft.x), y: clamp01(detection.apexLeft.y) }
        : inView(f, 0.184, 0.260);
      const useApexR = detection.apexRight
        ? { x: clamp01(detection.apexRight.x), y: clamp01(detection.apexRight.y) }
        : inView(f, 0.815, 0.263);
      // CF-bottom: bandY is the highest-confidence horizontal signal in the
      // pipeline. Prefer (axisX, bandY) over the view-box fraction so POMs 5
      // and 6 land on the actual band ink.
      const useCfBottom = (detection.bandY != null && detection.axisX != null)
        ? { x: clamp01(detection.axisX), y: clamp01(detection.bandY) }
        : inView(f, 0.505, 0.985);
      // Inner-cup-bottom: cradleY is the clean horizontal contour between
      // chest and band. Prefer (axisX, cradleY) so POMs 6, 7, and 9 are seeded
      // on the cradle row instead of a fixed fraction.
      const useIcBottom = (detection.cradleY != null && detection.axisX != null)
        ? { x: clamp01(detection.axisX), y: clamp01(detection.cradleY) }
        : inView(f, 0.227, 0.888);
      // Strap-bottom: prefer the ink-walk landmark from findStrapLandmarksFromInk
      // (POM 14) when available — the top-level seeds block already wires this,
      // but the front-view block previously overwrote it with a fixed fraction.
      const useStrapBot = detection.strapBottom
        ? { x: clamp01(detection.strapBottom.x), y: clamp01(detection.strapBottom.y) }
        : inView(f, 0.895, 0.263);
      seeds = {
        ...seeds,
        'cf-top':          useCfTop,
        'cf-bottom':       useCfBottom,
        'band-left':       useBandL,
        'band-right':      useBandR,
        'chest-left':      useChestL,
        'chest-right':     useChestR,
        'inner-cup-top':   useIcTop,
        'inner-cup-bottom':useIcBottom,
        'inner-cup-left':  useIcLeft,
        'inner-cup-right': useIcRight,
        'side-top':        useSideTop,
        'apex-left':       useApexL,
        'apex-right':      useApexR,
        'strap-bottom':    useStrapBot,
      };
    }

    if (frontInnerView && frontInnerView.width > 0 && frontInnerView.height > 0) {
      const i = frontInnerView;
      const innerBandY = i.y + i.height * 0.92;
      const innerChestY = i.y + i.height * 0.22;
      const innerCupMidY = i.y + i.height * 0.54;
      seeds = {
        ...seeds,
        'inner-cup-top':    inView(i, 0.50, 0.18),
        'inner-cup-bottom': inView(i, 0.50, 0.82),
        'inner-cup-left':   inView(i, 0.20, 0.53),
        'inner-cup-right':  inView(i, 0.80, 0.53),
      };
      roleByKind['inner-cup-top'] = 'front_inner';
      roleByKind['inner-cup-bottom'] = 'front_inner';
      roleByKind['inner-cup-left'] = 'front_inner';
      roleByKind['inner-cup-right'] = 'front_inner';
      if (!detection.innerCupTop) {
        detection.innerCupTop = { x: i.x + i.width * 0.50, y: innerChestY };
      }
      if (detection.cradleY == null) detection.cradleY = innerBandY;
      if (detection.underbustY == null) detection.underbustY = innerCupMidY;
    }

    if (backView && backView.width > 0 && backView.height > 0) {
      const b = backView;
      // Prefer detected back center landmarks (POM 12) over fixed view-box
      // ratios. detection.back is the ink-based pass on the back view.
      const backCenter = detection.back || null;
      const backTop = backCenter && backCenter.top
        ? backCenter.top
        : inView(b, 0.505, 0.769);
      const backBottom = backCenter && backCenter.bottom
        ? backCenter.bottom
        : inView(b, 0.505, 1.000);
      // Per-view back features — sideLeftX/RightX are the back's actual side
      // seams; chestY / chestLeftX / chestRightX trace the upper-back strap
      // line; bandY is the back's bottom band row.
      const bf = detection.backFeatures || null;
      const bChestY = bf && bf.chestY != null ? bf.chestY : (b.y + b.height * 0.42);
      const bBandY  = bf && bf.bandY  != null ? bf.bandY  : (b.y + b.height * 0.97);
      // The back-view "side seam" is the OUTLINE column of the back panel,
      // i.e. the left edge of the back view bbox. detectFeaturesInViewBox can
      // report an interior column with strong vertical ink (the panel-attach
      // seam) — that's wrong for POM 11. Use the back bbox left edge with a
      // tiny inset so the seam reads as snapped-to-ink rather than view-box.
      const bSideL  = b.x + b.width * 0.005;
      const bStrapL = bf && bf.chestLeftX  != null ? { x: bf.chestLeftX,  y: bChestY } : inView(b, 0.276, 0.414);
      const bStrapR = bf && bf.chestRightX != null ? { x: bf.chestRightX, y: bChestY } : inView(b, 0.729, 0.426);
      // Back-panel top/bottom: prefer the ink-following detector. Falls back
      // to view-box ratios; the old inView(b, 0.232, 1.005) used to clamp the
      // bottom anchor off-image — keep the same fraction but clamp at 0.985
      // so the seed lives inside the box even on a partial back view.
      const usePanelTop = backPanelInk && backPanelInk.top
        ? { x: clamp01(backPanelInk.top.x), y: clamp01(backPanelInk.top.y) }
        : inView(b, 0.225, 0.439);
      const usePanelBot = backPanelInk && backPanelInk.bottom
        ? { x: clamp01(backPanelInk.bottom.x), y: clamp01(backPanelInk.bottom.y) }
        : inView(b, 0.232, 0.985);
      // Strap-top (back view): prefer the ink-walk detector that finds the
      // topmost ink in the back's left strap zone. Falls back to the legacy
      // view-box ratio when the detector returns nothing.
      const useBackStrapTop = detection.backStrapTop
        ? { x: clamp01(detection.backStrapTop.x), y: clamp01(detection.backStrapTop.y) }
        : inView(b, 0.187, 0.405);
      // POM 11 side-top: prefer the ink-walk result from findSideTopFromInk
      // on the back left-edge column (backSideTop). Falls back to bChestY
      // (strongest horizontal row) only when no ink was found at the edge.
      const useSideTopY = detection.backSideTop
        ? detection.backSideTop.y
        : bChestY;
      seeds = {
        ...seeds,
        'side-top':          { x: clamp01(bSideL), y: clamp01(useSideTopY) },
        'side-bottom':       { x: clamp01(bSideL), y: clamp01(bBandY) },
        'back-top':          { x: clamp01(backTop.x),    y: clamp01(backTop.y) },
        'back-bottom':       { x: clamp01(backBottom.x), y: clamp01(backBottom.y) },
        'back-panel-top':    usePanelTop,
        'back-panel-bottom': usePanelBot,
        'back-strap-left':   { x: clamp01(bStrapL.x), y: clamp01(bStrapL.y) },
        'back-strap-right':  { x: clamp01(bStrapR.x), y: clamp01(bStrapR.y) },
        'strap-top':         useBackStrapTop,
      };
    }

    // Anchor confidence flows from the underlying detection signal — strong
    // peaks → 'high', weak peaks → 'medium', geometry-only fallbacks → 'low'.
    // Old hardcoded buckets remain as the default when the new fields aren't
    // present (back-compat for any caller that synthesizes a detection).
    const tier = (score, fallback) => {
      if (score == null || score <= 0) return fallback;
      if (score >= 0.5) return 'high';
      if (score >= 0.2) return 'medium';
      return 'low';
    };
    const confByKind = {
      'cf-top':            tier(det.axis, 'medium'),
      'cf-bottom':         tier(det.band, 'high'),
      'band-left':         tier(det.band, 'high'),
      'band-right':        tier(det.band, 'high'),
      'chest-left':        tier(det.chest, 'medium'),
      'chest-right':       tier(det.chest, 'medium'),
      // Inner-cup top: prefer the new ink-derived detector; fall back to the
      // older chest-rooted heuristic.
      'inner-cup-top':     innerCupTopInk ? tier(det.innerCupTop, 'medium') : tier(det.chest, 'medium'),
      'inner-cup-bottom':  tier(det.cradle, 'medium'),
      'inner-cup-left':    innerCupTopInk ? tier(det.innerCupTop, 'medium') : 'medium',
      'inner-cup-right':   innerCupTopInk ? tier(det.innerCupTop, 'medium') : 'medium',
      'side-top':          sideTopRightInk ? tier(det.sideTopRight, 'medium') : tier(det.sideRight, 'medium'),
      'side-bottom':       tier(det.sideRight, 'medium'),
      'apex-left':         tier(det.apexLeft, 'medium'),
      'apex-right':        tier(det.apexRight, 'medium'),
      'strap-top':         backView
                             ? tier(det.backStrapTop, 'low')
                             : tier(det.strap, 'low'),
      'strap-bottom':      tier(det.strap, 'medium'),
      'back-top':          tier(det.back, 'low'),
      'back-bottom':       tier(det.back, 'low'),
      'back-panel-top':    backPanelInk ? tier(det.backPanel, 'medium') : (backView ? 'medium' : 'low'),
      'back-panel-bottom': backPanelInk ? tier(det.backPanel, 'medium') : (backView ? 'medium' : 'low'),
      'back-strap-left':   backView ? 'medium' : 'low',
      'back-strap-right':  backView ? 'medium' : 'low',
    };

    const list = [];
    for (const schema of ANCHOR_SCHEMA) {
      const seed = seeds[schema.kind];
      if (!seed) continue;
      list.push({
        id: createUniqueAnnotationId(),
        kind: schema.kind,
        name: schema.name,
        group: schema.group,
        x: seed.x,
        y: seed.y,
        sourceImageId: sourceImage.id,
        viewRole: roleByKind[schema.kind] || defaultViewRoleForAnchorKind(schema.kind),
        confidence: confByKind[schema.kind] || 'medium',
        autoFilled: true,
      });
    }
    // Learning-loop hook: when enabled, nudge each seeded anchor by the
    // median (detected → corrected) residual recorded from past TD drags.
    // No-op when learning is off or a bucket has fewer than the minimum
    // samples. The geometric rules above are not changed.
    //
    // Phase 2 shadow runs pass { skipLearning: true } so the residual is
    // computed against the unbiased prediction, never against an already-
    // biased one (which would compound the error and make the median drift).
    if (options && options.skipLearning) return list;
    return applyLearningBiasToAnchors(list);
  }

  function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }

  function findDetectionViewByRole(detection, role) {
    const views = Array.isArray(detection && detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection && detection.viewBoxes) ? detection.viewBoxes : []);
    return views.find(v => v && (v.viewRole === role || v.role === role)) || null;
  }

  function defaultViewRoleForAnchorKind(kind) {
    if (/^back-|^back$/.test(kind)) return 'back';
    if (kind === 'side-top' || kind === 'side-bottom') return 'back';
    if (kind.indexOf('inner-cup-') === 0) return 'front_outer';
    return 'front_outer';
  }

  function resetAnchorsToDetection() {
    const detection = state.autoMode.detection;
    if (!detection) {
      showToast('Run Detect Sketch first.');
      return;
    }
    const sourceImage = getImageById(detection.sourceImageId) || pickAutoSourceImage();
    if (!sourceImage) {
      showToast('No source image for the current detection.');
      return;
    }
    state.autoMode.anchors = seedAnchorsFromDetection(detection, sourceImage);
    state.autoMode.anchorSelectedId = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Anchors reset from detection.');
  }

  function getAnchorById(id) {
    return state.autoMode.anchors.find(a => a.id === id) || null;
  }

  function getAnchorByKind(kind) {
    return state.autoMode.anchors.find(a => a.kind === kind) || null;
  }

  function anchorWorldPos(anchor) {
    const image = getImageById(anchor.sourceImageId);
    if (!image) return null;
    return {
      x: image.x + anchor.x * image.width,
      y: image.y + anchor.y * image.height,
    };
  }

  function hitTestAnchors(world) {
    if (state.appMode !== 'auto' || !state.autoMode.anchors.length) return null;
    const radiusWorld = 9 / Math.max(state.zoom, 0.1); // 9px screen
    let best = null;
    let bestDist = Infinity;
    for (const anchor of state.autoMode.anchors) {
      const pos = anchorWorldPos(anchor);
      if (!pos) continue;
      const dx = world.x - pos.x;
      const dy = world.y - pos.y;
      const d = Math.hypot(dx, dy);
      if (d <= radiusWorld && d < bestDist) {
        best = anchor;
        bestDist = d;
      }
    }
    return best;
  }

  function startAnchorDrag(anchorId, world) {
    const before = snapshotFingerprint(makeSnapshot());
    const anchor = getAnchorById(anchorId);
    state.interaction = {
      type: 'drag-anchor',
      id: anchorId,
      prevWorld: world,
      changed: false,
      beforeFingerprint: before,
      // Snapshot the anchor's pre-drag normalized position so onMouseUp
      // can compute the (detected → corrected) residual exactly once
      // per commit, regardless of how the mouse moved in between.
      learnOrigin: anchor ? { kind: anchor.kind, x: anchor.x, y: anchor.y } : null,
    };
    document.body.classList.add('grabbing');
  }
