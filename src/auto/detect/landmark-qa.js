// Landmark QA layer (Engineering Workflow Phase 6). Source part for app.js.
// Run `npm run build` after editing.
//
// A landmark is a technical point with meaning (apex, band-left, cradle-cf-top);
// an anchor is its normalized, draggable representation on the board. This
// layer sits between them: it classifies every anchor-schema kind on a finished
// detection object — where the point came from, how much to trust it, and why —
// BEFORE anchor placement reads it. seedAnchorsFromDetection consumes these
// verdicts instead of recomputing its own, so a weak landmark can never become
// a confident anchor through table drift.
//
// The tier / provenance / review predicates here are the exact logic that
// lived in seed-anchors.js (moved, not changed) — Phase 2-style structural
// refactor, so anchors, drafts, and golden output are identical.
//
// Vocabulary (Engineering Workflow, stage 7):
//   sourceClass  detected  — direct ink / seam / silhouette evidence
//                derived   — built from other landmarks (inferred cup model)
//                projected — extended or guessed (seam projection, ratio seed)
//                missing   — no seed will be placed; the POM demotes to review
//   (anchors nudged by the learning loop are re-tagged 'learned' at seed time —
//   that is an anchor-stage fact, so it lives on the anchor record, not here.)
//
// This function only READS the detection object — it never mutates it, places
// no coordinates, and applies no learning bias.

  // Semantic bra part for a landmark kind (Engineering Workflow Phase 5
  // vocabulary, consumed by the Phase 8 learning context). This is the
  // "engine speaks bra construction language" mapping: which named part of
  // the garment the landmark belongs to. Kind → part is static — a landmark's
  // meaning does not depend on the sketch.
  function semanticPartForAnchorKind(kind) {
    if (!kind) return null;
    if (kind === 'band-left' || kind === 'band-right') return 'bottomBand';
    if (kind === 'cf-top' || kind === 'cf-bottom') return 'centerFront';
    if (kind === 'chest-left' || kind === 'chest-right') return 'cradle';
    if (kind.indexOf('cradle-') === 0) return 'cradle';
    if (kind.indexOf('inner-cup-') === 0) return 'frontCup';
    if (kind === 'apex-left' || kind === 'apex-right') return 'frontCup';
    if (kind === 'side-top' || kind === 'side-bottom') return 'sideSeam';
    if (kind === '171' || kind === '172') return 'frontCup';
    if (kind === '181' || kind === '182') return 'sideSeam';
    if (kind === 'strap-top' || kind === 'strap-bottom') return 'strap';
    if (kind === 'back-strap-left' || kind === 'back-strap-right') return 'strap';
    if (kind.indexOf('back-') === 0) return 'backPanel';
    return null;
  }

  function buildLandmarkQaFromDetection(detection) {
    if (!detection || !detection.bbox) return null;

    // ---- View resolution (mirrors seedAnchorsFromDetection exactly) ----
    const views = Array.isArray(detection.views) && detection.views.length
      ? detection.views
      : (Array.isArray(detection.viewBoxes) ? detection.viewBoxes : []);
    const frontIdx = Number.isFinite(detection.frontViewIndex) && detection.frontViewIndex >= 0
      ? detection.frontViewIndex
      : (Number.isFinite(detection.primaryViewIndex) ? detection.primaryViewIndex : 0);
    const frontView = views[frontIdx] || detection.bbox;
    const frontViewValid = !!(frontView && frontView.width > 0 && frontView.height > 0);
    const frontInnerView = views.find(v => v && (v.viewRole === 'front_inner' || v.role === 'front_inner')) || null;
    const hasFrontInnerSeedView = !!(frontInnerView && frontInnerView.width > 0 && frontInnerView.height > 0);
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
    // Two distinct back-view signals, matching the seed layer exactly: the
    // conf/provenance tables key on backView PRESENCE (plain truthiness),
    // while the seed branch that places back-view anchors also requires a
    // non-degenerate box. Conflating them would flip tiers on a zero-size box.
    const backViewPresent = !!backView;
    const backViewValid = !!(backView && backView.width > 0 && backView.height > 0);

    // ---- Evidence handles ----
    const det = detection.confidence || {};
    const cupModel = detection.cupModel || null;
    // innerEdgeSupported === false means the cup model's width row crosses a
    // void (open neckline V — e.g. a front-closure style whose apex fired on
    // the strap top) and its inner endpoint is the fabricated gore inset with
    // no ink anywhere near it. The model must then NOT source the inner-cup
    // anchors; the seed layer falls down the existing precedence chain
    // (innerCupTopInk → view ratios → delete). Predicate mirrors
    // innerCupFromCupModel in seed-anchors.js.
    const cupModelUsable = !!(cupModel && cupModel.visibility !== 'hidden'
      && cupModel.innerEdgeSupported !== false
      && cupModel.topPoint && cupModel.bottomPoint
      && cupModel.innerEdge && cupModel.outerEdgeNearArmhole);
    const cupModelInferred = !!(cupModel && cupModel.visibility === 'inferred');
    const innerCupTopInk = detection.innerCupTop || null;
    const sideTopRightInk = detection.sideTopRight || null;
    const backPanelInk = detection.backPanel || null;
    const backPanelHeightInk = detection.backPanelHeight || null;
    // Mirrors seed-anchors.js: the CF projection only fires from trusted seam
    // tiers ('strong'/'seam'), never from guide/arc commits (ADR 0021/0022).
    const cradleCfFromCupSeam = !detection.cradleCfTop
      && !!detection.cradleCupTop
      && (detection.cradleCupTier === 'strong' || detection.cradleCupTier === 'seam');
    const geometryReviewRequired = !!detection.geometryReviewRequired;
    const geometryReasons = detection.geometryFacts && detection.geometryFacts.quality
      && Array.isArray(detection.geometryFacts.quality.reasons)
      ? detection.geometryFacts.quality.reasons
      : [];
    const seamEv = detection.seamEvidence || null;

    // ---- Cup anchor gate (mirrors the seed layer's cupAnchorGate) ----
    const willDelete = !!(cupModel && cupModel.visibility === 'hidden'
      && !innerCupTopInk && !hasFrontInnerSeedView);
    const cupGate = {
      cupModelPresent: !!cupModel,
      cupModelVisibility: cupModel ? cupModel.visibility : null,
      cupModelInnerEdgeSupported: cupModel ? cupModel.innerEdgeSupported !== false : null,
      cupModelUsable,
      innerCupTopInkPresent: !!innerCupTopInk,
      hasFrontInnerView: hasFrontInnerSeedView,
      willDelete,
      pathTaken: willDelete
        ? 'deleted (POM 9/10 → REVIEW_ONLY)'
        : (cupModelUsable
          ? 'cupModel'
          : (innerCupTopInk
            ? 'innerCupTopInk fallback'
            : (hasFrontInnerSeedView ? 'front_inner view ratios' : 'view-box ratio fallback'))),
      cupModelReason: cupModel ? cupModel.reason : null,
    };
    const cupSource = cupGate.pathTaken === 'cupModel'
      ? (cupModelInferred ? 'cupModelInferred' : 'cupModel')
      : (cupGate.pathTaken === 'front_inner view ratios'
        ? 'frontInnerView'
        : (cupGate.pathTaken === 'innerCupTopInk fallback'
          ? 'innerCupTopInkFallback'
          : 'cupRatioFallback'));

    // ---- Confidence tiers (moved verbatim from seed-anchors.js) ----
    const tier = (score, fallback) => {
      if (score == null || score <= 0) return fallback;
      if (score >= 0.5) return 'high';
      if (score >= 0.2) return 'medium';
      return 'low';
    };
    const cupTier = (score, cm) => {
      const direct = cm && cm.visibility === 'direct';
      const t = tier(score, direct ? 'high' : 'medium');
      return (!direct && t === 'high') ? 'medium' : t;
    };
    const confByKind = {
      'cf-top':            tier(det.axis, 'medium'),
      'cf-bottom':         tier(det.band, 'high'),
      'cradle-cf-top':     (cradleCfFromCupSeam
                              || detection.cradleCfTopDipProjected
                              || detection.cradleCfTopJunction
                              || detection.cradleCfCrestSeedY != null)
                             ? 'low'
                             : tier(det.cradleCfTop, 'medium'),
      'cradle-cup-top':    (detection.cradleCupTier === 'guide' || detection.cradleCupTier === 'arc') ? 'low' : tier(det.cradleCupTop, 'medium'),
      'cradle-cup-bottom': (detection.cradleCupTier === 'guide' || detection.cradleCupTier === 'arc') ? 'low' : tier(det.cradleCupBottom, 'medium'),
      'band-left':         tier(det.band, 'high'),
      'band-right':        tier(det.band, 'high'),
      'chest-left':        tier(det.chest, 'medium'),
      'chest-right':       tier(det.chest, 'medium'),
      'inner-cup-top':     (cupModelUsable
                              ? cupTier((cupModel.contourConfidence || 0) * 0.6 + (cupModel.seamConfidence || 0) * 0.4, cupModel)
                              : (innerCupTopInk ? tier(det.innerCupTop, 'medium') : tier(det.chest, 'medium'))),
      'inner-cup-bottom':  (cupModelUsable
                              ? cupTier((cupModel.seamConfidence || 0) * 0.7 + (cupModel.contourConfidence || 0) * 0.3, cupModel)
                              : tier(det.cradle, 'medium')),
      'inner-cup-left':    (cupModelUsable
                              ? cupTier((cupModel.contourConfidence || 0) * 0.5 + (cupModel.seamConfidence || 0) * 0.5, cupModel)
                              : (innerCupTopInk ? tier(det.innerCupTop, 'medium') : 'medium')),
      'inner-cup-right':   (cupModelUsable
                              ? cupTier((cupModel.contourConfidence || 0) * 0.5 + (cupModel.seamConfidence || 0) * 0.5, cupModel)
                              : (innerCupTopInk ? tier(det.innerCupTop, 'medium') : 'medium')),
      'side-top':          sideTopRightInk ? tier(det.sideTopRight, 'medium') : tier(det.sideRight, 'medium'),
      'side-bottom':       tier(det.sideRight, 'medium'),
      'apex-left':         tier(det.apexLeft, 'medium'),
      'apex-right':        tier(det.apexRight, 'medium'),
      // US-037: neckline corners ride the apex-outer join (medium when a join
      // point exists, else low). Armhole is a bowed-curve guess with no direct
      // ink trace yet — floored to 'low' so POM 18 always reviewRequired
      // (matches its 'low' expected_confidence_tier and POM 14's precedent).
      '171':     detection.cfTopY != null ? 'medium' : 'low',
      '172':    (detection.apexRightInner || detection.apexRight) ? 'medium' : 'low',
      '181':       'low',
      '182':    'low',
      // POM 14 is the only contractually-low POM (always verify by hand); floor
      // both strap ends to 'low' so reviewRequired is guaranteed (ADR 0012).
      'strap-top':         'low',
      'strap-bottom':      'low',
      'back-top':          tier(det.back, 'low'),
      'back-bottom':       tier(det.back, 'low'),
      'back-panel-top':    (backPanelHeightInk || backPanelInk) ? tier(det.backPanel, 'medium') : (backViewPresent ? 'medium' : 'low'),
      'back-panel-bottom': (backPanelHeightInk || backPanelInk) ? tier(det.backPanel, 'medium') : (backViewPresent ? 'medium' : 'low'),
      'back-strap-left':   backViewPresent ? 'medium' : 'low',
      'back-strap-right':  backViewPresent ? 'medium' : 'low',
    };

    // ---- Fine provenance (moved verbatim from seed-anchors.js) ----
    const sourceByKind = {
      'cf-top':            detection.cfTopY != null ? 'ink' : 'ratio',
      'cf-bottom':         detection.bandY != null ? 'silhouette' : 'ratio',
      'cradle-cf-top':     detection.cradleCfTopJunction
                             ? 'seamJunction'
                             : (detection.cradleCfCrestSeedY != null
                               ? 'seamCrest'
                               : (cradleCfFromCupSeam
                                 ? 'seamProjected'
                                 : (detection.cradleCfTopDipProjected ? 'seamDip' : 'seam'))),
      'cradle-cup-top':    detection.cradleCupTier === 'guide' ? 'seamGuide' : (detection.cradleCupTier === 'arc' ? 'seamArc' : 'seam'),
      'cradle-cup-bottom': detection.cradleCupTier === 'guide' ? 'seamGuide' : (detection.cradleCupTier === 'arc' ? 'seamArc' : 'seam'),
      'band-left':         detection.bandLeftX != null ? 'ink' : 'silhouette',
      'band-right':        detection.bandRightX != null ? 'ink' : 'silhouette',
      'chest-left':        (detection.underbustLeftX != null || detection.chestLeftX != null) ? 'ink' : 'ratio',
      'chest-right':       (detection.underbustRightX != null || detection.chestRightX != null) ? 'ink' : 'ratio',
      'inner-cup-top':     cupSource,
      'inner-cup-bottom':  cupSource,
      'inner-cup-left':    cupSource,
      'inner-cup-right':   cupSource,
      'side-top':          sideTopRightInk ? 'ink' : 'silhouette',
      'side-bottom':       detection.sideBottomRight ? 'ink' : 'silhouette',
      'apex-left':         detection.apexLeft ? 'apexJoin' : 'ratio',
      'apex-right':        detection.apexRight ? 'apexJoin' : 'ratio',
      '171':     detection.cfTopY != null ? 'cfTop' : 'ratio',
      '172':    (detection.apexRightInner || detection.apexRight) ? 'apexJoin' : 'ratio',
      '181':       detection.sideTopRightInk ? 'ink' : (detection.sideRightX != null ? 'silhouette' : 'ratio'),
      '182':    (detection.apexRightOuter || detection.frontStrapStart) ? 'strapJoin' : 'ratio',
      'strap-top':         detection.frontStrapStart ? 'frontStrapSeam' : 'ratio',
      'strap-bottom':      (backPanelHeightInk || backPanelInk) ? 'backPanelJoin' : 'ratio',
      'back-top':          (detection.back && detection.back.top) ? 'ink' : 'ratio',
      'back-bottom':       (detection.back && detection.back.bottom) ? 'ink' : 'ratio',
      'back-panel-top':    (backPanelHeightInk || backPanelInk) ? 'ink' : 'ratio',
      'back-panel-bottom': (backPanelHeightInk || backPanelInk) ? 'ink' : 'ratio',
      'back-strap-left':   (detection.backStrapInner && detection.backStrapInner.left)  ? 'ink' : (backViewPresent ? 'silhouette' : 'ratio'),
      'back-strap-right':  (detection.backStrapInner && detection.backStrapInner.right) ? 'ink' : (backViewPresent ? 'silhouette' : 'ratio'),
    };

    // ---- Numeric score behind the tier (null when a fallback bucket fired) ----
    const cupBlend = (a, b) => cupModelUsable
      ? (cupModel.contourConfidence || 0) * a + (cupModel.seamConfidence || 0) * b
      : null;
    const scoreByKind = {
      'cf-top': det.axis, 'cf-bottom': det.band,
      'cradle-cf-top': det.cradleCfTop, 'cradle-cup-top': det.cradleCupTop,
      'cradle-cup-bottom': det.cradleCupBottom,
      'band-left': det.band, 'band-right': det.band,
      'chest-left': det.chest, 'chest-right': det.chest,
      'inner-cup-top': cupBlend(0.6, 0.4),
      'inner-cup-bottom': cupModelUsable ? (cupModel.seamConfidence || 0) * 0.7 + (cupModel.contourConfidence || 0) * 0.3 : det.cradle,
      'inner-cup-left': cupBlend(0.5, 0.5), 'inner-cup-right': cupBlend(0.5, 0.5),
      'side-top': sideTopRightInk ? det.sideTopRight : det.sideRight,
      'side-bottom': det.sideRight,
      'apex-left': det.apexLeft, 'apex-right': det.apexRight,
      '171': null, '172': null,
      '181': null, '182': null,
      'strap-top': det.frontStrapStart, 'strap-bottom': det.backPanel,
      'back-top': det.back, 'back-bottom': det.back,
      'back-panel-top': det.backPanel, 'back-panel-bottom': det.backPanel,
      'back-strap-left': null, 'back-strap-right': null,
    };

    // ---- Seed presence: will seedAnchorsFromDetection place this kind? ----
    // Mirrors the seed construction paths, so a `missing` classification here
    // is exactly the requiredAnchors demotion the drafter will apply.
    const apexL = detection.apexLeftInner || detection.apexLeft;
    const apexR = detection.apexRightInner || detection.apexRight;
    const presentByKind = {};
    for (const schema of ANCHOR_SCHEMA) presentByKind[schema.kind] = true;
    presentByKind['cradle-cf-top'] = !!(detection.cradleCfTop
      || detection.cradleCfCrestSeedY != null
      || cradleCfFromCupSeam);
    presentByKind['cradle-cup-top'] = !!(detection.cradleCupTop && detection.cradleCupBottom);
    presentByKind['cradle-cup-bottom'] = presentByKind['cradle-cup-top'];
    presentByKind['apex-left'] = !!(frontViewValid && apexL && apexR);
    presentByKind['apex-right'] = presentByKind['apex-left'];
    presentByKind['strap-top'] = frontViewValid;
    presentByKind['back-panel-top'] = backViewValid;
    presentByKind['back-panel-bottom'] = backViewValid;
    presentByKind['back-strap-left'] = backViewValid;
    presentByKind['back-strap-right'] = backViewValid;
    presentByKind['strap-bottom'] = backViewValid;
    if (willDelete) {
      presentByKind['inner-cup-top'] = false;
      presentByKind['inner-cup-bottom'] = false;
      presentByKind['inner-cup-left'] = false;
      presentByKind['inner-cup-right'] = false;
    }

    // ---- Source class: provenance → Engineering Workflow vocabulary ----
    const SOURCE_CLASS = {
      ink: 'detected', seam: 'detected', seamGuide: 'detected', seamArc: 'detected',
      seamJunction: 'detected', seamCrest: 'detected', silhouette: 'detected',
      apexJoin: 'detected', frontStrapSeam: 'detected', backPanelJoin: 'detected',
      cupModel: 'detected', frontInnerView: 'detected',
      innerCupTopInkFallback: 'detected',
      cupModelInferred: 'derived',
      seamProjected: 'projected', seamDip: 'projected',
      ratio: 'projected', cupRatioFallback: 'projected',
    };

    // ---- Per-kind assembly ----
    const PROJECTED_SOURCES = ['ratio', 'seamProjected', 'seamDip', 'cupRatioFallback', 'innerCupTopInkFallback'];
    const byKind = {};
    const summary = {
      total: 0, missing: 0, reviewRequired: 0,
      bySourceClass: { detected: 0, derived: 0, projected: 0, missing: 0 },
    };
    for (const schema of ANCHOR_SCHEMA) {
      const kind = schema.kind;
      const present = !!presentByKind[kind];
      const source = sourceByKind[kind] || 'unknown';
      const confTier = confByKind[kind] || 'medium';
      const rawScore = scoreByKind[kind];
      const notes = [];

      // Weakness predicate — identical to the seed layer's reviewRequired.
      const cupInferredWeakAnchor = source === 'cupModelInferred'
        && cupModel
        && (
          (cupModel.contourConfidence || 0) < 0.5
          || (kind === 'inner-cup-bottom' && !cupModel.bottomFromSeam && !cupModel.bottomFromInk)
          || (kind === 'inner-cup-top' && !cupModel.topFromApex)
        );
      const reviewRequired = !present
        || confTier === 'low'
        || PROJECTED_SOURCES.indexOf(source) >= 0
        || cupInferredWeakAnchor
        || (geometryReviewRequired && confTier !== 'high');

      // QA notes in the stage-7 vocabulary: say WHY, not just that it is weak.
      if (!present) {
        if (kind === 'cradle-cf-top') {
          const reason = seamEv && seamEv.cradleCfSeam && seamEv.cradleCfSeam.missingReason;
          notes.push('missing seam: no CF cradle seam detected' + (reason ? ' (' + reason + ')' : '') + ' — POM 6/8 demote to REVIEW_ONLY.');
        } else if (kind === 'cradle-cup-top' || kind === 'cradle-cup-bottom') {
          const reason = seamEv && seamEv.cradleCupSeam && seamEv.cradleCupSeam.missingReason;
          notes.push('missing seam: bottom-cup cradle seam not found' + (reason ? ' (' + reason + ')' : '') + ' — POM 7 demotes to REVIEW_ONLY.');
        } else if (kind.indexOf('inner-cup-') === 0) {
          notes.push('missing: cup model hidden with no fallback evidence — POM 9/10 demote to REVIEW_ONLY.');
        } else if (kind === 'apex-left' || kind === 'apex-right') {
          notes.push('missing: apex join not validated on both cups — POM 16 demotes to REVIEW_ONLY.');
        } else {
          notes.push('missing: no back view detected — the back-view landmark cannot be placed.');
        }
      } else {
        if (source === 'seamProjected') {
          notes.push('projected landmark: CF seam missed; extended from the bottom-cup cradle seam to the CF axis — verify the POM 6/8 boundary.');
        } else if (source === 'seamGuide') {
          notes.push('guide-tier seam: accepted from a sparse dashed vertical guide (below the strong-guide threshold) — verify the POM 7 placement; this seam is not used for POM 9/10 geometry.');
        } else if (source === 'seamArc') {
          notes.push('arc-tier seam: POM 7 placed on the traced cup-bottom/underwire arc (no drawn seam or guide line) — verify the cradle height placement; this seam is not used for POM 9/10 geometry.');
        } else if (source === 'seamJunction') {
          notes.push('junction-tier seam: the cradle/band seam is interrupted at the CF by a closure placket; placed where the seam meets the placket edges — verify the POM 6/8 boundary.');
        } else if (source === 'seamCrest') {
          notes.push('crest-tier seam: no direct CF seam ink; placed on the symmetric contour crest where the cup-bottom seams meet the CF axis (gore top) — verify the POM 6/8 boundary.');
        } else if (source === 'seamDip') {
          notes.push('projected landmark: cradle-cf-top projected from the seam dip — verify against the actual CF seam.');
        } else if (source === 'ratio' || source === 'cupRatioFallback') {
          notes.push('projected landmark: no ink signal — seeded from view-box ratio geometry.');
        } else if (source === 'innerCupTopInkFallback') {
          notes.push('weak contour: cup model unavailable; legacy ink-top heuristic used for the inner-cup frame.');
        }
        if (source === 'cupModelInferred') {
          notes.push('inferred geometry: cup model built from apex + cradle seam evidence (no front_inner view).');
          if ((cupModel.contourConfidence || 0) < 0.5) {
            notes.push('weak contour: cup outline confidence ' + (cupModel.contourConfidence || 0).toFixed(2) + ' — the traced cup arc is unreliable.');
          }
          if (kind === 'inner-cup-bottom' && !cupModel.bottomFromSeam && !cupModel.bottomFromInk) {
            notes.push('inferred geometry: cup bottom is a flat-cradle-row guess (no committed seam or underwire arc).');
          }
          if (kind === 'inner-cup-top' && !cupModel.topFromApex) {
            notes.push('inferred geometry: cup top is not anchored on a validated apex.');
          }
        }
        if (geometryReviewRequired && confTier !== 'high') {
          notes.push('poor view classification / weak frame: ' + (geometryReasons.join('; ') || 'geometry stage flagged the frame as weak') + '.');
        }
        if (kind === 'strap-top' || kind === 'strap-bottom') {
          notes.push('POM 14 (shoulder-strap length) is contractually always-verify (ADR 0012).');
        }
      }

      const sourceClass = present ? (SOURCE_CLASS[source] || 'detected') : 'missing';
      byKind[kind] = {
        kind,
        present,
        source: present ? source : null,
        sourceClass,
        confidence: confTier,
        score: (typeof rawScore === 'number' && rawScore > 0)
          ? Math.round(rawScore * 1e4) / 1e4
          : null,
        reviewRequired,
        notes,
      };
      summary.total += 1;
      if (!present) summary.missing += 1;
      if (reviewRequired) summary.reviewRequired += 1;
      summary.bySourceClass[sourceClass] += 1;
    }

    return {
      version: 1,
      byKind,
      summary,
      cupGate,
      geometryReviewRequired,
    };
  }
