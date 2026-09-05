// US-105: DXF Pattern Measurement — the native-coordinate parser adapter.
// Parses the SAME DXF text US-104's importDxfText already accepts, but into
// exact native `{kind:'straight'|'arc', ...}` geometry (see
// src/geometry/dxf-path-kernel.js's header comment for the shapes) instead of
// the board-annotation-ready straight/Bézier segments parseDxfDocument
// builds — arcs and bulges stay exactly circular here, never
// Bézier-approximated, so the measurement kernel's arc length stays
// analytic.
//
// Deliberately a SEPARATE parse over the same tokenized pairs, not a
// modification of parseDxfDocument: that function (src/manual/dxf-import.js)
// is a closed, 119-assertion-tested contract (dxf-import-check.mjs), and this
// story's own "compatibility-preserving adapter" requirement is satisfied
// most safely by never touching its observable output at all. This file
// reuses that file's PURE, already-correct primitives by name
// (dxfNormalizeText, dxfTokenizePairs, dxfScanSections, dxfNum, dxfOptNum,
// dxfFirst, dxfExtrusion, dxfPlanarOk, dxfOk/dxfSkip/dxfMalformed/
// dxfNonPlanar/dxfUnsupportedType/dxfUnsupportedFit, dxfParseLwpolylineVertices,
// dxfBulgeToArcParams, dxfBuildPieces, and the DXF_*_CAP/DXF_BINARY_SENTINEL
// constants) rather than duplicating them — only the "which shape do I build
// from this entity" step differs from that file's own converters, and that
// step is duplicated deliberately per the same reasoning.
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

  // ---- Per-entity native converters (mirrors dxf-import.js's converters —
  // same validation/malformed/planarity rules, native line/arc output) ------

  function dxfNativeConvertLineEntity(rec) {
    const x1 = dxfNum(rec.pairs, 10), y1 = dxfNum(rec.pairs, 20);
    const x2 = dxfNum(rec.pairs, 11), y2 = dxfNum(rec.pairs, 21);
    if ([x1, y1, x2, y2].some(v => v === undefined)) return dxfMalformed('LINE missing 10/20 or 11/21');
    if (![x1, y1, x2, y2].every(Number.isFinite)) return dxfMalformed('LINE has a non-finite coordinate');
    // RB-4: a zero-length LINE (both endpoints exactly coincident) has no
    // direction and no meaningful length — reject it outright rather than
    // silently accepting a segment dxfSegmentLength would report as 0 (see
    // that function's own "never a plausible 0" contract; a segment that
    // SHOULD never have existed is a different failure than an invalid
    // length calculation on a real one).
    if (x1 === x2 && y1 === y2) return dxfMalformed('LINE has zero length (coincident endpoints)');
    const z1 = dxfOptNum(rec.pairs, 30, 0), z2 = dxfOptNum(rec.pairs, 31, 0);
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(z1) || !Number.isFinite(z2) || !Number.isFinite(thickness) || !ext.finite) {
      return dxfMalformed('LINE has a non-finite planarity field');
    }
    if (!dxfPlanarOk([z1, z2], thickness, ext)) return dxfNonPlanar('LINE is not flat');
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
    // Same wraparound-safe sweep as convertDxfArcEntity: 350deg -> 10deg is a
    // 20deg CCW sweep, never a naive -340deg.
    const sweepDeg = ((a1Deg - a0Deg) % 360 + 360) % 360;
    if (!(sweepDeg > 1e-9)) return dxfMalformed('ARC has zero sweep');
    const sweepRad = sweepDeg * Math.PI / 180;
    const startRad = a0Deg * Math.PI / 180;
    return dxfOk([{ kind: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: startRad, sweep: sweepRad }]);
  }

  // A CIRCLE is one full-circle arc (sweep = 2*PI). Unlike the board
  // annotation model (which has no closed-loop annotation type and must
  // split a circle into four quadrant curves — see convertDxfCircleEntity),
  // the native measurement kernel has no such constraint: a single arc with
  // a full sweep is the exact, natural representation, and the arbitrary
  // start angle (0, matching the entity's own lack of one) does not affect
  // any measurement made on it — length, projection, and route enumeration
  // all work uniformly around the whole loop regardless of where t=0 sits.
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

  // Shared by LWPOLYLINE and legacy POLYLINE, mirroring
  // dxfPolylineVerticesToSegments but emitting a native arc (via
  // dxfBulgeToArcParams) instead of Bézier chunks for a bulged segment. A
  // A repeated vertex is malformed measurement geometry. US-104 may still
  // display the other segments from that entity, but Pattern Measure must not
  // silently erase one authored hop and then claim its shortened topology is
  // the factory path.
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
    if (!converted.segments.length) return dxfMalformed('LWPOLYLINE has no non-degenerate segment');
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
    if (!converted.segments.length) return dxfMalformed('POLYLINE has no non-degenerate segment');
    return { ok: true, segments: converted.segments, rejectedDegenerateSegments: converted.rejectedDegenerateSegments };
  }

  // ---- INSERT -> BLOCK resolution (ADR 0073, reversing ADR 0068 item 1) ----
  //
  // Same real-world motivation as dxf-import.js's dxfConvertInsertEntity:
  // 36/44 real factory files in the demo corpus keep every piece's geometry
  // inside a named BLOCK and reference it once via INSERT — without resolving
  // that here, Pattern Measure was structurally dead on all of them (the
  // board displayed the pieces, this parser returned reason:'empty'; see
  // findings-dxf.md Finding 1). Gates and reason strings mirror the board
  // converter byte-for-byte so the two parses never disagree about WHICH
  // entities are acceptable — only about the shape of the accepted geometry.

  // Exact similarity transform of a native segment. Unlike the board's
  // dxfApplyInsertTransformToSegment (straight/curve only — the board never
  // has an 'arc' kind at INSERT time), this must map an exact arc to an
  // exact arc: the INSERT gate below enforces |sx| == |sy|, so the linear
  // part R(angle)·diag(sx,sy) is a similarity — circles map to circles with
  // radius scaled by |sx|. The new start angle is derived from the
  // TRANSFORMED start point (not analytic angle arithmetic), which is exact
  // and uniform across all four sign combinations of (sx, sy); a mirrored
  // instance (sx·sy < 0) flips traversal orientation, so the sweep sign
  // flips — |sweep| is unchanged, so a full-circle CIRCLE arc (sweep 2π)
  // stays within the kernel's |sweep| <= 2π contract.
  //
  // Object.assign clone, not a rebuilt object: native segments already carry
  // provenance (layer/handle/entityOrder/partIndex, stamped by
  // dxfNativeConvertEntity below) that must survive the transform — the
  // board's transform rebuilds bare objects only because the board stamps
  // nothing at that stage.
  function dxfNativeApplyInsertTransformToSegment(seg, ins) {
    if (seg.kind === 'straight') {
      return Object.assign({}, seg, {
        a: dxfInsertTransformPoint(seg.a, ins),
        b: dxfInsertTransformPoint(seg.b, ins),
      });
    }
    const center = dxfInsertTransformPoint(seg.center, ins);
    const radius = seg.radius * Math.abs(ins.sx);
    const start = dxfInsertTransformPoint(dxfPointOnArcSegment(seg, 0), ins);
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const sweep = ins.sx * ins.sy < 0 ? -seg.sweep : seg.sweep;
    return Object.assign({}, seg, { center, radius, startAngle, sweep });
  }

  // `order` is the TOP-LEVEL entity index — every segment resolved out of a
  // block (however deeply nested) inherits the placing INSERT's own order,
  // while keeping the child entity's layer/handle (nothing downstream
  // consumes entityOrder today; it stays pure provenance).
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
    // Same k-th-definition rule as the board parser (dxfBlockRecordsFor).
    const blockRecords = dxfBlockRecordsFor(blocks, p.blockName, ordinal);
    if (!blockRecords) return dxfMalformed('INSERT references an undefined block "' + p.blockName + '"');
    if (depth >= DXF_INSERT_MAX_DEPTH) return dxfMalformed('INSERT nesting is too deep (possible circular BLOCK reference)');
    const segments = [];
    let rejectedDegenerateSegments = 0;
    for (const childRec of blockRecords) {
      const result = dxfNativeConvertEntityResolvingBlocks(childRec, blocks, depth + 1, buckets, instance, order);
      if (!result.ok) { buckets[result.bucket] += 1; continue; }
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
  // segments from different placed instances — without this, a grading-nest
  // file's overlapping sizes fuse on the native side and the piece list
  // diverges from the board's, nulling every pieceAnchor in
  // makeDxfMeasureSession). NOTE this wrapper deliberately does NOT copy the
  // board wrapper's `{ok, segments}`-only return shape: this parser's
  // converters also report `rejectedDegenerateSegments` (RB-4), and dropping
  // that field here would silently zero the bucket for every entity.
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

  // Dispatch, then stamp provenance (layer, handle when present, and the
  // entity's own order in the file) onto every segment the entity produced —
  // "original entity order and direction" per the checklist, kept on the
  // segment itself rather than threaded separately through every later
  // consumer.
  function dxfNativeConvertEntity(rec, order) {
    const result = (() => {
      switch (rec.type) {
        case 'LINE': return dxfNativeConvertLineEntity(rec);
        case 'ARC': return dxfNativeConvertArcEntity(rec);
        case 'CIRCLE': return dxfNativeConvertCircleEntity(rec);
        case 'LWPOLYLINE': return dxfNativeConvertLwpolylineEntity(rec);
        case 'POLYLINE': return dxfNativeConvertPolylineEntity(rec);
        // Phase 3 (ADR 0091): same non-geometry bucket as the board parser.
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
    }));
    return { ok: true, segments, rejectedDegenerateSegments: result.rejectedDegenerateSegments || 0 };
  }

  // ---- Document-level native parse (pure; no state/DOM) ----------------------

  // text -> { ok, pieces: [{segments}], unit, unitSource, insunits, buckets,
  // skippedOversizedPieces } | { ok:false, reason, message, buckets }. Reuses
  // parseDxfDocument's own binary/corrupt-file/section-scan gates and its
  // three output caps verbatim (same constants, same thresholds, same
  // atomic-vs-partial behavior) so the two parses never disagree about
  // whether a given file is acceptable — only about what SHAPE the accepted
  // geometry takes.
  // `options.keepQualityCurves` (Phase 3) must be the SAME value the board
  // import used — importDxfText passes it, and dxfPatternSource carries it
  // for every later rebuild — or the two parsers' pieces stop matching.
  function parseDxfNativeModel(text, options) {
    const normalized = dxfNormalizeText(text);
    if (normalized.slice(0, DXF_BINARY_SENTINEL.length) === DXF_BINARY_SENTINEL) {
      return {
        ok: false, atomic: true, reason: 'binary',
        message: 'This looks like a binary DXF file. Re-export as ASCII DXF and try again.',
      };
    }
    const pairs = dxfTokenizePairs(normalized);
    if (!pairs) {
      return { ok: false, atomic: true, reason: 'corrupt', message: 'This file is not a valid ASCII DXF file.' };
    }
    const scan = dxfScanSections(pairs);
    if (scan.error) {
      return { ok: false, atomic: true, reason: 'corrupt', message: 'This file is not a valid ASCII DXF file (' + scan.error + ').' };
    }
    const insunits = dxfReadInsunits(pairs);
    const unitInfo = dxfResolveNativeToInch(insunits);
    const buckets = { unsupportedType: 0, nonPlanar: 0, unsupportedFit: 0, malformed: 0, nonGeometry: 0, rejectedDegenerateSegments: 0 };
    const acceptedSegments = [];
    // ADR 0073: same instance-id scheme as parseDxfDocument (ADR 0069) —
    // instance 0 for every directly-placed entity, a fresh id per top-level
    // INSERT (nested INSERTs inherit their parent's) — so dxfBuildPieces
    // groups the native pieces exactly the way it groups the board's,
    // keeping makeDxfMeasureSession's count-based pieceAnchors pairing alive.
    let nativeNextInstanceId = 1;
    const nativeInsertOrdinals = new Map();
    const pipelineVersion = dxfPipelineVersionOf(options);
    scan.entityRecords.forEach((rec, order) => {
      const instance = rec.type === 'INSERT' ? nativeNextInstanceId++ : 0;
      let ordinal = 0;
      if (rec.type === 'INSERT') {
        const blockName = dxfInsertParams(rec).blockName;
        ordinal = nativeInsertOrdinals.get(blockName) || 0;
        nativeInsertOrdinals.set(blockName, ordinal + 1);
        if (pipelineVersion === 1) ordinal = 'all';
      }
      const result = dxfNativeConvertEntityResolvingBlocks(rec, scan.blocks, 0, buckets, instance, order, ordinal);
      if (!result.ok) { buckets[result.bucket] += 1; return; }
      buckets.rejectedDegenerateSegments += result.rejectedDegenerateSegments || 0;
      acceptedSegments.push(...result.segments);
    });
    if (!acceptedSegments.length) {
      return { ok: false, atomic: true, reason: 'empty', message: 'No supported entities were found in this DXF file.', buckets };
    }
    // Reused verbatim from dxf-import.js: connected-component + containment-
    // merge piece detection, which already works generically off
    // dxfSegmentEndpoints/dxfSegmentPoints — both extended for the 'arc' kind
    // this file emits. No Y-flip here: native space stays exactly as
    // authored (see this file's header comment).
    //
    // ADR 0091: the same dxfClassifyPatterns the board parser runs, on the
    // same `instance`/`layer`-stamped segments — the ONLY thing keeping the
    // count-and-order pairing in makeDxfMeasureSession alive is that both
    // parsers group through this one function. Point-in-polygon containment
    // is invariant under the board's Y-flip, so the two agree without it.
    const classified = dxfClassifyPatterns(acceptedSegments, {
      keepQualityCurves: !!(options && options.keepQualityCurves),
      excludeInstances: (options && Array.isArray(options.excludeInstances)) ? options.excludeInstances : [],
      onProgress: (options && typeof options.onProgress === 'function') ? options.onProgress : null,
      pipelineVersion,
    });
    const allPieces = classified.pieces;
    // Phase 4: no piece-count rejection here either (see
    // DXF_PATTERN_BATCH_THRESHOLD in dxf-import.js) — the board import that
    // preceded this call already decided the file is placeable.
    const keptPieces = [];
    const keptPatterns = [];
    let skippedOversizedPieces = 0;
    for (let i = 0; i < allPieces.length; i += 1) {
      const piece = allPieces[i];
      // Same exemption as parseDxfDocument (ADR 0091): a classified pattern
      // is never dropped by the per-piece cap — the two parsers must keep
      // the identical piece list or makeDxfMeasureSession's index pairing
      // breaks.
      if (piece.length > DXF_PER_PIECE_CAP && classified.patterns[i].kind !== 'classified') { skippedOversizedPieces += 1; continue; }
      keptPieces.push(piece);
      keptPatterns.push(classified.patterns[i]);
    }
    if (!keptPieces.length) {
      return {
        ok: false, atomic: true, reason: 'empty-after-piece-cap', buckets,
        message: 'Every piece in this DXF exceeded the ' + DXF_PER_PIECE_CAP + '-line per-piece limit. Import rejected.',
      };
    }
    const totalOutputCount = keptPieces.reduce((sum, piece) => sum + piece.length, 0);
    if (totalOutputCount > DXF_TOTAL_OUTPUT_CAP) {
      return {
        ok: false, atomic: true, reason: 'total-cap', buckets,
        message: 'This DXF would place ' + totalOutputCount + ' lines, over the ' + DXF_TOTAL_OUTPUT_CAP + '-line combined limit. Import rejected.',
      };
    }
    const pieces = keptPieces.map(segments => ({ segments }));
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
      patterns: keptPatterns,
      stats: classified.stats,
      unit,
      unitSource,
      unitDiagnostic,
      insunits,
      buckets,
      skippedOversizedPieces,
    };
  }
