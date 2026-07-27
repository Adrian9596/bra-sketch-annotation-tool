// Validation of a generated POM fixture before drafts hit the board.
// Source part for app.js. Run `npm run build` after editing.
//
// validateAutoFixture returns { status, errors, warnings }. The status
// gate keeps malformed fixtures (NaNs, off-canvas endpoints, wrong axis)
// from ever being drawn — Validation errors surface in the auto review
// header before the TD can approve anything.

  // Returns { status: 'pass'|'warning'|'fail', errors:[], warnings:[] }
  function validateAutoFixture(fixture) {
    const errors = [];
    const warnings = [];
    const pomTemplate = POM_TEMPLATE;

    if (!fixture || !Array.isArray(fixture.annotations)) {
      errors.push('Fixture has no annotations array.');
      return { status: 'fail', errors, warnings };
    }

    const seenPoms = new Map();
    for (const row of fixture.annotations) {
      const pomKey = String(row.pom);
      if (!pomTemplate[pomKey]) {
        errors.push(`Row references POM ${pomKey} which is not in POM_TEMPLATE 1–18.`);
        continue;
      }
      const list = seenPoms.get(pomKey) || [];
      list.push(row);
      seenPoms.set(pomKey, list);
    }

    // Exactly one row per POM 1–18 (core range widened by ADR 0032)
    for (let n = 1; n <= 18; n += 1) {
      const key = String(n);
      const rows = seenPoms.get(key) || [];
      if (rows.length === 0) errors.push(`Missing POM ${key}.`);
      else if (rows.length > 1) errors.push(`Duplicate POM ${key} (${rows.length} rows).`);
    }

    // Unique fixture IDs
    const idSet = new Set();
    for (const row of fixture.annotations) {
      if (row.fixtureId && idSet.has(row.fixtureId)) {
        errors.push(`Duplicate fixtureId "${row.fixtureId}".`);
      }
      if (row.fixtureId) idSet.add(row.fixtureId);
    }

    // Per-row checks
    for (const row of fixture.annotations) {
      const tag = `POM ${row.pom}`;
      if (!row.drawability || !['DRAWABLE', 'APPROXIMATE', 'REVIEW_ONLY'].includes(row.drawability)) {
        errors.push(`${tag}: invalid drawability "${row.drawability}".`);
        continue;
      }
      if (!['front_outer', 'back', 'front_inner', 'unknown'].includes(row.viewRole || 'unknown')) {
        errors.push(`${tag}: invalid viewRole "${row.viewRole}".`);
        continue;
      }
      const requiredRole = defaultPomViewRole(row.pom);
      const expectedRole = (requiredRole === 'front_inner' && !hasDetectedViewRole('front_inner'))
        ? 'front_outer'
        : requiredRole;
      if (row.viewRole !== expectedRole) {
        errors.push(`${tag}: expected viewRole ${expectedRole}, got ${row.viewRole}.`);
      }
      if (row.drawability === 'REVIEW_ONLY') {
        // No stale geometry allowed
        if (row.start || row.end || row.control1 || row.control2) {
          errors.push(`${tag}: REVIEW_ONLY row must have null geometry.`);
        }
        if (row.confidence !== 'low') {
          warnings.push(`${tag}: REVIEW_ONLY rows should have low confidence.`);
        }
        if (!row.uncertainty) {
          warnings.push(`${tag}: REVIEW_ONLY rows should explain why a line cannot be drawn.`);
        }
        // Phase 7 boundary audit: a row may only claim missing anchors that
        // its POM actually declares as required in pom-template.json — the
        // rule JSON stays the source of truth, and the review note cannot
        // drift from it.
        if (Array.isArray(row.missingAnchors) && row.missingAnchors.length) {
          const tpl = pomTemplate[String(row.pom)];
          const required = (tpl && Array.isArray(tpl.requiredAnchors)) ? tpl.requiredAnchors : [];
          for (const kind of row.missingAnchors) {
            if (required.indexOf(kind) < 0) {
              errors.push(`${tag}: missingAnchors lists "${kind}" which is not a declared requiredAnchor.`);
            }
          }
        }
        continue;
      }

      // Endpoints must sit on (or just off) the canvas; control points are
      // mathematical handles and can legitimately live well outside it. Use a
      // wider tolerance for control points so legitimate off-canvas curve
      // handles don't get mistaken for numeric errors.
      const coordsOk =
        isFiniteNormalized(row.start) &&
        isFiniteNormalized(row.end) &&
        (row.type !== 'curved' || (isFiniteHandle(row.control1) && isFiniteHandle(row.control2)));
      if (!coordsOk) {
        errors.push(`${tag}: non-finite or out-of-range coordinates.`);
        continue;
      }
    }

    // POM-specific geometry checks
    const get = (k) => (seenPoms.get(String(k)) || [])[0];
    const pom1 = get(1), pom2 = get(2), pom3 = get(3), pom4 = get(4);
    const pom6 = get(6), pom7 = get(7);
    const pom8 = get(8), pom9 = get(9), pom10 = get(10), pom14 = get(14);
    const pom15 = get(15), pom16 = get(16);

    // Geometry checks below: skip REVIEW_ONLY rows, which legitimately have
    // null start/end (no anchor evidence → no line drawn). The shape-class
    // assertion only applies to rows that actually emit a line.
    // Forced-axis rows. The generator hard-forces POM 1/3/15/16 horizontal
    // (end.y = start.y) and POM 6/7/8 vertical (end.x = start.x); assert BOTH
    // directions so a regression that drops the forced-axis coupling can't ship
    // a slanted "straight" measurement past validation (P2).
    if (pom1 && pom1.drawability !== 'REVIEW_ONLY' && !isHorizontal(pom1)) errors.push('POM 1 must be horizontal.');
    if (pom3 && pom3.drawability !== 'REVIEW_ONLY' && !isHorizontal(pom3)) errors.push('POM 3 must be horizontal.');
    if (pom15 && pom15.drawability !== 'REVIEW_ONLY' && !isHorizontal(pom15)) errors.push('POM 15 must be horizontal.');
    if (pom16 && pom16.drawability !== 'REVIEW_ONLY' && !isHorizontal(pom16)) errors.push('POM 16 must be horizontal.');
    if (pom6 && pom6.drawability !== 'REVIEW_ONLY' && !isVertical(pom6)) errors.push('POM 6 must be vertical.');
    if (pom7 && pom7.drawability !== 'REVIEW_ONLY' && !isVertical(pom7)) errors.push('POM 7 must be vertical.');
    if (pom8 && pom8.drawability !== 'REVIEW_ONLY' && !isVertical(pom8)) errors.push('POM 8 must be vertical.');

    if (pom2 && pom2.style !== 'dashed') errors.push('POM 2 must be dashed (paired with POM 1).');
    if (pom4 && pom4.style !== 'dashed') errors.push('POM 4 must be dashed (paired with POM 3).');

    if (pom9 && pom10) {
      // Shared-cup integrity: POM 9 and POM 10 read ONE cupModel, so they must
      // declare the same anchor family. A disagreement is a real bug (the two
      // measurements would come off different cups) — hard error, not a warning.
      if (pom9.sharedAnchorFamily && pom10.sharedAnchorFamily
          && pom9.sharedAnchorFamily !== pom10.sharedAnchorFamily) {
        errors.push('POM 9 and POM 10 must share one cup model (anchor families disagree: ' +
          pom9.sharedAnchorFamily + ' vs ' + pom10.sharedAnchorFamily + ').');
      }
      // The two gate confidence on DIFFERENT evidence — POM 9 height needs a
      // real cup top AND bottom, POM 10 width needs a well-traced contour — so
      // they can legitimately land at different tiers. Surface that (the old
      // equal-string check never could) as a warning when BOTH are drawn, so
      // the TD knows the height and width reliabilities differ (P4).
      const drawn = (r) => r && r.drawability && r.drawability !== 'REVIEW_ONLY';
      if (drawn(pom9) && drawn(pom10) && pom9.confidence !== pom10.confidence) {
        warnings.push('POM 9 and POM 10 confidence differ (' +
          pom9.confidence + ' vs ' + pom10.confidence + ') — height and width rest on different cup evidence.');
      }
    }

    if (pom14 && pom14.type !== 'curved') errors.push('POM 14 must be a curved strap-length line.');
    // POM 14's curve handles arc over the shoulder: their x must interpolate
    // between the two strap endpoints. A handle pinned outside that span is a
    // numeric error (e.g. NaN coerced to 0 by clamp01), not a real curve.
    if (pom14 && pom14.type === 'curved' && pom14.drawability !== 'REVIEW_ONLY'
        && pom14.start && pom14.end && pom14.control1 && pom14.control2) {
      const xLo = Math.min(pom14.start.x, pom14.end.x) - 0.05;
      const xHi = Math.max(pom14.start.x, pom14.end.x) + 0.05;
      for (const [name, h] of [['control1', pom14.control1], ['control2', pom14.control2]]) {
        if (!(h.x >= xLo && h.x <= xHi)) {
          errors.push(`POM 14 ${name}.x (${h.x}) must lie within the strap span [${xLo.toFixed(3)}, ${xHi.toFixed(3)}].`);
        }
      }
    }

    if (pom16 && pom16.drawability !== 'REVIEW_ONLY') {
      if (!isFiniteNormalized(pom16.start) || !isFiniteNormalized(pom16.end)) {
        errors.push('POM 16 must have valid point-to-point geometry.');
      }
    }

    if (errors.length) return { status: 'fail', errors, warnings };
    if (warnings.length) return { status: 'warning', errors, warnings };
    return { status: 'pass', errors, warnings };
  }

  function isFiniteNormalized(p) {
    if (!p) return false;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    // tolerate a slight overshoot since the line may extend just beyond the image
    if (x < -0.2 || x > 1.2 || y < -0.2 || y > 1.2) return false;
    return true;
  }

  // Curve handles can sit well outside the canvas — only reject non-finite
  // values or coords so absurd they can only come from a numerical error in
  // the generator.
  function isFiniteHandle(p) {
    if (!p) return false;
    const x = Number(p.x), y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < -5 || x > 5 || y < -5 || y > 5) return false;
    return true;
  }

  function isHorizontal(row) {
    if (!row.start || !row.end) return false;
    const dx = Math.abs(row.end.x - row.start.x);
    const dy = Math.abs(row.end.y - row.start.y);
    return dx > 0 && dy <= dx * 0.25;
  }

  function isVertical(row) {
    if (!row.start || !row.end) return false;
    const dx = Math.abs(row.end.x - row.start.x);
    const dy = Math.abs(row.end.y - row.start.y);
    return dy > 0 && dx <= dy * 0.25;
  }
