// US-109 Auto Seam — Technical Flat Seam Lane (ADR 0083). Coarse mask and
// classification happen at 640 px; seam evidence is sampled in source-scaled
// analysis space up to 1600 px. Seeds come from the garment's own top/bottom
// ink contour where a zone has one (neckline, underbust) and from the
// proportional template otherwise; edge-seeded zones are decided by the
// edge-band triangle-wave test (edge-band.js), template zones by corridor
// gates. Pure. Source part for app.js.

  // Neckline seeds read from this garment's own upper ink contour. Between the
  // two straps nothing is drawn above the neckline, so the topmost ink in each
  // column IS the neckline edge. The proportional template below guessed that
  // edge at ~0.49 of the box height; on image5.png's tall mesh insert the real
  // edge sat ~110 px — five times the refinement search radius — higher, and
  // the corridor passed its gate on mesh-dot texture instead. The strap
  // junction x still comes from the template (strap placement varies far less
  // than neckline depth), nudged inward past any strap top the profile shows.
  // Each point is then pushed a small distance along the inward normal: the
  // zigzag binding is drawn just inside the outline, not on it (17–24 px on
  // the three real fixtures ≈ 2–2.5% of box height), and 2.5% keeps the
  // outline itself outside the search radius while the binding stays inside.
  // Returns null when the profile does not read as a strapped front view, and
  // the caller keeps the template.
  function autoSeamTechnicalFlatNecklineSeeds(model, eligibility, axisInBox) {
    const b = eligibility.pixelBounds;
    const contourRules = AUTO_SEAM_THRESHOLDS.technicalFlat.contour;
    const profile = autoSeamTopInkProfile(model, b);
    const axisX = Math.round(b.left + axisInBox * b.width);
    const strapCeiling = b.top + b.height * contourRules.strapCeiling;
    const isNeckline = x => x >= b.left && x <= b.right && profile[x] >= strapCeiling;
    if (!isNeckline(axisX)) return null;
    const median = x => {
      const values = [];
      for (let dx = -3; dx <= 3; dx += 1) {
        const value = profile[Math.max(b.left, Math.min(b.right, x + dx))];
        if (value >= 0) values.push(value);
      }
      values.sort((a, c) => a - c);
      return values[Math.floor(values.length / 2)];
    };
    const bindingOffset = b.height * contourRules.bindingInset;
    const inward = x => {
      const y = median(x);
      const slope = (median(Math.min(b.right, x + 5)) - median(Math.max(b.left, x - 5))) / 10;
      const length = Math.hypot(1, slope);
      return { x: x - (slope / length) * bindingOffset, y: y + bindingOffset / length };
    };
    const slopeAt = col => Math.abs(median(Math.min(b.right, col + 3)) - median(Math.max(b.left, col - 3))) / 6;
    const traceOverlapContour = (side, reliableX) => {
      const xInBox = side === 'left'
        ? contourRules.overlapJunctionX
        : 2 * axisInBox - contourRules.overlapJunctionX;
      const outerX = Math.round(b.left + xInBox * b.width);
      if (Math.abs(reliableX - outerX) < b.width * contourRules.overlapMinXGap) return null;
      const step = side === 'left' ? 1 : -1;
      const inkCut = model.bgLuma - AUTO_SEAM_THRESHOLDS.technicalFlat.edgeBand.inkCutBelowBackground;
      const maxRise = Math.max(2, Math.round(b.height * contourRules.overlapTraceRise));
      const maxFall = Math.max(maxRise + 2, Math.round(b.height * contourRules.overlapTraceFall));
      // `outerX` still passes through the full-height shoulder strap, so the
      // top-ink profile there is the strap top, not its lower junction. Start
      // near the lower strap edge and let the constrained ink walk lock onto
      // the outline that the neckline binding follows.
      let previousY = b.top + b.height * contourRules.overlapJunctionY;
      const traced = [];
      for (let col = outerX; step > 0 ? col < reliableX : col > reliableX; col += step) {
        const runs = [];
        let runStart = null;
        const fromY = Math.max(b.top, Math.round(previousY - maxRise));
        const toY = Math.min(b.bottom, Math.round(previousY + maxFall));
        for (let row = fromY; row <= toY + 1; row += 1) {
          const ink = row <= toY && model.luma[row * model.width + col] <= inkCut;
          if (ink && runStart === null) runStart = row;
          if (!ink && runStart !== null) {
            runs.push({ start: runStart, end: row - 1, mid: (runStart + row - 1) / 2 });
            runStart = null;
          }
        }
        if (runs.length) {
          // The uppermost reachable stroke is the solid neckline outline. A
          // nearer/lower choice can jump onto the zigzag itself and then make
          // the edge-band scan fall through to mesh dots underneath it.
          previousY = runs[0].mid;
        }
        traced.push({ x: col, y: previousY });
      }
      return traced;
    };
    const build = side => {
      const toward = side === 'left' ? 1 : -1;
      // Find the reliable top-contour section by walking outward until it turns
      // into the steep strap edge. On overlapping constructions (photo4), the
      // true neckline continues below that topmost solid edge; edge geometry
      // gets a separately snapped junction endpoint below, while evidence stays
      // on this trustworthy contour section.
      const innerStart = Math.round(axisX - toward * b.width * contourRules.innerStart);
      const outerLimit = side === 'left' ? b.left + 3 : b.right - 3;
      let x = innerStart;
      while ((toward > 0 ? x - toward > outerLimit : x - toward < outerLimit)
          && isNeckline(x - toward) && slopeAt(x - toward) <= contourRules.junctionSlopeMax) x -= toward;
      x += toward * Math.round(b.width * contourRules.junctionInset);
      if (!isNeckline(x) || (toward > 0 ? axisX - x : x - axisX) < b.width * contourRules.minSpan) return null;
      const start = inward(x);
      const end = inward(axisX);
      const mid = inward(Math.round((x + axisX) / 2));
      // Quadratic through start/end whose t=0.5 point is the measured mid contour.
      const control = { x: 2 * mid.x - 0.5 * (start.x + end.x), y: 2 * mid.y - 0.5 * (start.y + end.y) };
      const contour = [];
      for (let col = x; toward > 0 ? col <= axisX : col >= axisX; col += toward) contour.push({ x: col, y: median(col) });
      const overlapContour = traceOverlapContour(side, x);
      const geometryContour = overlapContour ? overlapContour.concat(contour) : null;
      return {
        zone: 'neckline', side, points: [start, control, end], seedSource: 'mask_top_contour',
        edge: { outward: { x: 0, y: -1 }, inset: bindingOffset, bounds: b, contour, geometryContour },
      };
    };
    const left = build('left');
    const right = build('right');
    return left && right ? [left, right] : null;
  }

  // Underbust seeds from the garment's bottom ink contour, the mirror of the
  // neckline case: below the hem nothing is drawn, so the bottom-most ink per
  // column is the hem edge, and the binding (if any) sits just inside it.
  // The template's 0.05-of-width start is kept for x; y comes from the
  // contour. Both sides end on the center axis.
  function autoSeamTechnicalFlatHemSeeds(model, eligibility, axisInBox) {
    const b = eligibility.pixelBounds;
    const contourRules = AUTO_SEAM_THRESHOLDS.technicalFlat.contour;
    const profile = autoSeamTopInkProfile(model, b, true);
    const axisX = Math.round(b.left + axisInBox * b.width);
    const hemFloor = b.bottom - b.height * contourRules.hemFloor;
    const isHem = x => x >= b.left && x <= b.right && profile[x] >= hemFloor;
    if (!isHem(axisX)) return null;
    const median = x => {
      const values = [];
      for (let dx = -3; dx <= 3; dx += 1) {
        const value = profile[Math.max(b.left, Math.min(b.right, x + dx))];
        if (value >= 0) values.push(value);
      }
      values.sort((a, c) => a - c);
      return values[Math.floor(values.length / 2)];
    };
    const bindingOffset = b.height * contourRules.bindingInset;
    const inward = x => {
      const y = median(x);
      const slope = (median(Math.min(b.right, x + 5)) - median(Math.max(b.left, x - 5))) / 10;
      const length = Math.hypot(1, slope);
      return { x: x + (slope / length) * bindingOffset, y: y - bindingOffset / length };
    };
    const build = side => {
      const toward = side === 'left' ? 1 : -1;
      const startInBox = side === 'left' ? contourRules.hemStartInBox : 2 * axisInBox - contourRules.hemStartInBox;
      let x = Math.round(b.left + startInBox * b.width + toward * b.width * contourRules.hemOuterMargin);
      const limit = Math.round(axisX - toward * b.width * contourRules.minSpan);
      while (!isHem(x) && (toward > 0 ? x < limit : x > limit)) x += toward;
      if (!isHem(x)) return null;
      const start = inward(x);
      const end = inward(axisX);
      const mid = inward(Math.round((x + axisX) / 2));
      const control = { x: 2 * mid.x - 0.5 * (start.x + end.x), y: 2 * mid.y - 0.5 * (start.y + end.y) };
      const contour = [];
      for (let col = x; toward > 0 ? col <= axisX : col >= axisX; col += toward) contour.push({ x: col, y: median(col) });
      return {
        zone: 'underbust_band', side, points: [start, control, end], seedSource: 'mask_bottom_contour',
        edge: { outward: { x: 0, y: 1 }, inset: bindingOffset, bounds: b, contour },
      };
    };
    const left = build('left');
    const right = build('right');
    return left && right ? [left, right] : null;
  }

  // ---- Zone registry: one row says everything the lane needs about a zone.
  // Order matters — ROIs and candidate ordinals follow it (all left sides,
  // then all right sides). `points` are proportions of the garment box for
  // the left side ('axis' resolves to the center axis column); the right side
  // is the mirror across the axis. `seed` names a builder in
  // AUTO_SEAM_TF_SEED_BUILDERS; a contour-seeded row falls back to its
  // template when the contour cannot be read, and then `fallbackVerifier`
  // applies instead of `verifier` (names in AUTO_SEAM_TF_VERIFIERS). The zone
  // list must equal autoSeamTechnicalFlatOutputZones() in contract.js — the
  // analyzer asserts it, so adding a zone here without the contract fails
  // loudly instead of silently drifting the 14-ROI invariant.
  const AUTO_SEAM_TF_ZONES = [
    { zone: 'shoulder_strap', seed: 'template', points: [[0.115, 0.02], [0.115, 0.18], [0.115, 0.327]], verifier: 'templateDefault', merge: 'pair' },
    { zone: 'neckline', seed: 'topContour', points: [[0.115, 0.327], [0.25, 0.42], ['axis', 0.493]], verifier: 'edgeBand', fallbackVerifier: 'templateNeckline', merge: 'bilateral' },
    { zone: 'armhole', seed: 'template', points: [[0.115, 0.327], [0.04, 0.50], [-0.028, 0.647]], verifier: 'armhole', merge: 'pair' },
    { zone: 'cup_edge', seed: 'template', points: [[0.21, 0.51], [0.18, 0.72], [0.28, 0.91]], verifier: 'templateDefault', merge: 'pair' },
    { zone: 'cup_seam', seed: 'template', points: [[0.22, 0.50], [0.38, 0.61], [0.46, 0.89]], verifier: 'templateDefault', merge: 'pair' },
    { zone: 'underbust_band', seed: 'bottomContour', points: [[0.05, 0.92], [0.28, 0.93], ['axis', 0.91]], verifier: 'edgeBand', fallbackVerifier: 'templateDefault', merge: 'pair' },
    { zone: 'side_seam', seed: 'template', points: [[0.0, 0.65], [0.02, 0.78], [0.08, 0.96]], verifier: 'templateDefault', merge: 'pair' },
  ];

  // Contour seed builders. Each returns [leftSeed, rightSeed] carrying
  // `edge` (so the edge band applies), or null when the contour does not read
  // as that edge — then the registry row's template is used for both sides.
  const AUTO_SEAM_TF_SEED_BUILDERS = {
    topContour: autoSeamTechnicalFlatNecklineSeeds,
    bottomContour: autoSeamTechnicalFlatHemSeeds,
  };

  function autoSeamTechnicalFlatSeeds(model, eligibility) {
    const b = eligibility.pixelBounds;
    const axisInBox = autoSeamClamp01((eligibility.centerAxisX - eligibility.bounds.left)
      / Math.max(0.0001, eligibility.bounds.right - eligibility.bounds.left));
    const resolve = ([x, y]) => [x === 'axis' ? axisInBox : x, y];
    const templateSeed = (row, side) => ({
      zone: row.zone,
      side,
      points: row.points.map(resolve).map(([x, y]) => autoSeamLocalPoint(b, side === 'left' ? x : 2 * axisInBox - x, y)),
      seedSource: 'proportional_template',
    });
    const contourSeeds = new Map();
    for (const row of AUTO_SEAM_TF_ZONES) {
      const builder = AUTO_SEAM_TF_SEED_BUILDERS[row.seed];
      if (builder) contourSeeds.set(row.zone, builder(model, eligibility, axisInBox));
    }
    const seeds = [];
    for (const side of ['left', 'right']) {
      for (const row of AUTO_SEAM_TF_ZONES) {
        const contour = contourSeeds.get(row.zone);
        seeds.push(contour ? contour.find(item => item.side === side) : templateSeed(row, side));
      }
    }
    return seeds;
  }

  // Corridor floors shared by every branch below.
  function autoSeamCorridorFloorsPass(evidence, gate) {
    return evidence.pathSupport >= gate.pathSupport
      && evidence.continuity >= gate.continuity
      && evidence.diagonalEnergy >= gate.diagonalEnergy
      && (gate.diagonalAlternation === undefined || evidence.diagonalAlternation >= gate.diagonalAlternation)
      && evidence.corridorDiagonalBalance >= gate.balance
      && (gate.lateralActivity === undefined || evidence.lateralActivity >= gate.lateralActivity)
      && (gate.twoSidedMax === undefined || evidence.corridorTwoSidedCoverage <= gate.twoSidedMax);
  }

  // Verifiers a registry row can name. Numbers and their measurements live in
  // thresholds.js (AUTO_SEAM_THRESHOLDS.technicalFlat.gates).
  //  - edgeBand: for edge-seeded zones the edge-band triangle-wave test
  //    decides, because the corridor features cannot tell a zigzag binding
  //    from the mesh-dot fill under every neckline in the corpus (image3's
  //    plain neckline scored 0.88 balance / 0.55 two-sided, the same as the
  //    real ones), the corridor's 97 stations undersample a ~10 px zigzag,
  //    and its rounded diagonal sampling skips thin strokes. Corridor
  //    features stay as sanity floors.
  //  - armhole: a high-balance branch handles center-straddling bindings;
  //    a bounded low-two-sided branch handles edge-hugging bindings like
  //    photo4 without admitting image3's plain or image2's filled outlines.
  //  - templateDefault: pathSupport alone cannot separate a partly-blurred
  //    real zigzag from a strong plain-line false positive;
  //    corridorTwoSidedCoverage does.
  //  - templateNeckline: the template-seeded neckline fallback.
  const AUTO_SEAM_TF_VERIFIERS = {
    edgeBand: evidence => autoSeamCorridorFloorsPass(evidence, AUTO_SEAM_THRESHOLDS.technicalFlat.gates.edgeSeeded)
      && autoSeamEdgeBandPasses(evidence),
    templateNeckline: evidence => autoSeamCorridorFloorsPass(evidence, AUTO_SEAM_THRESHOLDS.technicalFlat.gates.templateNeckline),
    armhole: evidence => autoSeamCorridorFloorsPass(evidence, AUTO_SEAM_THRESHOLDS.technicalFlat.gates.armhole)
      || autoSeamCorridorFloorsPass(evidence, AUTO_SEAM_THRESHOLDS.technicalFlat.gates.armholeEdge),
    templateDefault: evidence => autoSeamCorridorFloorsPass(evidence, AUTO_SEAM_THRESHOLDS.technicalFlat.gates.templateDefault),
  };

  function autoSeamTechnicalFlatEvidencePass(row, seed, evidence) {
    const verifier = seed.edge ? row.verifier : (row.fallbackVerifier || row.verifier);
    return AUTO_SEAM_TF_VERIFIERS[verifier](evidence);
  }

  function autoSeamOffsetTechnicalPoints(points, offset) {
    if (!offset) return points;
    return points.map((point, index) => {
      const before = points[Math.max(0, index - 1)];
      const after = points[Math.min(points.length - 1, index + 1)];
      const tx = after.x - before.x;
      const ty = after.y - before.y;
      const length = Math.max(0.0001, Math.hypot(tx, ty));
      return { x: point.x - ty / length * offset, y: point.y + tx / length * offset };
    });
  }

  function autoSeamTechnicalCandidate(model, roi, seed, evidence, refined, edgeProfile, ordinal,
      appearanceType = 'zigzag', selectedOffset = 0) {
    // Do not use each station's single strongest edge directly: on a
    // technical flat it jumps between individual zigzag teeth, binding edges,
    // and dot fills. For edge-seeded zones the geometry is the edge band's own
    // envelope centerline (autoSeamEdgeBandGeometry); otherwise
    // autoSeamSmoothedStationPoints median-filters the refinement jitter back
    // to the corridor's centerline. Either way the drawn line tracks this
    // garment, not the seed's generic template.
    const stationPoints = autoSeamOffsetTechnicalPoints(
      autoSeamSmoothedStationPoints(seed, refined), selectedOffset);
    const rawGeometry = edgeProfile && appearanceType === 'zigzag'
      ? autoSeamEdgeBandGeometry(model, edgeProfile, seed.zone)
      : autoSeamGeometryFromTechnicalTrace(model, stationPoints, seed.zone);
    const passes = [
      autoSeamPass(AUTO_SEAM_PASSES.nativeRoiSobel, 'pass'),
      autoSeamPass(AUTO_SEAM_PASSES.pathContinuity, 'support'),
    ];
    if (appearanceType === 'zigzag') {
      passes.push(autoSeamPass(AUTO_SEAM_PASSES.shortDiagonalAlternation, 'pass'));
      if (edgeProfile) passes.push(autoSeamPass(AUTO_SEAM_PASSES.edgeBandTriangleWave, 'pass'));
    } else {
      passes.push(autoSeamPass(AUTO_SEAM_PASSES.technicalFlatPattern, 'pass'));
    }
    const resolvedAppearance = appearanceType === 'zigzag' || appearanceType === 'solid_plain';
    return {
      id: `candidate-technical-flat-${seed.zone}-${seed.side}-${appearanceType}-${ordinal}`,
      appearanceType,
      stitchType: appearanceType === 'zigzag' ? 'zigzag' : appearanceType === 'solid_plain' ? 'plain' : null,
      classificationStatus: resolvedAppearance ? 'resolved' : 'unresolved',
      semanticZone: seed.zone,
      zone: seed.zone,
      zoneStatus: 'resolved',
      side: seed.side,
      rawGeometry: clone(rawGeometry),
      geometry: clone(rawGeometry),
      geometrySource: edgeProfile && appearanceType === 'zigzag'
        ? 'edge_band_trace' : 'source_supported_structural_fit',
      roiId: roi.id,
      roiTransform: clone(roi.transform),
      evidenceStatus: 'observed',
      evidenceProvenance: passes,
      supportingPasses: passes.map(pass => pass.passId),
      symmetryResult: { status: 'independent', counterpartCandidateId: null },
      confidence: evidence,
      reviewRequired: true,
    };
  }

  function autoSeamSketchOutlineDiagnostics(model, eligibility) {
    const b = eligibility.pixelBounds;
    const top = autoSeamTopInkProfile(model, b);
    const bottom = autoSeamTopInkProfile(model, b, true);
    let supportedColumns = 0;
    let longestGap = 0;
    let gap = 0;
    for (let x = b.left; x <= b.right; x += 1) {
      const supported = top[x] >= 0 && bottom[x] >= 0 && bottom[x] >= top[x];
      if (supported) {
        supportedColumns += 1;
        gap = 0;
      } else {
        gap += 1;
        longestGap = Math.max(longestGap, gap);
      }
    }
    const columns = Math.max(1, b.right - b.left + 1);
    const boundaryContinuity = supportedColumns / columns;
    return {
      source: 'source_pixels',
      status: boundaryContinuity >= 0.90 ? 'available' : 'review',
      boundaryContinuity,
      longestEnvelopeGap: autoSeamClamp01(longestGap / columns),
      centerAxisX: eligibility.centerAxisX,
      leftRightSymmetryRatio: eligibility.symmetryRatio,
      emitsCandidate: false,
    };
  }

  function autoSeamTechnicalFlatRegistryMatchesContract() {
    const contractZones = autoSeamTechnicalFlatOutputZones();
    return contractZones.length === AUTO_SEAM_TF_ZONES.length
      && contractZones.every((zone, index) => zone === AUTO_SEAM_TF_ZONES[index].zone);
  }

  function analyzeAutoSeamTechnicalFlat(sourceImage, coarseModel, coarseEligibility, inputClass) {
    if (!autoSeamTechnicalFlatRegistryMatchesContract()) {
      throw new Error('technical-flat zone registry disagrees with autoSeamTechnicalFlatOutputZones()');
    }
    const rows = new Map(AUTO_SEAM_TF_ZONES.map(row => [row.zone, row]));
    const model = autoSeamPixelModel(sourceImage, 1600);
    const eligibility = autoSeamEligibility(model, { minimumCoverage: 0.012 });
    const result = autoSeamBaseResult(inputClass, eligibility, 'technical_flat',
      'auto-seam-technical-flat/2', 'auto-seam-candidate/3');
    if (!eligibility.eligible) {
      result.abstentions.push(autoSeamImageAbstention(AUTO_SEAM_ABSTENTIONS.ineligibleView, eligibility.code));
      return result;
    }
    const gradients = model.garmentGradients;
    const lowGradient = autoSeamPercentile(gradients, 0.52);
    const highGradient = autoSeamPercentile(gradients, 0.72);
    const proposals = [];
    let ordinal = 0;
    const seeds = autoSeamTechnicalFlatSeeds(model, eligibility);
    result.diagnostics.necklineSeedSource = seeds.find(seed => seed.zone === 'neckline').seedSource;
    result.diagnostics.sketchOutline = autoSeamSketchOutlineDiagnostics(model, eligibility);
    for (const seed of seeds) {
      const row = rows.get(seed.zone);
      const polygon = autoSeamCorridorPolygon(model, seed);
      const roi = {
        id: `automatic-roi-technical-flat-${seed.zone}-${seed.side}`,
        zone: seed.zone,
        side: seed.side,
        polygon,
        transform: autoSeamRoiTransform(model, polygon),
        source: 'automatic',
        seedSource: seed.seedSource,
        reviewRequired: true,
      };
      result.automaticRois.push(roi);
      const refined = autoSeamRefinePath(model, seed, highGradient, 97);
      const edgeProfile = seed.edge ? autoSeamEdgeBandProfile(model, seed) : null;
      const evidence = {
        ...autoSeamEvidence(refined, lowGradient, highGradient),
        ...autoSeamCorridorEvidence(model, seed, lowGradient),
        ...(edgeProfile ? autoSeamEdgeBandEvidence(edgeProfile) : {}),
      };
      if (!autoSeamTechnicalFlatEvidencePass(row, seed, evidence)) {
        // A zigzag can expose two periodically dark rails when the main
        // verifier abstains (notably a narrow strap). Do not relabel that
        // unresolved zigzag topology as a dashed pair. Non-zigzag lines have
        // low lateral edge motion even when their dash endpoints contribute
        // high diagonal alternation.
        const unresolvedZigzagTopology = evidence.corridorDiagonalShare >= 0.55
          && evidence.diagonalAlternation >= 0.50;
        const pattern = unresolvedZigzagTopology
          ? { appearanceType: null }
          : autoSeamTechnicalPatternEvidence(model, seed, refined);
        const patternRules = AUTO_SEAM_THRESHOLDS.technicalFlat.pattern;
        if (pattern.appearanceType
            && evidence.pathSupport >= patternRules.pathSupport
            && evidence.continuity >= patternRules.continuity) {
          const patternEvidence = {
            ...evidence,
            patternInkOccupancy: pattern.patternInkOccupancy,
            patternRunCount: pattern.patternRunCount,
            patternPeriodicity: pattern.patternPeriodicity,
            patternPairSpacing: pattern.patternPairSpacing,
            patternPairAlignment: pattern.patternPairAlignment,
          };
          proposals.push(autoSeamTechnicalCandidate(model, roi, seed, patternEvidence,
            refined, null, ++ordinal, pattern.appearanceType, pattern.selectedOffset));
          continue;
        }
        const plainBinding = edgeProfile && !autoSeamEdgeBandPasses(evidence);
        result.abstentions.push(autoSeamZoneAbstention(seed.zone, seed.side,
          AUTO_SEAM_ABSTENTIONS.insufficientEvidence,
          plainBinding
            ? 'edge band did not form a supported Plain, Dashed, Parallel Dashed, or Zigzag path'
            : 'source pixels did not form a supported Plain, Dashed, Parallel Dashed, or Zigzag path',
          evidence));
        continue;
      }
      proposals.push(autoSeamTechnicalCandidate(model, roi, seed, evidence, refined, edgeProfile, ++ordinal));
    }

    for (const row of AUTO_SEAM_TF_ZONES) {
      const paired = proposals.filter(candidate => candidate.semanticZone === row.zone);
      const left = paired.find(candidate => candidate.side === 'left');
      const right = paired.find(candidate => candidate.side === 'right');
      if (row.merge === 'bilateral' && left && right && left.appearanceType === right.appearanceType) {
        const rawGeometry = autoSeamBilateralGeometry(left, right);
        result.candidates.push({
          ...left,
          id: `candidate-technical-flat-${row.zone}-bilateral-1`,
          side: 'bilateral',
          rawGeometry: clone(rawGeometry),
          geometry: clone(rawGeometry),
          roiIds: [left.roiId, right.roiId],
          evidenceProvenance: left.evidenceProvenance.concat([
            autoSeamPass(AUTO_SEAM_PASSES.centerFrontContinuity, 'pass'),
          ]),
          supportingPasses: left.supportingPasses.concat([AUTO_SEAM_PASSES.centerFrontContinuity]),
          symmetryResult: { status: 'independent', counterpartCandidateId: null },
          confidence: Object.fromEntries(Object.keys(left.confidence).map(key =>
            [key, (left.confidence[key] + right.confidence[key]) / 2])),
        });
        continue;
      }
      if (left && right && left.appearanceType === right.appearanceType) {
        left.symmetryResult = { status: 'corroborated', counterpartCandidateId: right.id };
        right.symmetryResult = { status: 'corroborated', counterpartCandidateId: left.id };
      }
      result.candidates.push(...paired);
    }
    result.diagnostics.coarseAnalysisSize = { width: coarseModel.width, height: coarseModel.height };
    result.diagnostics.nativeRoiAnalysisSize = { width: model.width, height: model.height };
    result.diagnostics.coarseEligibility = {
      coverage: coarseEligibility.coverage,
      symmetryRatio: coarseEligibility.symmetryRatio ?? null,
    };
    return result;
  }
