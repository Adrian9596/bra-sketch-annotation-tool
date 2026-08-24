// Manual-line-to-meaning commit workflow: ranking heuristics for a freshly
// drawn manual line, the dedup hash, and the funnel that resolves a TD's
// manual POM label into a recorded calibration residual. Source part for
// app.js. Run `npm run build` after editing.
//
// This is the one workflow in the learning cluster that spans all three
// stores: it reads the catalog from src/auto/learning/meaning-store.js,
// runs shadow re-detection via src/auto/learning/shadow-detection.js, and
// records residuals through src/auto/learning/calibration-store.js's
// recordAnchorResidual. It must load after all three.

  // Recency-decayed usage weight. A meaning confirmed yesterday should
  // outrank one that was confirmed 200 times two years ago but never
  // since — TDs change templates, and stale usage stats mislead the
  // top-3. Half-life of ~21d (exp(-21/30) ≈ 0.5) decays old confirmations
  // smoothly without ever zeroing them out completely.
  function meaningUsagePriority(meaningId) {
    const u = meaningStore.usage[meaningId];
    if (!u || !u.count) return 0;
    const ageMs = Math.max(0, Date.now() - (u.lastUsedAt || 0));
    const ageDays = ageMs / 86400000;
    return u.count * Math.exp(-ageDays / 30);
  }

  // Rank catalog entries by anchor-pair distance to the manual line.
  // Stroke direction is arbitrary, so we compare both orderings. Distance
  // dominates so the geometry of the current sketch always wins; ties
  // break on a recency-weighted usage score so a meaning the TD just
  // confirmed on the last two sketches floats above a stale heavyweight.
  function rankCatalogForLine(image, ann, limit) {
    if (!image || !ann || !ann.start || !ann.end) return [];
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return [];
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const scored = [];
    for (const m of getAllCatalogMeanings()) {
      const a = rawAnchors.find(r => r.kind === m.start);
      const b = rawAnchors.find(r => r.kind === m.end);
      if (!a || !b) continue;
      const direct  = (ms.x - a.x) ** 2 + (ms.y - a.y) ** 2 + (me.x - b.x) ** 2 + (me.y - b.y) ** 2;
      const swapped = (ms.x - b.x) ** 2 + (ms.y - b.y) ** 2 + (me.x - a.x) ** 2 + (me.y - a.y) ** 2;
      scored.push({ meaning: m, d: Math.min(direct, swapped), priority: meaningUsagePriority(m.id) });
    }
    scored.sort((x, y) => x.d - y.d || y.priority - x.priority);
    return scored.slice(0, limit || 3).map(s => s.meaning);
  }

  // Picks the nearest raw anchor to each manual endpoint independently.
  // Used when the TD names a brand-new measurement so we can register
  // its anchor pair without asking them to pick anchors.
  function detectAnchorPairForLine(image, ann) {
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors || rawAnchors.length < 2) return null;
    const ms = worldToAnchorSpace(image, ann.start);
    const me = worldToAnchorSpace(image, ann.end);
    const d2 = (p, a) => (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
    let bestStart = null, bestStartD = Infinity;
    let bestEnd   = null, bestEndD   = Infinity;
    for (const a of rawAnchors) {
      const ds = d2(ms, a);
      if (ds < bestStartD) { bestStartD = ds; bestStart = a; }
      const de = d2(me, a);
      if (de < bestEndD)   { bestEndD   = de; bestEnd   = a; }
    }
    if (!bestStart || !bestEnd || bestStart.kind === bestEnd.kind) return null;
    return { start: bestStart.kind, end: bestEnd.kind };
  }

  // Endpoint coord hash for de-dup. Re-commit with no movement → same
  // hash → skip. Move an endpoint → new hash → new sample.
  function makeLearnSampleHash(pom, ann) {
    return pom + '|'
      + ann.start.x.toFixed(2) + ',' + ann.start.y.toFixed(2) + '|'
      + ann.end.x.toFixed(2)   + ',' + ann.end.y.toFixed(2);
  }

  // True when a re-evaluation of the same annotation should be skipped.
  // The endpoint-coord hash alone is not enough: if the TD reconfirms POM
  // N as a *different* meaning (e.g. POM 9 was cup-height, now side-height),
  // the residual lives in a different anchor bucket and must be re-recorded.
  // So we treat (hash, meaningId) as the dedup key.
  function isSameLearnSample(ann, hash, meaningId) {
    if (!ann || ann.learnSampleHash !== hash) return false;
    if (meaningId && ann.learnMeaningId && ann.learnMeaningId !== meaningId) return false;
    return true;
  }

  // Returns one of:
  //   { status: 'recorded',          pom }
  //   { status: 'skipped' }                              — no learning happens
  //   { status: 'needsConfirmation', pom, ann, image, hash, suggestions }
  //     — caller should open the meaning picker. After the TD picks,
  //       call commitMeaningChoice() / commitMeaningChoiceCustom() with
  //       the original eval result.
  function evaluateManualPomSample(ann, options = {}) {
    if (!ann || !ann.start || !ann.end) return { status: 'skipped' };
    if (!isLearningEnabled())            return { status: 'skipped' };
    // US-096 / ADR 0055 code review, 2026-08-23: a construction line carries no
    // POM meaning, so its geometry must never bias a POM's anchor seed.
    //
    // This is the LIVE capture path (drag-commit in pointer-events.js, arrow
    // nudge in line-nudge.js), and it was missed when the save-time path
    // (isEligibleEvidenceAnnotation, style-evidence-capture.js) was gated.
    // The gap was reachable and expensive: restyling an APPLIED auto line to
    // zigzag leaves ann.auto / sourceMode / autoRunId intact, so isAutoDraft
    // stays true and allowAuto makes labelText fall back to getLabelText(ann)
    // — the seq the line was born with, i.e. the very POM number it no longer
    // measures. Dragging it then wrote the stitch path into that POM's bucket,
    // and the learning store outlives the project.
    if (!isMeasurementAnnotation(ann)) return { status: 'skipped' };
    if (ann.auto === true && !options.allowAuto) return { status: 'skipped' };

    const explicitText = ann.text != null && String(ann.text).trim() !== ''
      ? ann.text
      : null;
    const labelText = explicitText != null
      ? explicitText
      : (options.allowAuto ? getLabelText(ann) : null);
    const pom = parsePomNumberFromLabel(labelText);
    if (!pom) return { status: 'skipped' };

    // POMs 2 and 4: derived endpoints (extension lines). Skip silently.
    const pomNum = Number(pom);
    if (pomNum === 2 || pomNum === 4) return { status: 'skipped' };

    const image = pickImageForAnnotation(ann);
    if (!image) return { status: 'skipped' };

    const hash = makeLearnSampleHash(pom, ann);
    const meaning = resolvePomMeaning(pom);
    if (meaning) {
      // Skip only when the same hash AND meaning were already recorded on
      // this annotation; a meaning change still re-records so the new
      // anchor bucket gets the sample.
      if (isSameLearnSample(ann, hash, meaning.id)) return { status: 'skipped' };
      const ok = applyMeaningSample(ann, image, pom, meaning, hash);
      return { status: ok ? 'recorded' : 'skipped', pom };
    }

    // POM 6+ with no confirmed meaning — surface to the UI. No meaning is
    // known yet, so dedup falls back to the endpoint hash alone.
    if (ann.learnSampleHash === hash) return { status: 'skipped' };
    const suggestions = rankCatalogForLine(image, ann, 3);
    return { status: 'needsConfirmation', pom, ann, image, hash, suggestions };
  }

  // Records the residual for a (line, meaning) pair through the Phase 1
  // store. Returns true if the sample was actually committed.
  function applyMeaningSample(ann, image, pom, meaning, hash) {
    if (!meaning) return false;
    const rawAnchors = getShadowAnchorsForImage(image);
    if (!rawAnchors) return false;
    const startAnchor = rawAnchors.find(a => a.kind === meaning.start);
    const endAnchor   = rawAnchors.find(a => a.kind === meaning.end);
    if (!startAnchor || !endAnchor) return false;

    const manualStart = worldToAnchorSpace(image, ann.start);
    const manualEnd   = worldToAnchorSpace(image, ann.end);

    // Stroke orientation is arbitrary — pair endpoints by min total distance.
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    const direct  = d2(manualStart, startAnchor) + d2(manualEnd, endAnchor);
    const swapped = d2(manualStart, endAnchor)   + d2(manualEnd, startAnchor);
    const pairs = direct <= swapped
      ? [[startAnchor, manualStart], [endAnchor, manualEnd]]
      : [[startAnchor, manualEnd],   [endAnchor, manualStart]];

    // Label-collision guardrail: a manual line more than half the image
    // away from the predicted anchor is almost certainly mislabeled.
    const maxResidual = 0.50;
    for (const [anchor, manual] of pairs) {
      if (Math.abs(manual.x - anchor.x) > maxResidual) return false;
      if (Math.abs(manual.y - anchor.y) > maxResidual) return false;
    }

    for (const [anchor, manual] of pairs) {
      recordAnchorResidual(anchor.kind, manual.x - anchor.x, manual.y - anchor.y, anchor);
    }

    ann.learnSampleHash = hash;
    ann.learnSamplePom  = pom;
    ann.learnMeaningId  = meaning.id;

    if (meaning.id) {
      const u = meaningStore.usage[meaning.id] || { count: 0, lastUsedAt: 0 };
      u.count += 1;
      u.lastUsedAt = Date.now();
      meaningStore.usage[meaning.id] = u;
      saveMeaningStore();
    }
    return true;
  }

  // TD picked an existing catalog entry from the popover.
  function commitMeaningChoice(evalResult, meaningId) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const meaning = getCatalogEntry(meaningId);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaningId);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
  }

  // TD typed a brand-new measurement name. We auto-detect the anchor
  // pair from the manual line itself, register it as a custom meaning,
  // pin POM N to it, then record the sample.
  function commitMeaningChoiceCustom(evalResult, label) {
    if (!evalResult || evalResult.status !== 'needsConfirmation') return false;
    const pair = detectAnchorPairForLine(evalResult.image, evalResult.ann);
    if (!pair) return false;
    const meaning = addCustomMeaning(label, pair.start, pair.end);
    if (!meaning) return false;
    confirmPomMeaning(evalResult.pom, meaning.id);
    return applyMeaningSample(evalResult.ann, evalResult.image, evalResult.pom, meaning, evalResult.hash);
  }
