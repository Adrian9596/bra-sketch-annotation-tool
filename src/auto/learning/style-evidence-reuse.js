// Style evidence: generate-time reuse of stored evidence to bias or veto
// freshly generated drafts. Source part for app.js. Run `npm run build`
// after editing.
//
// The durable store schema and CRUD (listStyleEvidence, etc.) live in the
// sibling src/auto/learning/style-evidence-record.js, which loads before
// this file. Save-time candidate capture from the live project lives in
// src/auto/learning/style-evidence-capture.js.

  function latestEvidenceByPom(styleId) {
    const out = new Map();
    for (const rec of listStyleEvidence(styleId)) {
      if (!rec || rec.pom == null) continue;
      const pom = String(rec.pom);
      if (!out.has(pom)) out.set(pom, rec);
    }
    return out;
  }

  function getAbsentEvidenceByPom(styleId) {
    const latest = latestEvidenceByPom(styleId || currentStyleId());
    const out = new Map();
    for (const [pom, rec] of latest.entries()) {
      if (rec && rec.tdStatus === 'absent-confirmed') out.set(pom, rec);
    }
    return out;
  }

  // ---- Phase 3: reuse confirmed evidence to pre-seed drafts ----------
  //
  // Absence evidence (above) wipes the draft when the style is known not to
  // measure a POM. The confirmed side does the symmetric job: when prior
  // TD edits keep landing in roughly the same spot for a POM on this style,
  // pull the freshly generated draft a fraction of the way toward the
  // median of those edits. This is a soft prior — geometry from the
  // current sketch still dominates so a different image doesn't snap to
  // the wrong place — but it shortens TD review when a style has settled.
  //
  // Three guardrails keep the prior honest:
  //   - aggregate across at most the N most-recent confirmed records,
  //   - reject when the evidence is more than a third of the image away
  //     from the current draft (almost certainly a different sketch type),
  //   - never overwrite an absence-flagged draft (REVIEW_ONLY survives).
  const STYLE_EVIDENCE_REUSE_BLEND = 0.4;        // 40% pull toward evidence
  const STYLE_EVIDENCE_REUSE_RECENT = 5;         // last N confirmations per POM
  const STYLE_EVIDENCE_REUSE_MAX_GAP = 0.30;     // reject if >30% of image away

  function getConfirmedEvidenceMediansByPom(styleId) {
    const records = listStyleEvidence(styleId == null ? currentStyleId() : styleId);
    const byPom = new Map();
    for (const rec of records) {
      if (!rec || rec.tdStatus !== 'confirmed' || rec.pom == null || !rec.line) continue;
      if (!rec.line.start || !rec.line.end) continue;
      const pom = String(rec.pom);
      let arr = byPom.get(pom);
      if (!arr) { arr = []; byPom.set(pom, arr); }
      arr.push(rec);
    }
    const out = new Map();
    for (const [pom, recs] of byPom.entries()) {
      // listStyleEvidence already returns newest-first; trim to the most
      // recent N so a stale 6-month-old confirmation can't outvote a
      // freshly-edited one when the TD has reworked the POM lately.
      const recent = recs.slice(0, STYLE_EVIDENCE_REUSE_RECENT);
      if (!recent.length) continue;
      const startXs = recent.map(r => Number(r.line.start.x) || 0);
      const startYs = recent.map(r => Number(r.line.start.y) || 0);
      const endXs   = recent.map(r => Number(r.line.end.x)   || 0);
      const endYs   = recent.map(r => Number(r.line.end.y)   || 0);
      const isCurved = recent.every(r => r.line && r.line.type === 'curved');
      out.set(pom, {
        pom,
        startNorm: { x: medianOf(startXs), y: medianOf(startYs) },
        endNorm:   { x: medianOf(endXs),   y: medianOf(endYs) },
        lineType: isCurved ? 'curved' : 'straight',
        sampleCount: recent.length,
        lastSavedAt: recent[0].savedAt,
        meaningId: recent[0].meaningId || null,
        latestRecordId: recent[0].id,
      });
    }
    return out;
  }

  function applyStyleConfirmedEvidenceToDrafts(drafts, sourceImage) {
    if (!Array.isArray(drafts) || !drafts.length) return 0;
    if (!sourceImage || !sourceImage.width || !sourceImage.height) return 0;
    const confirmedByPom = getConfirmedEvidenceMediansByPom(currentStyleId());
    if (!confirmedByPom.size) return 0;
    const maxGapPx = STYLE_EVIDENCE_REUSE_MAX_GAP
      * Math.max(sourceImage.width, sourceImage.height);
    let changed = 0;
    for (const draft of drafts) {
      if (!draft) continue;
      if (draft.drawability === 'REVIEW_ONLY') continue;
      // Absence evidence already cleared geometry above; don't undo it.
      if (draft.styleEvidenceStatus === 'absent-confirmed') continue;
      if (!draft.start || !draft.end) continue;
      const pom = draft.seq != null ? String(draft.seq) : null;
      const ev = pom ? confirmedByPom.get(pom) : null;
      if (!ev) continue;
      // Curved evidence on a straight draft (or vice versa) means the
      // template intent doesn't match — blending endpoints would warp
      // the line into a meaningless shape. Skip and let detection win.
      if ((draft.type === 'curved') !== (ev.lineType === 'curved')) continue;
      const evStart = {
        x: sourceImage.x + ev.startNorm.x * sourceImage.width,
        y: sourceImage.y + ev.startNorm.y * sourceImage.height,
      };
      const evEnd = {
        x: sourceImage.x + ev.endNorm.x * sourceImage.width,
        y: sourceImage.y + ev.endNorm.y * sourceImage.height,
      };
      // Pair endpoints (start↔start, end↔end) by min total squared distance.
      // Strokes have arbitrary orientation, so a confirmed line drawn
      // bottom-to-top still nudges a top-to-bottom draft correctly.
      const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      const direct  = d2(draft.start, evStart) + d2(draft.end, evEnd);
      const swapped = d2(draft.start, evEnd)   + d2(draft.end, evStart);
      const [evS, evE] = direct <= swapped ? [evStart, evEnd] : [evEnd, evStart];
      // Reject when evidence is far from current draft — almost certainly
      // a sketch with a different layout or scale.
      const gapStart = Math.hypot(draft.start.x - evS.x, draft.start.y - evS.y);
      const gapEnd   = Math.hypot(draft.end.x   - evE.x, draft.end.y   - evE.y);
      if (gapStart > maxGapPx || gapEnd > maxGapPx) continue;
      const a = STYLE_EVIDENCE_REUSE_BLEND;
      // Keep the pre-blend chord: every other geometry field on the draft is an
      // ABSOLUTE world point measured against it, so the carry below needs both
      // the old frame and the new one.
      const oldStart = { x: draft.start.x, y: draft.start.y };
      const oldEnd = { x: draft.end.x, y: draft.end.y };
      draft.start = {
        x: draft.start.x * (1 - a) + evS.x * a,
        y: draft.start.y * (1 - a) + evS.y * a,
      };
      draft.end = {
        x: draft.end.x * (1 - a) + evE.x * a,
        y: draft.end.y * (1 - a) + evE.y * a,
      };
      carryDraftGeometryToNewChord(draft, oldStart, oldEnd);
      draft.styleEvidenceId = ev.latestRecordId;
      draft.styleEvidenceStatus = 'confirmed-prior';
      draft.styleEvidenceSamples = ev.sampleCount;
      // Prior evidence is a stronger signal than vanilla detection on
      // this style — promote the confidence so the TD review chip shows
      // the line as high-trust, but only raise (never demote).
      if (draft.confidence !== 'high') draft.confidence = 'high';
      changed += 1;
    }
    return changed;
  }

  // Carry a blended draft's non-endpoint geometry onto its new chord.
  //
  // applyStyleConfirmedEvidenceToDrafts rewrites start/end, but a draft's curve
  // handles, interior anchors and label are absolute world points that
  // buildDraftAnnotation baked from the PRE-blend geometry — nothing recomputes
  // them. Left behind they stay exactly where they were: measured on demo1, a
  // 0.06 evidence offset moved POM 14 / 17 / 18's endpoints 0.024 while
  // control1, control2 and label each moved 0.000. That is a traced arc pulled
  // out of shape under a callout number parked off its own line, and it reached
  // the applied annotations — the real Generate button auto-applies.
  //
  // A cubic's handles are only meaningful relative to its chord, so carry every
  // dependent point through the similarity (rotate + uniform scale + translate)
  // that maps the old chord onto the new one. The arc keeps the shape the
  // contour trace found for it; only its frame moves. Also the reason POM 14's
  // "handles interpolate the strap span" invariant (validate-fixture.js) still
  // holds after a blend that validateAutoFixture ran before.
  //
  // The field list mirrors scaleAnnotationAbout (src/manual/viewport.js) on
  // purpose: that is the other place a whole annotation's geometry moves as a
  // unit, and a field added to one and not the other is exactly how ann.points
  // got torn once already (ADR 0053).
  function carryDraftGeometryToNewChord(draft, oldStart, oldEnd) {
    if (!draft || !oldStart || !oldEnd || !draft.start || !draft.end) return;
    const ux = oldEnd.x - oldStart.x;
    const uy = oldEnd.y - oldStart.y;
    const den = ux * ux + uy * uy;
    const vx = draft.end.x - draft.start.x;
    const vy = draft.end.y - draft.start.y;
    // A degenerate old chord (both endpoints coincided) has no frame to rotate
    // out of, so fall back to a pure translation by the start delta. The P5
    // guard in pom-fixture-builder demotes zero-length straight rows before
    // they get here, but a curve can still be degenerate.
    const rotate = den > 1e-12;
    const cos = rotate ? (vx * ux + vy * uy) / den : 1;
    const sin = rotate ? (vy * ux - vx * uy) / den : 0;
    const carry = (p) => {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      const dx = p.x - oldStart.x;
      const dy = p.y - oldStart.y;
      p.x = draft.start.x + cos * dx - sin * dy;
      p.y = draft.start.y + sin * dx + cos * dy;
    };
    for (const key of ['midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      if (draft[key]) carry(draft[key]);
    }
    if (Array.isArray(draft.points)) {
      for (const anchor of draft.points) {
        if (!anchor) continue;
        for (const field of ['point', 'handleIn', 'handleOut']) {
          if (anchor[field]) carry(anchor[field]);
        }
      }
    }
    // The label is a DERIVED default on a generated draft (buildDraftAnnotation
    // only honours an explicit fixture label, which no generated row sets), so
    // re-derive it from the moved geometry rather than transporting it: its
    // perpendicular offset is a fixed screen distance and must not pick up the
    // chord's scale factor. A hand-placed label is a TD decision and rides the
    // transform instead. Either way this runs before
    // nudgeAutoLabelsToAvoidCollisions, so the de-collision pass still gets the
    // last word — which is what the comment at its call site already claimed.
    if (draft.labelManual) {
      carry(draft.label);
    } else if (typeof computeDefaultLabelPosition === 'function') {
      draft.label = computeDefaultLabelPosition(draft);
    }
  }

  function applyStyleAbsenceEvidenceToDrafts(drafts) {
    if (!Array.isArray(drafts) || !drafts.length) return 0;
    const absentByPom = getAbsentEvidenceByPom(currentStyleId());
    if (!absentByPom.size) return 0;
    let changed = 0;
    for (const draft of drafts) {
      const pom = draft && draft.seq != null ? String(draft.seq) : null;
      const evidence = pom ? absentByPom.get(pom) : null;
      if (!evidence) continue;
      draft.drawability = 'REVIEW_ONLY';
      draft.start = null;
      draft.end = null;
      draft.control1 = null;
      draft.control2 = null;
      draft.label = null;
      draft.confidence = 'low';
      draft.tdApproved = false;
      draft.tdApprovalRequired = true;
      draft.endpointApproximate = false;
      draft.styleEvidenceId = evidence.id;
      draft.styleEvidenceStatus = 'absent-confirmed';
      draft.uncertainty = 'Style evidence says POM ' + pom + ' is absent for this style.';
      draft.reason = draft.uncertainty;
      changed += 1;
    }
    return changed;
  }
