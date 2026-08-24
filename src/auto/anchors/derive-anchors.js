// Derived-anchor cascade (Phase 3, plan 2). Source part for app.js.
// Run `npm run build` after editing.
//
// Some anchors are geometric consequences of other anchors: cf-bottom and
// cradle-cup-bottom are both "project this seam point straight down onto
// the band line" (rule.md POM 6/7 contracts). When the TD drags a primary
// anchor, the dependents should follow instead of demanding their own drag.
//
// Derivation rules live in auto_mode_rules/anchor-schema.json as a
// `derivation` field on the DERIVED anchor's row:
//
//   { "kind": "cf-bottom", ...,
//     "derivation": { "method": "drop_to_line",
//                     "args": ["cf-top", "band-left", "band-right"],
//                     "axis": "vertical" } }
//
// Seeding behavior is deliberately unchanged: detection still places every
// anchor (ink evidence beats formula), and the cascade only re-derives a
// dependent WHILE the TD drags one of its primaries. Dragging a derived
// anchor directly pins it (`derivedPinned`) so the cascade never fights a
// deliberate TD correction — the pin clears on the next reseed.
//
// Supported methods (args are anchor kinds):
//   midpoint          [a, b]           → (a + b) / 2
//   offset_along_axis [from, to] + t   → from + t * (to - from)
//   reflect           [p, axis]        → p mirrored across the vertical line
//                                        through axis
//   intersection      [a1, a2, b1, b2] → line a1→a2 ∩ line b1→b2
//   drop_to_line      [p, l1, l2] + axis → axis-aligned line through p
//                                        ∩ (extended) line l1→l2
//
// `preserveOffset: true` on a drop_to_line rule keeps the gap the SEEDER put
// between the anchor and that line instead of snapping it flat onto it. Both
// current drop_to_line anchors need it: cf-bottom and cradle-cup-bottom are
// seeded from HEM ink at their own column (US-061 — the band row, the band
// chord and the per-column hem are three different rows, and a real hem arches
// ~30px), so a plain projection threw that away the first time a TD nudged a
// band end. Measured over the demo corpus the discarded gap is 0 on five of
// seven sketches and up to 0.028 of image height on demo5 — small, but it is
// the whole point of US-061 and it went silently.

  function anchorDerivationForKind(kind) {
    if (!kind) return null;
    for (const schema of ANCHOR_SCHEMA) {
      if (schema.kind === kind) return schema.derivation || null;
    }
    return null;
  }

  // Recompute derived anchors from their primaries, in place.
  //
  // anchors — live anchor records ({ kind, x, y, ... }); mutated.
  // options.changedKind — only re-derive dependents of this kind (a drag
  //   cascade); omit to re-derive everything derivable.
  // options.schema — schema override for tests; defaults to ANCHOR_SCHEMA.
  //
  // Returns the list of anchor kinds that actually moved.
  function deriveAnchors(anchors, options) {
    const opts = options || {};
    const schemaList = opts.schema || ANCHOR_SCHEMA;
    if (!Array.isArray(anchors) || !anchors.length) return [];

    const byKind = Object.create(null);
    for (const a of anchors) {
      if (a && a.kind && !(a.kind in byKind)) byKind[a.kind] = a;
    }

    const updated = [];
    for (const schema of schemaList) {
      const rule = schema && schema.derivation;
      if (!rule || !Array.isArray(rule.args)) continue;
      if (opts.changedKind && rule.args.indexOf(opts.changedKind) === -1) continue;

      const target = byKind[schema.kind];
      // Missing target = the seed layer gated it out (e.g. POM 7 demoted);
      // never fabricate an anchor the detection refused to place.
      if (!target) continue;
      if (target.derivedPinned) continue;

      const args = rule.args.map(kind => byKind[kind]);
      if (args.some(a => !a)) continue;

      const pos = computeDerivedPosition(rule, args,
        rule.preserveOffset ? (target.derivedOffset || 0) : 0);
      if (!pos) continue;
      const nx = clamp01(pos.x);
      const ny = clamp01(pos.y);
      if (Math.abs(nx - target.x) < 1e-6 && Math.abs(ny - target.y) < 1e-6) continue;
      target.x = nx;
      target.y = ny;
      target.derivedFrom = rule.args.slice();
      updated.push(target.kind);
    }
    return updated;
  }

  // `offset` shifts the result along the rule's axis; it is 0 for every method
  // except a preserveOffset drop_to_line (see deriveAnchors above).
  function computeDerivedPosition(rule, args, offset) {
    const shift = Number.isFinite(offset) ? offset : 0;
    const method = rule.method;
    if (method === 'midpoint' && args.length >= 2) {
      return {
        x: (args[0].x + args[1].x) / 2,
        y: (args[0].y + args[1].y) / 2,
      };
    }
    if (method === 'offset_along_axis' && args.length >= 2) {
      const t = Number.isFinite(rule.t) ? rule.t : 0.5;
      return {
        x: args[0].x + t * (args[1].x - args[0].x),
        y: args[0].y + t * (args[1].y - args[0].y),
      };
    }
    if (method === 'reflect' && args.length >= 2) {
      return { x: 2 * args[1].x - args[0].x, y: args[0].y };
    }
    if (method === 'intersection' && args.length >= 4) {
      return lineIntersectionPoint(
        args[0], args[1],
        args[2], args[3]
      );
    }
    if (method === 'drop_to_line' && args.length >= 3) {
      const p = args[0];
      // Encode the axis-aligned line through p as a second point offset
      // along that axis, then reuse the generic intersection.
      const p2 = rule.axis === 'horizontal'
        ? { x: p.x + 1, y: p.y }
        : { x: p.x, y: p.y + 1 };
      const hit = lineIntersectionPoint(p, p2, args[1], args[2]);
      if (hit) {
        return rule.axis === 'horizontal'
          ? { x: hit.x + shift, y: hit.y }
          : { x: hit.x, y: hit.y + shift };
      }
      // A5: the target line is (near-)parallel to the drop — e.g. the band was
      // drawn vertical, so a vertical drop can't intersect it. Rather than
      // return null and leave the dependent (cf-bottom / cradle-cup-bottom)
      // frozen at a stale position while its primary moves, drop p onto the
      // MEAN of the two line-defining points along the drop axis so it still
      // tracks the primary.
      return rule.axis === 'horizontal'
        ? { x: (args[1].x + args[2].x) / 2 + shift, y: p.y }
        : { x: p.x, y: (args[1].y + args[2].y) / 2 + shift };
    }
    return null;
  }

  // Infinite-line intersection. Returns null for (near-)parallel lines —
  // e.g. a vertical drop onto a band line that is itself vertical would be
  // meaningless, so the caller just leaves the anchor where it is.
  function lineIntersectionPoint(a1, a2, b1, b2) {
    const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
    const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
    const denom = d1x * d2y - d1y * d2x;
    if (Math.abs(denom) < 1e-9) return null;
    const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
    return { x: a1.x + t * d1x, y: a1.y + t * d1y };
  }

  // Measure the gap the SEEDER left between a preserveOffset dependent and the
  // line it is derived from, and record it on the anchor.
  //
  // This has to run at seed time, while the anchors are still exactly where
  // detection put them. Measuring it lazily on the first cascade looks
  // equivalent and is not: by then the primary has already moved, so the gap
  // comes out relative to the NEW line and the dependent freezes in place
  // instead of following. (That is not hypothetical — it is what the first cut
  // of this did, and pipeline-tests caught it.)
  //
  // Anchors that never went through the seeder — synthetic ones in tests —
  // simply have no derivedOffset, so the rules behave exactly as they did
  // before preserveOffset existed.
  function captureDerivedOffsets(anchors, schemaOverride) {
    if (!Array.isArray(anchors) || !anchors.length) return anchors;
    const schemaList = schemaOverride || ANCHOR_SCHEMA;
    const byKind = Object.create(null);
    for (const a of anchors) {
      if (a && a.kind && !(a.kind in byKind)) byKind[a.kind] = a;
    }
    for (const schema of schemaList) {
      const rule = schema && schema.derivation;
      if (!rule || !rule.preserveOffset || !Array.isArray(rule.args)) continue;
      const target = byKind[schema.kind];
      if (!target) continue;
      const args = rule.args.map(kind => byKind[kind]);
      if (args.some(a => !a)) continue;
      const base = computeDerivedPosition(rule, args, 0);
      if (!base) continue;
      target.derivedOffset = rule.axis === 'horizontal'
        ? target.x - base.x
        : target.y - base.y;
    }
    return anchors;
  }

  // Drag-cascade entry point: called from the anchor mousemove handler so
  // dependents track their primary live during the drag.
  function cascadeDerivedAnchors(changedAnchor) {
    if (!changedAnchor || !changedAnchor.kind) return [];
    if (!state.autoMode.anchors.length) return [];
    return deriveAnchors(state.autoMode.anchors, { changedKind: changedAnchor.kind });
  }
