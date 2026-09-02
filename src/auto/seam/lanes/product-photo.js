// US-109 Auto Seam — Product Photo Seam Lane (ADR 0083): template seeds,
// the P0 adaptive zone/pair gates, refinement-based geometry and the lane
// analyzer. P0 output authority: underbust_band, neckline, armhole. Pure.
// Source part for app.js.

  function autoSeamSeedPaths(eligibility) {
    const b = eligibility.pixelBounds;
    const axisLocal = eligibility.centerAxisX;
    const axisInBox = autoSeamClamp01((axisLocal - eligibility.bounds.left) / Math.max(0.0001, eligibility.bounds.right - eligibility.bounds.left));
    const left = [
      // The lower-band Zigzag is a separate, nearly level stitch row. Keep its
      // seed below the curved cup-to-band construction edge; pixel refinement
      // may nudge it locally but must not inherit the cup seam's center drop.
      // Evidence sampling stays inside the garment so the silhouette edge
      // cannot impersonate the stitch. Output geometry is extended separately
      // after the lane passes its evidence gate.
      { zone: 'underbust_band', side: 'left', points: [[0.08, 0.93], [0.28, 0.93], [axisInBox, 0.93]] },
      // Neckline Zigzag follows the curved binding from strap to center front.
      // Evidence uses a broad semantic corridor; output geometry below adds
      // the two independent cubic controls needed for the vertical strap
      // tangent and smooth inward bend.
      { zone: 'neckline', side: 'left', points: [[0.13, 0.26], [0.24, 0.39], [axisInBox, 0.65]] },
      // Armhole binding runs from the strap attachment outward and down along
      // the garment silhouette. The old seed curved inward into the cup, so
      // strong cup texture could validate a path whose geometry never touched
      // the armhole seam it claimed to represent.
      { zone: 'armhole', side: 'left', points: [[0.11, 0.26], [0.02, 0.43], [-0.03, 0.59]] },
    ];
    const right = left.map(seed => ({
      zone: seed.zone,
      side: 'right',
      points: seed.points.map(([x, y]) => [2 * axisInBox - x, y]),
    }));
    return left.concat(right).map(seed => ({
      zone: seed.zone,
      side: seed.side,
      points: seed.points.map(([x, y]) => autoSeamLocalPoint(b, x, y)),
    }));
  }

  // Zone gates; the numbers and the pilot observations behind them live in
  // thresholds.js (AUTO_SEAM_THRESHOLDS.productPhoto.zone).
  function autoSeamZoneEvidencePass(zone, evidence) {
    const zones = AUTO_SEAM_THRESHOLDS.productPhoto.zone;
    if (zone === 'underbust_band') {
      const gate = zones.underbust_band;
      return evidence.corridorDiagonalShare >= gate.diagonalShare
        && evidence.corridorDiagonalBalance >= gate.balance
        && evidence.corridorTwoSidedCoverage >= gate.twoSided
        && evidence.diagonalAlternation >= gate.diagonalAlternation
        && evidence.overall >= gate.overall;
    }
    if (zone === 'armhole') {
      // Armhole stitches in the approved pilot are blurred by binding texture:
      // raw diagonal share is weaker than the cup texture that caused the
      // false path. The real binding instead has dense bilateral corridor
      // coverage with strongly balanced diagonal directions along the
      // semantic outer-edge path.
      const gate = zones.armhole;
      return evidence.corridorDiagonalShare >= gate.diagonalShare
        && evidence.corridorDiagonalBalance >= gate.balance
        && evidence.corridorTwoSidedCoverage >= gate.twoSided
        && evidence.diagonalAlternation >= gate.diagonalAlternation
        && evidence.overall >= gate.overall;
    }
    // The TD-confirmed neckline binding is visibly blurred. It is
    // characterized by balanced, continuous corridor evidence but low
    // pointwise diagonal energy; crisp decorative motifs in the negative
    // photos produce much higher energy and are deliberately excluded.
    const gate = zones.neckline;
    return evidence.overall >= gate.overall
      && evidence.continuity >= gate.continuity
      && evidence.diagonalEnergy >= gate.diagonalEnergyMin
      && evidence.diagonalEnergy <= gate.diagonalEnergyMax
      && evidence.diagonalAlternation >= gate.diagonalAlternation
      && evidence.corridorDiagonalShare >= gate.diagonalShare
      && evidence.corridorDiagonalBalance >= gate.balance;
  }

  function autoSeamPairEvidencePass(zone, paired) {
    if (zone !== 'underbust_band') return true;
    const gate = AUTO_SEAM_THRESHOLDS.productPhoto.pair.underbust_band;
    const evidence = paired.map(candidate => candidate.confidence);
    const minimum = key => Math.min(...evidence.map(item => item[key]));
    const average = key => evidence.reduce((sum, item) => sum + item[key], 0) / evidence.length;
    // Underbust is judged as one bilateral construction row. One side may be
    // weaker because of the center closure or lighting, but both must occupy
    // the same lower stitch lane and the pair must clear the aggregate rule.
    return minimum('corridorDiagonalShare') >= gate.diagonalShare
      && minimum('corridorDiagonalBalance') >= gate.balance
      && minimum('corridorTwoSidedCoverage') >= gate.twoSided
      && average('overall') >= gate.overallAverage;
  }

  function analyzeAutoSeamProductPhoto(sourceImage, model, eligibility, inputClass) {
    const result = autoSeamBaseResult(inputClass, eligibility, 'product_photo', 'auto-seam-product-photo/2');
    if (!eligibility.eligible) {
      result.abstentions.push(autoSeamImageAbstention(AUTO_SEAM_ABSTENTIONS.ineligibleView, eligibility.code));
      return result;
    }

    const gradients = model.garmentGradients;
    const lowGradient = autoSeamPercentile(gradients, 0.52);
    const highGradient = autoSeamPercentile(gradients, 0.72);
    const seeds = autoSeamSeedPaths(eligibility);
    const proposals = [];
    for (const seed of seeds) {
      const polygon = autoSeamCorridorPolygon(model, seed);
      result.automaticRois.push({
        id: `automatic-roi-${seed.zone}-${seed.side}`,
        zone: seed.zone,
        side: seed.side,
        polygon,
        transform: autoSeamRoiTransform(model, polygon),
        source: 'automatic',
        reviewRequired: true,
      });
      const refined = autoSeamRefinePath(model, seed, highGradient);
      const evidence = {
        ...autoSeamEvidence(refined, lowGradient, highGradient),
        ...autoSeamCorridorEvidence(model, seed, lowGradient),
      };
      // Adaptive detector parameters, not release/accuracy thresholds. The
      // latter remain TBC — TD calibrated and are evaluated outside runtime.
      const adaptive = AUTO_SEAM_THRESHOLDS.productPhoto.adaptive;
      if (evidence.overall < adaptive.overallMin || evidence.continuity < adaptive.continuityMin
          || (!['armhole', 'neckline'].includes(seed.zone)
            && (evidence.diagonalEnergy < adaptive.diagonalEnergyMin || evidence.diagonalAlternation < adaptive.diagonalAlternationMin))
          || !autoSeamZoneEvidencePass(seed.zone, evidence)) {
        result.abstentions.push(autoSeamZoneAbstention(seed.zone, seed.side,
          AUTO_SEAM_ABSTENTIONS.insufficientEvidence,
          'source-pixel zigzag evidence did not pass the P0 adaptive proposal gate',
          evidence));
        continue;
      }
      const geometry = autoSeamGeometryFromRefinement(model, refined, seed.zone);
      const { start, end } = geometry;
      if (seed.zone === 'underbust_band') {
        // Detection deliberately avoids the silhouette and center closure,
        // but the editable draft must cover the whole visible seam segment.
        // Extend only after evidence passes, and preserve a bilateral gap over
        // the closure instead of drawing one false continuous seam through it.
        const centerClearance = (eligibility.bounds.right - eligibility.bounds.left) * AUTO_SEAM_THRESHOLDS.productPhoto.underbustCenterClearance;
        start.x = seed.side === 'left' ? eligibility.bounds.left : eligibility.bounds.right;
        end.x = eligibility.centerAxisX + (seed.side === 'left' ? -centerClearance : centerClearance);
      }
      const roi = result.automaticRois[result.automaticRois.length - 1];
      proposals.push({
        id: `candidate-${seed.zone}-${seed.side}`,
        stitchType: 'zigzag',
        semanticZone: seed.zone,
        zone: seed.zone,
        zoneStatus: 'resolved',
        side: seed.side,
        rawGeometry: clone(geometry),
        geometry: clone(geometry),
        geometrySource: 'raw_observation',
        roiId: roi.id,
        roiTransform: clone(roi.transform),
        evidenceStatus: 'observed',
        evidenceProvenance: [
          autoSeamPass(AUTO_SEAM_PASSES.sourceBackgroundMask, 'support'),
          autoSeamPass(AUTO_SEAM_PASSES.adaptiveContinuity, 'pass'),
          autoSeamPass(AUTO_SEAM_PASSES.zigzagPeriodicity, 'pass'),
        ],
        supportingPasses: [AUTO_SEAM_PASSES.sourceBackgroundMask, AUTO_SEAM_PASSES.adaptiveContinuity, AUTO_SEAM_PASSES.zigzagPeriodicity],
        symmetryResult: { status: 'independent', counterpartCandidateId: null },
        confidence: evidence,
        reviewRequired: true,
      });
    }
    for (const zone of autoSeamPhotoOutputZones()) {
      const paired = proposals.filter(candidate => candidate.zone === zone);
      if (paired.length === 2 && new Set(paired.map(candidate => candidate.side)).size === 2
          && autoSeamPairEvidencePass(zone, paired)) {
        for (const candidate of paired) {
          const counterpart = paired.find(item => item.side !== candidate.side);
          candidate.symmetryResult = {
            status: 'corroborated',
            counterpartCandidateId: counterpart.id,
          };
          candidate.evidenceProvenance.push(autoSeamPass(AUTO_SEAM_PASSES.pairedSideCorroboration, 'support'));
          candidate.supportingPasses.push(AUTO_SEAM_PASSES.pairedSideCorroboration);
        }
        result.candidates.push(...paired);
        continue;
      }
      for (const candidate of paired) {
        result.abstentions.push(autoSeamZoneAbstention(candidate.zone, candidate.side,
          AUTO_SEAM_ABSTENTIONS.asymmetricEvidence,
          'the paired side did not pass the fail-closed Zigzag proposal gate',
          candidate.confidence));
      }
    }
    return result;
  }
