// US-109 Auto Seam — edge band: the strip just inside a garment edge, read
// per image column along a measured contour (top/bottom ink profiles); the
// triangle-wave verifier that separates a zigzag binding from plain lines,
// scalloped edges and fills; and the geometry taken from the band's own ink
// envelope. Zone- and lane-independent. Pure. Source part for app.js.

  // Topmost ink row per column inside the garment box, median-smoothed over
  // five columns so one anti-aliased gap in a thin outline cannot spike it.
  // -1 where a column has no ink at all.
  function autoSeamTopInkProfile(model, bounds, fromBottom = false) {
    const { width, mask } = model;
    const raw = new Float32Array(width).fill(-1);
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      if (fromBottom) {
        for (let y = bounds.bottom; y >= bounds.top; y -= 1) {
          if (mask[y * width + x]) { raw[x] = y; break; }
        }
      } else {
        for (let y = bounds.top; y <= bounds.bottom; y += 1) {
          if (mask[y * width + x]) { raw[x] = y; break; }
        }
      }
    }
    const profile = new Float32Array(width).fill(-1);
    for (let x = bounds.left; x <= bounds.right; x += 1) {
      // US-120: named medianWindow (was `window`) so the worker-purity gate in
      // scripts/check.mjs can tell a local array from the DOM global.
      const medianWindow = [];
      for (let dx = -2; dx <= 2; dx += 1) {
        const value = raw[Math.max(bounds.left, Math.min(bounds.right, x + dx))];
        if (value >= 0) medianWindow.push(value);
      }
      if (!medianWindow.length) continue;
      medianWindow.sort((a, b) => a - b);
      profile[x] = medianWindow[Math.floor(medianWindow.length / 2)];
    }
    return profile;
  }

  // ---- Edge band: the strip just inside a garment edge, measured along the
  // local inward normal (not per image column, so steep flanks are handled).
  // For a seed that carries `edge` (outward direction hint + inset), each of
  // ~1 px-spaced stations along the seed records where the garment edge
  // actually is on the normal (first mask hit scanning from outside) and where
  // the first crisp ink inside the strip [lo, hi] beyond that edge is — the
  // binding's envelope. Crisp ink is luma <= bgLuma - 55 rather than the
  // foreground mask so anti-aliasing does not widen strokes into the stats.
  // Stations walk the measured contour itself (one per image column, tangent
  // from the neighbouring contour points) rather than the quadratic seed: a
  // parabola through three contour points can sit 20+ px off a real neckline
  // between them, which is exactly what made stations invalid on image5.png's
  // flanks. The quadratic seed is still what the corridor/gradient evidence
  // uses; the edge band only needs the true edge.
  function autoSeamEdgeBandProfile(model, seed) {
    const { width, height, mask, luma, bgLuma } = model;
    const bounds = seed.edge.bounds;
    const rules = AUTO_SEAM_THRESHOLDS.technicalFlat.edgeBand;
    const lo = Math.max(3, Math.round(bounds.height * rules.lo));
    // Real bindings sit 1.8–2.5% of box height inside the outline; the band
    // reaches deeper so a drawing with a gap between outline and stitch is
    // still read. The first-ink rule means a deeper band changes nothing where
    // a nearer structure exists.
    const hi = Math.max(lo + 2, Math.round(bounds.height * rules.hi));
    const inkCut = bgLuma - rules.inkCutBelowBackground;
    // Top/bottom contours are scanned straight down/up the image column. A
    // normal-direction scan was tried and rejected: rounding diagonal sample
    // points skips pixels of a 1–2 px zigzag stroke, so the band offset jumps
    // to the next structure and a triangle wave reads as spurious reversals
    // (zigzag flips 0.24 → 0.54, ink share 1.0 → 0.76 on the pilot corpus).
    // Column scanning visits every row exactly once, and the band pixel it
    // finds is literally on the stroke, so the geometry built from it is exact
    // too. Left/right (vertical) edges would need the row-scanning twin.
    const dir = -Math.sign(seed.edge.outward.y) || 1;
    const inward = { x: 0, y: dir };
    const buildStations = contour => {
      const stations = [];
      for (let index = 0; index < contour.length; index += 1) {
        const base = contour[index];
        const x = Math.round(base.x);
        const edgeRow = Math.round(base.y);
        // Column scanning is only trustworthy where the edge is not steep: on
        // a ~55° flank a 3 px outline stroke spans 5 px vertically. Such
        // stations can still supply display geometry but stay out of evidence.
        const before = contour[Math.max(0, index - 3)];
        const after = contour[Math.min(contour.length - 1, index + 3)];
        const slope = Math.abs(after.y - before.y) / Math.max(1, Math.abs(after.x - before.x));
        const evaluable = slope <= rules.steepSlope;
        let valid = x >= 0 && x < width;
        if (valid) {
          valid = false;
          for (let offset = -2; offset <= 2 && !valid; offset += 1) {
            const y = edgeRow + offset;
            if (y >= 0 && y < height && mask[y * width + x]) valid = true;
          }
        }
        let bandTop = NaN;
        if (valid) {
          const ink = dy => {
            const y = edgeRow + dir * dy;
            return y >= 0 && y < height && luma[y * width + x] <= inkCut;
          };
          let dy = lo;
          if (ink(lo)) {
            // The scan started inside the outline's own stroke (thick outline
            // or a slight slope): step past that stroke and the following gap.
            while (dy <= hi && ink(dy)) dy += 1;
            while (dy <= hi && !ink(dy)) dy += 1;
          } else {
            while (dy <= hi && !ink(dy)) dy += 1;
          }
          if (dy <= hi) bandTop = dy;
        }
        stations.push({ t: index / Math.max(1, contour.length - 1), base, inward, edge: 0, valid, evaluable, bandTop });
      }
      return stations;
    };
    const stations = buildStations(seed.edge.contour);
    const geometryStations = seed.edge.geometryContour ? buildStations(seed.edge.geometryContour) : stations;
    return { stations, geometryStations, lo, hi };
  }

  // Zigzag-vs-plain-vs-scallop on the edge band's ink envelope. A zigzag
  // binding is a triangle wave: consecutive steps run monotonically for
  // several stations before reversing, and there are almost no flat runs. A
  // plain second line jitters ±1 px around a constant offset (nearly every
  // step reverses, many zero steps). A scalloped/picot edge also reverses
  // rarely but has flat arc tops, so flat share separates it from zigzag.
  // Measured on the real fixtures before this was written (flips / flat,
  // per side): plain — image3 neckline 0.97/0.54, image3+photo4 hems
  // 0.86–0.90/0.69–0.71; zigzag — photo4 neckline 0.28/0.22, image5 neckline
  // 0.23/0.19; scallop — image5 hem 0.29–0.33/0.58–0.72. Categorical gaps,
  // not tuned cuts. Limitation: the binding must be the first crisp ink
  // inside the edge; a straight guide line between edge and zigzag reads as
  // plain, and on a colour-filled flat the fill itself reads as ink.
  function autoSeamEdgeBandEvidence(profile) {
    const rules = AUTO_SEAM_THRESHOLDS.technicalFlat.edgeBand;
    const inRange = profile.stations.filter(station => station.t >= rules.evaluateFrom && station.t <= rules.evaluateTo);
    const evaluableStations = inRange.filter(station => station.evaluable);
    const series = evaluableStations.map(station => (station.valid ? station.bandTop : NaN));
    let inkStations = 0, steps = 0, flat = 0, smooth = 0, flips = 0, signed = 0, previousSign = 0;
    // Zero-step runs: a zigzag tooth apex is flat for at most (stroke width
    // - 1) columns, a scallop arc top for many, a straight line for all.
    let flatRun = 0, longFlat = 0, maxFlatRun = 0;
    const closeRun = () => { if (flatRun >= rules.flatRunMin) longFlat += flatRun; maxFlatRun = Math.max(maxFlatRun, flatRun); flatRun = 0; };
    for (let index = 0; index < series.length; index += 1) {
      if (!Number.isNaN(series[index])) inkStations += 1;
      if (index === 0 || Number.isNaN(series[index]) || Number.isNaN(series[index - 1])) { closeRun(); continue; }
      const delta = series[index] - series[index - 1];
      steps += 1;
      if (delta === 0) { flat += 1; flatRun += 1; continue; }
      closeRun();
      if (Math.abs(delta) <= rules.smoothStepMax) smooth += 1;
      const sign = Math.sign(delta);
      if (previousSign && sign !== previousSign) flips += 1;
      if (previousSign) signed += 1;
      previousSign = sign;
    }
    closeRun();
    return {
      contourBindingEvaluableShare: inRange.length ? evaluableStations.length / inRange.length : 0,
      contourBindingInkShare: series.length ? inkStations / series.length : 0,
      contourBindingFlatShare: steps ? flat / steps : 1,
      contourBindingFlatRunShare: steps ? longFlat / steps : 1,
      contourBindingMaxFlatRun: Math.min(1, maxFlatRun / rules.maxFlatRunNormalizer),
      contourBindingSmoothShare: steps ? smooth / steps : 0,
      contourBindingFlipShare: signed ? flips / signed : 1,
    };
  }

  // Triangle-wave test. Measured on the pilot corpus with the runtime's own
  // pipeline (evaluable columns only, outline stroke skipped), per side:
  //   zigzag  — photo4 neckline flips .27/.27, flatRun≥4 share .00/.00,
  //             longest flat run 2/2, smooth .76/.71; image5 neckline
  //             .24/.23, .00/.00, 3/2, .73/.79
  //   scallop — image5 hem flips .25/.28 (a periodic structure too) but
  //             flatRun≥4 share .11/.17 and longest flat run 9/10: arc tops
  //             are flat for many columns, zigzag apexes for at most the
  //             stroke width
  //   plain   — image3 neckline flips .94/.95; image3/photo4 hems ink .39–.46
  // Flip share separates zigzag from plain, flat-run length separates it from
  // scallop, ink share from single lines and dot fills. Categorical gaps, not
  // tuned cuts; still TBC — TD calibrated like every threshold in this file.
  function autoSeamEdgeBandPasses(evidence) {
    const rules = AUTO_SEAM_THRESHOLDS.technicalFlat.edgeBand;
    const gate = rules.gate;
    return evidence.contourBindingEvaluableShare >= gate.evaluableMin
      && evidence.contourBindingInkShare >= gate.inkMin
      && evidence.contourBindingFlipShare <= gate.flipMax
      && evidence.contourBindingFlatRunShare <= gate.flatRunShareMax
      && evidence.contourBindingMaxFlatRun <= gate.maxFlatRunMax / rules.maxFlatRunNormalizer
      && evidence.contourBindingSmoothShare >= gate.smoothMin;
  }

  // Geometry straight from the edge band: the binding centerline is the edge
  // plus a moving median of the envelope offset (the envelope oscillates
  // between the teeth's near and far extremes, so its median sits on the
  // stroke's center) plus half a stroke. Because the strip starts `lo` px
  // inside the edge, the solid outline can no longer capture the trace on
  // steep flanks the way the raw-gradient refinement did.
  function autoSeamEdgeBandGeometry(model, profile, zone) {
    const { lo, hi } = profile;
    const stations = profile.geometryStations || profile.stations;
    const rules = AUTO_SEAM_THRESHOLDS.technicalFlat.edgeBand;
    const window = rules.geometryWindow;
    const tracedPoints = stations.map((station, index) => {
      const local = [];
      for (let offset = -window; offset <= window; offset += 1) {
        const neighbour = stations[index + offset];
        if (neighbour && neighbour.valid && Number.isFinite(neighbour.bandTop)) local.push(neighbour.bandTop);
      }
      local.sort((a, b) => a - b);
      const bandOffset = local.length ? local[Math.floor(local.length / 2)] : (lo + hi) / 2;
      const centerline = station.edge + bandOffset + rules.geometryHalfStroke;
      return { x: station.base.x + station.inward.x * centerline, y: station.base.y + station.inward.y * centerline };
    });
    return autoSeamGeometryFromTechnicalTrace(model, tracedPoints, zone);
  }
