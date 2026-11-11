// US-105: DXF Pattern Measure — the native-coordinate model, and the ONE set
// of entity converters every DXF parse runs.
//
// Each accepted entity becomes exact native geometry `{kind:'straight'|'arc'|
// 'curve', ...}` (see src/dxf/parse/dxf-path-kernel.js's header comment for the
// shapes): arcs, bulges and circles stay exactly circular, never
// Bézier-approximated, so the measurement kernel's arc length stays analytic.
// dxfParseDocumentAndModel (src/dxf/parse/dxf-parse.js) runs these converters
// ONCE per parse and builds both views from the one result: the board's
// Y-flipped straight/Bézier pieces, and the native model below.
//
// Until the ADR 0105 follow-up this file was a SECOND parse of the same text,
// run after the board's, with its own copy of every converter and of the
// INSERT resolution. The two were paired by index and drifted: the board's
// duplicate removal ran on Y-flipped coordinates and could keep a different
// copy than this file did, so with keepQualityCurves on the board drew lines
// Pattern Measure did not have (SE0583-LACE, SN1252). One parse cannot drift.
//
// Shared primitives come from dxf-parse.js by name (dxfNum, dxfOptNum,
// dxfFirst, dxfExtrusion, dxfPlanarOk, the dxfOk/dxfSkip/... outcome helpers,
// dxfParseLwpolylineVertices, dxfBulgeToArcParams, dxfSplineParts,
// dxfInsertParams, dxfInsertTransformPoint, dxfBlockRecordsFor).
// Source part for app.js. Run `npm run build` after editing.

  // ---- $INSUNITS header read --------------------------------------------------

  // dxfScanSections only tracks section boundaries (HEADER's own variables
  // are never collected — US-104 deliberately never needed them). This scans
  // the flat pair stream directly for the one header variable this story
  // needs: a `9 / $INSUNITS` marker followed, within a few pairs, by its
  // integer value at group 70. Safe to run over the WHOLE pair stream (not
  // section-scoped) because `$INSUNITS` as a header-variable NAME can only
  // legitimately appear in the HEADER section of a well-formed file; nothing
  // else in a DXF's ENTITIES/BLOCKS/TABLES content uses group code 9 for
  // this literal string.
  function dxfReadInsunits(pairs) {
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairs[i].code === 9 && String(pairs[i].value).trim() === '$INSUNITS') {
        for (let j = i + 1; j < pairs.length && j < i + 6; j += 1) {
          if (pairs[j].code === 70) {
            const n = Number(String(pairs[j].value).trim());
            return Number.isFinite(n) ? n : null;
          }
          if (pairs[j].code === 9 || pairs[j].code === 0) break;
        }
        return null;
      }
    }
    return null;
  }

  // ---- Per-entity converters ----------------------------------------------------

  function dxfNativeConvertLineEntity(rec) {
    const x1 = dxfNum(rec.pairs, 10), y1 = dxfNum(rec.pairs, 20);
    const x2 = dxfNum(rec.pairs, 11), y2 = dxfNum(rec.pairs, 21);
    if ([x1, y1, x2, y2].some(v => v === undefined)) return dxfMalformed('LINE missing 10/20 or 11/21');
    if (![x1, y1, x2, y2].every(Number.isFinite)) return dxfMalformed('LINE has a non-finite coordinate');
    const z1 = dxfOptNum(rec.pairs, 30, 0), z2 = dxfOptNum(rec.pairs, 31, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(z1) || !Number.isFinite(z2) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('LINE has a non-finite planarity field');
    }
    if (!dxfPlanarOk([z1, z2], thickness, ext)) return dxfNonPlanar('LINE is not flat');
    // RB-4 / US-127: a zero-length LINE (both endpoints exactly coincident)
    // has no direction and no meaningful length — reject it outright rather
    // than silently accepting a segment dxfSegmentLength would report as 0
    // (see that function's own "never a plausible 0" contract), and rather
    // than drawing it as the round dot `lineCap:'round'` makes of it.
    if (x1 === x2 && y1 === y2) return dxfDegenerate('LINE has zero length (coincident endpoints)');
    return dxfOk([{ kind: 'straight', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }]);
  }

  function dxfNativeConvertArcEntity(rec) {
    const cx = dxfNum(rec.pairs, 10), cy = dxfNum(rec.pairs, 20);
    const r = dxfNum(rec.pairs, 40);
    const a0Deg = dxfNum(rec.pairs, 50), a1Deg = dxfNum(rec.pairs, 51);
    if ([cx, cy, r, a0Deg, a1Deg].some(v => v === undefined)) return dxfMalformed('ARC missing 10/20/40/50/51');
    if (![cx, cy, r, a0Deg, a1Deg].every(Number.isFinite)) return dxfMalformed('ARC has a non-finite value');
    if (!(r > 0)) return dxfMalformed('ARC radius <= 0');
    const z = dxfOptNum(rec.pairs, 30, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(z) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('ARC has a non-finite planarity field');
    }
    if (!dxfPlanarOk([z], thickness, ext)) return dxfNonPlanar('ARC is not flat');
    // Always CCW from start to end per the DXF spec — this handles a
    // 350deg -> 10deg wraparound as a 20deg sweep, not a naive -340deg.
    const sweepDeg = ((a1Deg - a0Deg) % 360 + 360) % 360;
    if (!(sweepDeg > 1e-9)) return dxfMalformed('ARC has zero sweep');
    const sweepRad = sweepDeg * Math.PI / 180;
    const startRad = a0Deg * Math.PI / 180;
    return dxfOk([{ kind: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: startRad, sweep: sweepRad }]);
  }

  // A CIRCLE is one full-circle arc (sweep = 2*PI): the exact, natural
  // representation for the measurement kernel, and the arbitrary start angle
  // (0, matching the entity's own lack of one) does not affect any
  // measurement made on it — length, projection, and route enumeration all
  // work uniformly around the whole loop regardless of where t=0 sits. The
  // board draws it as exactly four quarter Béziers (dxfBoardCurvesForArc).
  function dxfNativeConvertCircleEntity(rec) {
    const cx = dxfNum(rec.pairs, 10), cy = dxfNum(rec.pairs, 20);
    const r = dxfNum(rec.pairs, 40);
    if ([cx, cy, r].some(v => v === undefined)) return dxfMalformed('CIRCLE missing 10/20/40');
    if (![cx, cy, r].every(Number.isFinite)) return dxfMalformed('CIRCLE has a non-finite value');
    if (!(r > 0)) return dxfMalformed('CIRCLE radius <= 0');
    const z = dxfOptNum(rec.pairs, 30, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(z) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('CIRCLE has a non-finite planarity field');
    }
    if (!dxfPlanarOk([z], thickness, ext)) return dxfNonPlanar('CIRCLE is not flat');
    return dxfOk([{ kind: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: 0, sweep: Math.PI * 2 }]);
  }

  // Shared by LWPOLYLINE and legacy POLYLINE: a bulged hop is an exact arc
  // (via dxfBulgeToArcParams). A repeated vertex — the closing vertex of a
  // polyline that already ends where it started, or a duplicated authoring
  // click — is a hop of length zero: not a line (it draws as a dot), never
  // measurable, and a non-topological member that keeps a boundary chain from
  // reading as closed. It is dropped and counted (US-127 / ADR 0102); the
  // entity's other hops stay.
  function dxfNativeVerticesToSegments(vertices, closed) {
    const segs = [];
    let rejectedDegenerateSegments = 0;
    const n = vertices.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      if (a.bulge) {
        const params = dxfBulgeToArcParams({ x: a.x, y: a.y }, { x: b.x, y: b.y }, a.bulge);
        if (!params) rejectedDegenerateSegments += 1;
        else segs.push({ kind: 'arc', center: { x: params.cx, y: params.cy }, radius: params.r, startAngle: params.a0, sweep: params.sweep });
      } else if (a.x !== b.x || a.y !== b.y) {
        segs.push({ kind: 'straight', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
      } else {
        rejectedDegenerateSegments += 1;
      }
    }
    return { segments: segs, rejectedDegenerateSegments };
  }

  function dxfNativeConvertLwpolylineEntity(rec) {
    const declaredRaw = dxfFirst(rec.pairs, 90);
    if (declaredRaw === undefined) return dxfMalformed('LWPOLYLINE missing group 90 vertex count');
    const declared = Number(String(declaredRaw).trim());
    if (!Number.isFinite(declared)) return dxfMalformed('LWPOLYLINE group 90 is not a finite number');
    const flags = dxfOptNum(rec.pairs, 70, 0);
    if (!Number.isFinite(flags)) return dxfMalformed('LWPOLYLINE has a non-finite flag value');
    const vertices = dxfParseLwpolylineVertices(rec.pairs);
    if (declared !== vertices.length) return dxfMalformed('LWPOLYLINE group-90 count does not match its vertex pairs');
    if (vertices.length < 2) return dxfMalformed('LWPOLYLINE has fewer than 2 vertices');
    for (const v of vertices) {
      if (!Number.isFinite(v.x) || !Number.isFinite(v.y) || !Number.isFinite(v.bulge)) {
        return dxfMalformed('LWPOLYLINE has a non-finite vertex or bulge value');
      }
    }
    const elevation = dxfOptNum(rec.pairs, 38, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(elevation) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('LWPOLYLINE has a non-finite planarity field');
    }
    if (!dxfPlanarOk([elevation], thickness, ext)) return dxfNonPlanar('LWPOLYLINE is not flat');
    const closed = (Math.trunc(flags) & 1) === 1;
    const converted = dxfNativeVerticesToSegments(vertices, closed);
    if (!converted.segments.length) return dxfDegenerate('LWPOLYLINE has no non-degenerate segment');
    return { ok: true, segments: converted.segments, rejectedDegenerateSegments: converted.rejectedDegenerateSegments };
  }

  function dxfNativeConvertPolylineEntity(rec) {
    const flagsRaw = dxfOptNum(rec.pairs, 70, 0);
    if (!Number.isFinite(flagsRaw)) return dxfMalformed('POLYLINE has a non-finite flag value');
    const flags = Math.trunc(flagsRaw);
    if ((flags & 2) || (flags & 4)) return dxfUnsupportedFit('POLYLINE has the curve-fit or spline-fit flag set');
    if ((flags & 8) || (flags & 16) || (flags & 64)) return dxfNonPlanar('POLYLINE is 3D/mesh (flag bit 3, 4, or 6)');
    const closed = (flags & 1) === 1;
    const headerZ = dxfOptNum(rec.pairs, 30, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(headerZ) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('POLYLINE has a non-finite planarity field');
    }
    const rawVertices = Array.isArray(rec.vertices) ? rec.vertices : [];
    if (rawVertices.length < 2) return dxfMalformed('POLYLINE has fewer than 2 vertices');
    const vertices = [];
    for (const vPairs of rawVertices) {
      const x = dxfNum(vPairs, 10), y = dxfNum(vPairs, 20);
      if (x === undefined || y === undefined) return dxfMalformed('POLYLINE VERTEX missing 10/20');
      const z = dxfOptNum(vPairs, 30, 0);
      const bulge = dxfOptNum(vPairs, 42, 0);
      if (![x, y, z, bulge].every(Number.isFinite)) return dxfMalformed('POLYLINE VERTEX has a non-finite value');
      vertices.push({ x, y, z, bulge });
    }
    if (!dxfPlanarOk([headerZ, ...vertices.map(v => v.z)], thickness, ext)) return dxfNonPlanar('POLYLINE is not flat');
    const converted = dxfNativeVerticesToSegments(vertices, closed);
    if (!converted.segments.length) return dxfDegenerate('POLYLINE has no non-degenerate segment');
    return { ok: true, segments: converted.segments, rejectedDegenerateSegments: converted.rejectedDegenerateSegments };
  }

  // ---- INSERT -> BLOCK resolution (ADR 0073) -----------------------------------
  //
  // 36/44 real factory files in the demo corpus keep every piece's geometry
  // inside a named BLOCK and reference it once via INSERT (see the INSERT
  // section of dxf-parse.js for the full motivation and the gates).

  // Exact similarity transform of a native segment: the INSERT gate below
  // enforces |sx| == |sy|, so the linear part R(angle)·diag(sx,sy) is a
  // similarity — circles map to circles with radius scaled by |sx|. The new
  // start angle is derived from the TRANSFORMED start point (not analytic
  // angle arithmetic), which is exact and uniform across all four sign
  // combinations of (sx, sy); a mirrored instance (sx·sy < 0) flips traversal
  // orientation, so the sweep sign flips — |sweep| is unchanged, so a
  // full-circle CIRCLE arc (sweep 2π) stays within the kernel's |sweep| <= 2π
  // contract.
  //
  // Object.assign clone, not a rebuilt object: the provenance stamped by
  // dxfNativeConvertEntity below (layer, entityType, handle, entityOrder,
  // partIndex) must survive the transform — ADR 0069 lost `instance` exactly
  // this way once, and the classifier reads `layer`.
  function dxfNativeApplyInsertTransformToSegment(seg, ins) {
    if (seg.kind === 'straight') {
      return Object.assign({}, seg, {
        a: dxfInsertTransformPoint(seg.a, ins),
        b: dxfInsertTransformPoint(seg.b, ins),
      });
    }
    // Beziers are affine-covariant: transforming the four control points
    // reproduces the transformed curve exactly. Without this branch a SPLINE
    // inside a BLOCK would fall through to the arc path below and read
    // `seg.center` off a curve.
    if (seg.kind === 'curve') {
      return Object.assign({}, seg, {
        p0: dxfInsertTransformPoint(seg.p0, ins),
        p1: dxfInsertTransformPoint(seg.p1, ins),
        p2: dxfInsertTransformPoint(seg.p2, ins),
        p3: dxfInsertTransformPoint(seg.p3, ins),
      });
    }
    const center = dxfInsertTransformPoint(seg.center, ins);
    const radius = seg.radius * Math.abs(ins.sx);
    const start = dxfInsertTransformPoint(dxfPointOnArcSegment(seg, 0), ins);
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const sweep = ins.sx * ins.sy < 0 ? -seg.sweep : seg.sweep;
    return Object.assign({}, seg, { center, radius, startAngle, sweep });
  }

  // `buckets` is the parse's shared {board, native} rejection tally
  // (dxfCountRejected): a block's own rejected children (e.g. TEXT alongside
  // LINE) are counted here as they're found, so one tally covers both
  // directly-placed and block-resolved entities. `instance` (ADR 0069) is
  // opaque here — always the SAME value this call's own caller was given,
  // propagated unchanged to every child so a piece assembled from nested
  // INSERTs still shares one instance boundary. `order` is the TOP-LEVEL
  // entity index: every segment resolved out of a block (however deeply
  // nested) inherits the placing INSERT's own order.
  function dxfNativeConvertInsertEntity(rec, blocks, depth, buckets, instance, order, ordinal) {
    const p = dxfInsertParams(rec);
    if (p.blockName == null) return dxfMalformed('INSERT missing block name (group 2)');
    if (![p.ix, p.iy, p.sx, p.sy, p.angleRad].every(Number.isFinite)) return dxfMalformed('INSERT has a non-finite placement field');
    if (Math.abs(p.sx) < 1e-9 || Math.abs(p.sy) < 1e-9) return dxfMalformed('INSERT has a zero scale factor');
    if (Math.abs(Math.abs(p.sx) - Math.abs(p.sy)) > 1e-6) {
      return dxfUnsupportedType('INSERT has non-uniform scale (X and Y scale differ), not supported');
    }
    if ((p.colCount && p.colCount !== 1) || (p.rowCount && p.rowCount !== 1)) {
      return dxfUnsupportedType('INSERT is a rectangular array (MINSERT), not supported');
    }
    // The k-th top-level INSERT of a name takes the k-th definition
    // (dxfBlockRecordsFor).
    const blockRecords = dxfBlockRecordsFor(blocks, p.blockName, ordinal);
    if (!blockRecords) return dxfMalformed('INSERT references an undefined block "' + p.blockName + '"');
    if (depth >= DXF_INSERT_MAX_DEPTH) return dxfMalformed('INSERT nesting is too deep (possible circular BLOCK reference)');
    const segments = [];
    // US-127: a block child's own dropped zero-length hops ride up with the
    // geometry so one instance's count reaches the import toast (the child's
    // whole-entity rejections are tallied into `buckets` directly).
    let rejectedDegenerateSegments = 0;
    for (const childRec of blockRecords) {
      const result = dxfNativeConvertEntityResolvingBlocks(childRec, blocks, depth + 1, buckets, instance, order);
      if (!result.ok) { dxfCountRejected(buckets, result); continue; }
      rejectedDegenerateSegments += result.rejectedDegenerateSegments || 0;
      segments.push(...result.segments);
    }
    if (!segments.length) return dxfMalformed('INSERT\'s block "' + p.blockName + '" has no supported geometry');
    return {
      ok: true,
      segments: segments.map(seg => dxfNativeApplyInsertTransformToSegment(seg, p)),
      rejectedDegenerateSegments,
    };
  }

  // Dispatch + `instance` stamp (ADR 0069: piece detection must never union
  // segments from different placed instances — a grading-nest file's
  // overlapping sizes would fuse). NOTE this wrapper deliberately does NOT
  // reduce its return to `{ok, segments}`: the converters also report
  // `rejectedDegenerateSegments` (RB-4), and dropping that field here would
  // silently zero the count for every entity.
  function dxfNativeConvertEntityResolvingBlocks(rec, blocks, depth, buckets, instance, order, ordinal) {
    const result = rec.type === 'INSERT'
      ? dxfNativeConvertInsertEntity(rec, blocks, depth, buckets, instance, order, ordinal)
      : dxfNativeConvertEntity(rec, order);
    if (!result.ok) return result;
    return {
      ok: true,
      segments: result.segments.map(seg => Object.assign({}, seg, { instance })),
      rejectedDegenerateSegments: result.rejectedDegenerateSegments || 0,
    };
  }

  // The one SPLINE reader (dxfSplineParts) mapped onto the native
  // `{kind:'curve', p0,p1,p2,p3}` shape the measurement kernel understands.
  function dxfNativeConvertSplineEntity(rec) {
    const read = dxfSplineParts(rec);
    if (!read.ok) return read;
    if (!read.parts.length) return dxfDegenerate('SPLINE has no non-degenerate span');
    const segments = read.parts.map(part => (part.type === 'line'
      ? { kind: 'straight', a: part.a, b: part.b }
      : { kind: 'curve', p0: part.p0, p1: part.p1, p2: part.p2, p3: part.p3 }));
    return { ok: true, segments, rejectedDegenerateSegments: read.degenerate };
  }

  // Dispatch, then stamp provenance onto every segment the entity produced:
  // `layer` (group 8 — the ASTM layer dxfClassifyPatterns reads to tell a
  // piece boundary from a grain line, sew line or internal mark), the source
  // `entityType`, and the handle, the entity's own order in the file and its
  // part index ("original entity order and direction" per the checklist, kept
  // on the segment itself rather than threaded separately through every
  // later consumer).
  function dxfNativeConvertEntity(rec, order) {
    const result = (() => {
      switch (rec.type) {
        case 'LINE': return dxfNativeConvertLineEntity(rec);
        case 'ARC': return dxfNativeConvertArcEntity(rec);
        case 'CIRCLE': return dxfNativeConvertCircleEntity(rec);
        case 'LWPOLYLINE': return dxfNativeConvertLwpolylineEntity(rec);
        case 'POLYLINE': return dxfNativeConvertPolylineEntity(rec);
        case 'SPLINE': return dxfNativeConvertSplineEntity(rec);
        // Phase 3 (ADR 0091): ASTM turn/curve points, notches, drill holes and
        // annotation text are standard non-geometry, not "unsupported" — they
        // are counted by dxfCollectMarks and reported as what they are.
        case 'POINT': case 'TEXT': case 'MTEXT':
          return dxfSkip('nonGeometry', rec.type + ' is a mark/annotation, not drawn geometry');
        default: return dxfUnsupportedType('entity type "' + rec.type + '" is not supported');
      }
    })();
    if (!result.ok) return result;
    const layer = dxfFirst(rec.pairs, 8);
    const handle = dxfFirst(rec.pairs, 5);
    const segments = result.segments.map((seg, partIndex) => Object.assign({}, seg, {
      layer: layer == null ? null : String(layer).trim(),
      handle: handle == null ? null : String(handle).trim(),
      entityOrder: order,
      partIndex,
      entityType: rec.type,
    }));
    return { ok: true, segments, rejectedDegenerateSegments: result.rejectedDegenerateSegments || 0 };
  }

  // ---- The native model (pure; no state/DOM) -----------------------------------

  // The native-model view of an ACCEPTED parse (dxfParseDocumentAndModel):
  // `pieces` are [{segments}] in native coordinates, the same pieces in the
  // same order as the board's, so makeDxfMeasureSession pairs them by index.
  // `patterns`/`stats` are the one classification's, shared with the board
  // view — they count board LINES (dxfBoardLineCount: a circle is 4).
  function dxfNativeModelView(parse) {
    const { insunits, pieces } = parse;
    const unitInfo = dxfResolveNativeToInch(insunits);
    // US-126: auto-scale. The $INSUNITS header stays authoritative wherever
    // the file declares one this tool understands — a declaration is evidence
    // and a size statistic is only an inference. When it does NOT (31 of the
    // 41 corpus files), the piece geometry itself decides between inches and
    // millimetres instead of falling back on the locked default-inch guess,
    // which silently under-reported every mm file by 25.4x. See
    // dxfInferUnitFromGeometry for the evidence and why it never guesses cm.
    //
    // For a file that DOES declare units, the same inference still runs, but
    // only to record a cross-check: a header that disagrees with the geometry
    // by a factor of 25 is worth naming in the panel, not worth overruling.
    const inferred = dxfInferUnitFromGeometry(pieces);
    let unit = unitInfo.factor;
    let unitSource = unitInfo.unitSource;
    let unitDiagnostic = unitInfo.diagnostic;
    if (unitSource !== 'dxf-header' && inferred) {
      unit = inferred.factor;
      unitSource = 'inferred-geometry';
      unitDiagnostic = {
        code: insunits != null ? insunits : null,
        // The fact that the file DID declare something this tool cannot read
        // must survive the inference — 'unsupported-explicit-unit' and
        // 'default-inch' are different situations (RB-4) and an auto-scale
        // that erased the distinction would tell a TD the file was silent
        // when it was not.
        unsupportedDeclaredCode: unitInfo.unitSource === 'unsupported-explicit-unit' ? insunits : null,
        inferredKey: inferred.key,
        medianPieceDiag: inferred.medianPieceDiag,
        extentDiag: inferred.extentDiag,
        message: (unitInfo.unitSource === 'unsupported-explicit-unit'
          ? 'This DXF declares $INSUNITS=' + insunits + ', which this tool does not recognize. '
          : 'This DXF declares no units. ')
          + 'Its pieces measure '
          + (Math.round(inferred.medianPieceDiag * inferred.factor * 10) / 10)
          + ' in across (median), which fits ' + inferred.key + ' and no other supported unit.',
      };
    } else if (unitSource === 'dxf-header' && inferred && Math.abs(inferred.factor - unitInfo.factor) > unitInfo.factor * 1e-6) {
      unitDiagnostic = {
        code: insunits,
        inferredKey: inferred.key,
        medianPieceDiag: inferred.medianPieceDiag,
        extentDiag: inferred.extentDiag,
        message: 'This DXF declares $INSUNITS=' + insunits + ', but its piece sizes fit '
          + inferred.key + '. The declared unit was used; check the values against a known length.',
      };
    }
    return {
      ok: true,
      pieces,
      patterns: parse.patterns,
      stats: parse.stats,
      unit,
      unitSource,
      unitDiagnostic,
      insunits,
      buckets: parse.buckets,
      skippedOversizedPieces: parse.skippedOversizedPieces,
    };
  }

  // text -> { ok, pieces: [{segments}], patterns, stats, unit, unitSource,
  // unitDiagnostic, insunits, buckets, skippedOversizedPieces } | { ok:false,
  // atomic, reason, message, buckets }. An import does not call this — it
  // takes both views from its one dxfParseDocumentAndModel — but a saved
  // project's pattern source re-parses its text on reopen
  // (rebuildDxfMeasureSessionFromActiveSource) and needs only this view.
  // `options.keepQualityCurves` must be the value the board import used —
  // dxfPatternSource carries it for every later rebuild.
  function parseDxfNativeModel(text, options) {
    return dxfParseDocumentAndModel(text, options).native;
  }
