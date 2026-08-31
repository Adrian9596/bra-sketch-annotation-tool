// US-104: "Open DXF file" import in Sketch Focus.
//
// Parses a constrained, explicitly-planar subset of ASCII DXF (LINE, ARC,
// CIRCLE, LWPOLYLINE, legacy POLYLINE+VERTEX+SEQEND) and places each
// connected pattern piece as its own independently movable group of
// `purpose: 'sketch-element'` annotations — never a Template, never a POM.
// The full contract (entity scope, planarity gate, malformed-entity rules,
// piece detection, placement formula, output caps) is
// docs/stories/epics/E01-manual-mode/US-104-dxf-import.md; this file is the
// authority for HOW those rules are implemented, not a restatement of WHY.
//
// Split deliberately into three layers so each is independently testable:
//   1. parseDxfDocument(text)              — pure text -> pieces (local
//      drawing space: DXF's own units, Y already flipped to screen-down).
//   2. computeDxfPlacementTransform(...)    — pure bounds+viewport+zoom -> one
//      shared scale/offset, DXF's own DXF_FIT_RATIO (round 11 — no longer
//      createImageRecord's numbers; see the function's own comment).
//   3. importDxfText(text, rect)            — orchestrates 1 + 2, builds real
//      annotation objects, and performs the one board mutation.
// Sibling file: the Tools-menu button / FileReader glue is
// src/ui/dxf-import-panel.js.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Text normalization + group-code tokenizing ---------------------------

  const DXF_BINARY_SENTINEL = 'AutoCAD Binary DXF';
  const DXF_PLANAR_EPS = 1e-6;
  // Per-piece: NOT normalizeShapeStamp's Template-member cap (80) — a real
  // digitized garment pattern piece traces its cutting curves as many short
  // straight segments rather than arcs/bulges, and routinely exceeds 80 on
  // its own. Verified against a real production file (demo/DXF file/
  // 3380.dxf, 25 POLYLINE + 42 LINE entities): with no cap it resolves to 6
  // real pieces sized [103, 149, 167, 263, 275, 295] segments — the 80 figure
  // would have rejected every one of them.
  //
  // Revised 1000 -> 2500 (ADR 0068 Follow-Up): ADR 0068's INSERT->BLOCK
  // resolution exposes far more real geometry per file than this cap was
  // ever sized against. `demo/DXF file/dxf/1290. Flexcamo .dxf` (30 blocks,
  // single size, real garment pieces) has a legitimate 1914-segment piece;
  // `demo/DXF file/dxf/2892XL-new.dxf` (no blocks, just an unusually
  // detailed direct-entity file) has real pieces up to 1886. 2500 clears
  // both with headroom while staying well below the 3835-17182-segment
  // "pieces" seen on `DM7549-LACE--STRIKE COST.dxf` /
  // `SN0004-BRA0978--STRIKE COST VER D.dxf` / `SN1252-MFB253--BACK-STRIKE
  // COST.dxf` — those are a DIFFERENT, deliberately NOT-fixed-here failure
  // mode: a grading-nest file whose same-position, overlapping same-size
  // blocks get fused into one merged blob by dxfMergeContainedComponents.
  // A piece THIS large, saved as a Template later, still truncates at
  // normalizeShapeStamp's own 80 — that pre-existing, unrelated limit is
  // unchanged; see the Acceptance Criteria note below.
  const DXF_PER_PIECE_CAP = 2500;
  // Revised 40 -> 120 (ADR 0068 Follow-Up): the real file above needed only
  // 6, but two other real files now resolvable via INSERT->BLOCK need more:
  // `1290. Flexcamo .dxf` legitimately decomposes into 75 pieces (many tiny
  // — notches/grainline marks that never touch the outline) and
  // `SofyLift v.A 1.0_Pattern.dxf` into 96. 120 clears both with headroom.
  const DXF_PIECE_COUNT_CAP = 120;
  // Board-performance backstop. Revised 3000 -> 16000 (ADR 0068 Follow-Up):
  // `2892XL-new.dxf` (24 real pieces, no blocks) totals 13894 segments with
  // both caps above cleared; verified in a real headless-Chrome import that
  // this renders, pans, and drags with no lag or corruption at that count
  // (previously blocked at the old 3000 combined limit).
  //
  // Revised 16000 -> 20000 (ADR 0069): once the instance-boundary fix (see
  // dxfConnectedComponents) correctly split `SN1252-MFB253--BACK-STRIKE
  // COST.dxf`'s 28 blocks into 28 real, individually-small pieces (none
  // near the per-piece cap), their real combined total came to 17182 —
  // just over the old 16000. 20000 clears it with headroom. The
  // instance-boundary check also makes this cap CHEAPER to reach than
  // before: it short-circuits the O(n^2) connectivity scan for the vast
  // majority of pairs (different placed instances), so a grading-nest
  // file's real parse time dropped rather than rose (SN0004-BRA0978--
  // STRIKE COST VER D.dxf: 4448ms -> 937ms measured before/after).
  const DXF_TOTAL_OUTPUT_CAP = 20000;
  // Round 11 (user-reported): a technical pattern has no "sits beside other
  // photos" reason to stay small, and shrinking it packs more of a
  // tessellated curve's points into the same screen distance — the opposite
  // of what round 10's crowding fix wants. See computeDxfPlacementTransform
  // for the full formula this feeds.
  const DXF_FIT_RATIO = 0.85;

  // BOM/CRLF/trailing-newline normalization has to happen BEFORE the
  // even/odd group-code pairing check below, or an ordinary, well-formed
  // file (one trailing newline, or authored on Windows) reads as corrupt:
  // a lone trailing "\n" splits into one extra empty final line, making an
  // otherwise-even line count odd.
  function dxfNormalizeText(text) {
    let s = String(text == null ? '' : text);
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    return s.replace(/\r\n?/g, '\n');
  }

  function dxfTokenizePairs(text) {
    const lines = dxfNormalizeText(text).split('\n');
    // Strip every trailing blank line, not just one — a file can end with
    // more than one newline (an editor-added blank line, a re-save) and none
    // of that is a corrupt group-code stream.
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines.length === 0 || lines.length % 2 !== 0) return null;
    const pairs = [];
    for (let i = 0; i < lines.length; i += 2) {
      const code = Number(lines[i].trim());
      if (!Number.isInteger(code)) return null;
      pairs.push({ code, value: lines[i + 1] });
    }
    return pairs;
  }

  function dxfFirst(pairs, code) {
    for (const p of pairs) if (p.code === code) return p.value;
    return undefined;
  }

  function dxfNum(pairs, code) {
    const raw = dxfFirst(pairs, code);
    return raw === undefined ? undefined : Number(String(raw).trim());
  }

  // Same as dxfNum, but for a group that is OPTIONAL-with-a-DXF-default
  // (thickness, elevation, extrusion). Absent -> the spec's default; PRESENT
  // but unparsable -> NaN, deliberately, so the caller can flag it malformed
  // rather than silently treating garbage as "0, so this must be flat."
  function dxfOptNum(pairs, code, fallback) {
    const raw = dxfFirst(pairs, code);
    return raw === undefined ? fallback : Number(String(raw).trim());
  }

  function dxfExtrusion(pairs) {
    const x = dxfOptNum(pairs, 210, 0);
    const y = dxfOptNum(pairs, 220, 0);
    const z = dxfOptNum(pairs, 230, 1);
    return { x, y, z, finite: Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) };
  }

  function dxfPlanarOk(zValues, thickness, ext) {
    for (const z of zValues) if (Math.abs(z) > DXF_PLANAR_EPS) return false;
    if (Math.abs(thickness) > DXF_PLANAR_EPS) return false;
    if (Math.abs(ext.x) > DXF_PLANAR_EPS || Math.abs(ext.y) > DXF_PLANAR_EPS
      || Math.abs(ext.z - 1) > DXF_PLANAR_EPS) return false;
    return true;
  }

  // ---- Section scoping + entity-record collection ----------------------------

  // Groups the flat pair stream into per-entity records, restricted to the
  // ENTITIES section only. POLYLINE swallows its own VERTEX children up to
  // SEQEND — a POLYLINE with no SEQEND is a whole-file structural problem
  // (its VERTEX children have no other way to know where they end), so it is
  // reported as a scan error, not a skipped entity.
  // Generalized so a BLOCK's own body (terminated by ENDBLK, not ENDSEC) can
  // reuse the exact same entity/POLYLINE-vertex collection logic as the
  // top-level ENTITIES section — see dxfCollectBlocksBody below. Delegating
  // dxfCollectEntitiesBody to this keeps its own observable output
  // byte-for-byte identical (same records shape, same error string).
  function dxfCollectEntityRecordsUntil(pairs, startIdx, stopType, notFoundMessage) {
    const records = [];
    let idx = startIdx;
    const n = pairs.length;
    while (idx < n) {
      const pair = pairs[idx];
      if (pair.code === 0 && String(pair.value).trim() === stopType) {
        return { records, nextIndex: idx };
      }
      if (pair.code !== 0) { idx += 1; continue; }
      const type = String(pair.value).trim();
      idx += 1;
      const bodyPairs = [];
      while (idx < n && pairs[idx].code !== 0) { bodyPairs.push(pairs[idx]); idx += 1; }
      if (type === 'POLYLINE') {
        const vertices = [];
        let sawSeqend = false;
        while (idx < n) {
          const p = pairs[idx];
          if (p.code === 0 && String(p.value).trim() === 'VERTEX') {
            idx += 1;
            const vPairs = [];
            while (idx < n && pairs[idx].code !== 0) { vPairs.push(pairs[idx]); idx += 1; }
            vertices.push(vPairs);
            continue;
          }
          if (p.code === 0 && String(p.value).trim() === 'SEQEND') { idx += 1; sawSeqend = true; }
          break;
        }
        if (!sawSeqend) return { error: 'a POLYLINE has no matching SEQEND' };
        records.push({ type, pairs: bodyPairs, vertices });
        continue;
      }
      records.push({ type, pairs: bodyPairs });
    }
    return { error: notFoundMessage };
  }

  function dxfCollectEntitiesBody(pairs, startIdx) {
    return dxfCollectEntityRecordsUntil(pairs, startIdx, 'ENDSEC', 'the ENTITIES section has no matching ENDSEC');
  }

  // A named BLOCK definition's body is entities exactly like ENTITIES',
  // terminated by ENDBLK instead of ENDSEC. Real garment-CAD DXF exports
  // (Gerber/Lectra/Rich-style) put every pattern piece's actual geometry
  // here, one block per piece, and merely reference it once via INSERT in
  // ENTITIES — see dxfConvertInsertEntity below for why that reference must
  // be resolved rather than treated as an unsupported entity type.
  function dxfCollectBlocksBody(pairs, startIdx) {
    const blocks = new Map();
    let idx = startIdx;
    const n = pairs.length;
    while (idx < n) {
      const pair = pairs[idx];
      if (pair.code === 0 && String(pair.value).trim() === 'ENDSEC') return { blocks, nextIndex: idx };
      if (pair.code === 0 && String(pair.value).trim() === 'BLOCK') {
        idx += 1;
        let name = null;
        while (idx < n && pairs[idx].code !== 0) {
          if (pairs[idx].code === 2 && name == null) name = String(pairs[idx].value).trim();
          idx += 1;
        }
        if (name == null) return { error: 'a BLOCK has no name (group 2)' };
        const body = dxfCollectEntityRecordsUntil(pairs, idx, 'ENDBLK', 'a BLOCK has no matching ENDBLK');
        if (body.error) return { error: body.error };
        idx = body.nextIndex;
        if (idx >= n) return { error: 'a BLOCK has no matching ENDBLK' };
        idx += 1; // step past the ENDBLK marker
        while (idx < n && pairs[idx].code !== 0) idx += 1; // ENDBLK's own fields, if any
        if (!blocks.has(name)) blocks.set(name, []);
        blocks.get(name).push(...body.records);
        continue;
      }
      idx += 1;
    }
    return { error: 'the BLOCKS section has no matching ENDSEC' };
  }

  function dxfScanSections(pairs) {
    let idx = 0;
    const n = pairs.length;
    let sectionOpen = false;
    let currentSection = null;
    let sawEntities = false;
    let sawBlocks = false;
    const entityRecords = [];
    const blocks = new Map();
    while (idx < n) {
      const pair = pairs[idx];
      if (pair.code === 0 && String(pair.value).trim() === 'SECTION') {
        if (sectionOpen) return { error: 'a SECTION opens before the previous one closed' };
        sectionOpen = true;
        idx += 1;
        currentSection = (idx < n && pairs[idx].code === 2) ? String(pairs[idx].value).trim() : null;
        if (currentSection != null) idx += 1;
        if (currentSection === 'ENTITIES') {
          if (sawEntities) return { error: 'more than one ENTITIES section' };
          sawEntities = true;
          const body = dxfCollectEntitiesBody(pairs, idx);
          if (body.error) return { error: body.error };
          entityRecords.push(...body.records);
          idx = body.nextIndex;
        } else if (currentSection === 'BLOCKS') {
          if (sawBlocks) return { error: 'more than one BLOCKS section' };
          sawBlocks = true;
          const body = dxfCollectBlocksBody(pairs, idx);
          if (body.error) return { error: body.error };
          for (const [name, records] of body.blocks) {
            if (!blocks.has(name)) blocks.set(name, []);
            blocks.get(name).push(...records);
          }
          idx = body.nextIndex;
        }
        continue;
      }
      if (pair.code === 0 && String(pair.value).trim() === 'ENDSEC') {
        if (!sectionOpen) return { error: 'an ENDSEC has no matching SECTION' };
        sectionOpen = false;
        currentSection = null;
        idx += 1;
        continue;
      }
      idx += 1;
    }
    if (sectionOpen) return { error: 'a SECTION has no matching ENDSEC' };
    if (!sawEntities) return { error: 'no ENTITIES section' };
    return { entityRecords, blocks };
  }

  // ---- Per-entity outcome helpers --------------------------------------------

  function dxfOk(segments) { return { ok: true, segments }; }
  function dxfSkip(bucket, reason) { return { ok: false, bucket, reason }; }
  function dxfMalformed(reason) { return dxfSkip('malformed', reason); }
  function dxfNonPlanar(reason) { return dxfSkip('nonPlanar', reason); }
  function dxfUnsupportedType(reason) { return dxfSkip('unsupportedType', reason); }
  function dxfUnsupportedFit(reason) { return dxfSkip('unsupportedFit', reason); }

  // ---- Arc / bulge -> cubic Bézier geometry ----------------------------------
  //
  // One shared chunker for ARC, CIRCLE and a polyline bulge alike: given a
  // center, radius, start angle and a SIGNED sweep (radians, CCW positive,
  // magnitude < 2*PI), split into pieces no wider than 90 degrees and convert
  // each with the standard tangent-based cubic approximation. All of this
  // runs in native DXF (Y-up) coordinates; the caller flips Y on the
  // resulting points afterward, uniformly, for every segment in the drawing.
  // Bézier curves are affine-covariant, so negating Y on the four control
  // points of an already-correct curve reproduces the curve's mirrored image
  // exactly — there is no separate "flip the sweep sign" step to get wrong.
  function dxfArcChunkToBezier(cx, cy, r, a0, a1) {
    const theta = a1 - a0;
    const alpha = (4 / 3) * Math.tan(theta / 4);
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p3 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    const c1 = { x: p0.x - alpha * r * Math.sin(a0), y: p0.y + alpha * r * Math.cos(a0) };
    const c2 = { x: p3.x + alpha * r * Math.sin(a1), y: p3.y - alpha * r * Math.cos(a1) };
    return { kind: 'curve', p0, c1, c2, p3 };
  }

  function dxfArcToBezierChunks(cx, cy, r, startAngle, sweep) {
    const maxChunk = Math.PI / 2;
    const count = Math.max(1, Math.ceil(Math.abs(sweep) / maxChunk - 1e-9));
    const chunkSweep = sweep / count;
    const chunks = [];
    let a = startAngle;
    for (let i = 0; i < count; i += 1) {
      chunks.push(dxfArcChunkToBezier(cx, cy, r, a, a + chunkSweep));
      a += chunkSweep;
    }
    return chunks;
  }

  // Bulge -> arc center/radius/angles, derived and numerically verified
  // against the DXF spec's own definition (bulge = tan(sweep/4), positive =
  // CCW from the vertex to the next one) rather than assumed: for a chord
  // P1->P2 with unit direction u and left-normal v = (-u.y, u.x), the CCW
  // sweep theta = 4*atan(bulge), radius r = d / (2*|sin(theta/2)|), and the
  // signed offset from the chord midpoint to the center along v is
  // h = sign(bulge) * r * cos(theta/2) — confirmed against the theta=180°
  // case (h=0, center exactly on the midpoint) and against a theta=90° case
  // solved by hand (center reproduces both P1 and P2 exactly under a CCW
  // sweep of theta from the recovered start angle).
  //
  // US-105: split out of dxfBulgeToBezierChunks so the native-coordinate
  // measurement kernel (src/manual/dxf-native-parser.js) can get the exact
  // {center, radius, startAngle, sweep} an ARC entity would carry, without
  // going through a Bézier-chunked approximation it does not need — arcs and
  // bulges are already exactly circular, so the measurement kernel's arc
  // length can stay analytic. Returns null for the same degenerate case
  // dxfBulgeToBezierChunks used to return [] for.
  function dxfBulgeToArcParams(p1, p2, bulge) {
    const d = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!(d > 1e-9)) return null;
    const theta = 4 * Math.atan(bulge);
    const ux = (p2.x - p1.x) / d, uy = (p2.y - p1.y) / d;
    const vx = -uy, vy = ux;
    const r = d / (2 * Math.abs(Math.sin(theta / 2)));
    const s = bulge < 0 ? -1 : 1;
    const h = s * r * Math.cos(theta / 2);
    const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
    const cx = mx + vx * h, cy = my + vy * h;
    const a0 = Math.atan2(p1.y - cy, p1.x - cx);
    return { cx, cy, r, a0, sweep: theta };
  }

  function dxfBulgeToBezierChunks(p1, p2, bulge) {
    const params = dxfBulgeToArcParams(p1, p2, bulge);
    if (!params) return [];
    return dxfArcToBezierChunks(params.cx, params.cy, params.r, params.a0, params.sweep);
  }

  // ---- Per-entity converters --------------------------------------------------

  function convertDxfLineEntity(rec) {
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
    return dxfOk([{ kind: 'straight', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } }]);
  }

  function convertDxfArcEntity(rec) {
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
    return dxfOk(dxfArcToBezierChunks(cx, cy, r, startRad, sweepRad));
  }

  function convertDxfCircleEntity(rec) {
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
    // Always exactly four 90-degree quadrants, per the product contract —
    // not "chunked to <=90", a fixed four, so every CIRCLE outputs the same
    // shape regardless of an arbitrary starting angle.
    const chunks = [];
    for (let i = 0; i < 4; i += 1) chunks.push(dxfArcChunkToBezier(cx, cy, r, i * (Math.PI / 2), (i + 1) * (Math.PI / 2)));
    return dxfOk(chunks);
  }

  function dxfParseLwpolylineVertices(pairs) {
    const vertices = [];
    let current = null;
    for (const p of pairs) {
      if (p.code === 10) {
        current = { x: Number(String(p.value).trim()), y: undefined, bulge: 0 };
        vertices.push(current);
      } else if (p.code === 20 && current) {
        current.y = Number(String(p.value).trim());
      } else if (p.code === 42 && current) {
        current.bulge = Number(String(p.value).trim());
      }
    }
    return vertices;
  }

  function dxfPolylineVerticesToSegments(vertices, closed) {
    const segs = [];
    const n = vertices.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i += 1) {
      const a = vertices[i];
      const b = vertices[(i + 1) % n];
      if (a.bulge) segs.push(...dxfBulgeToBezierChunks(a, b, a.bulge));
      else segs.push({ kind: 'straight', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
    }
    return segs;
  }

  function convertDxfLwpolylineEntity(rec) {
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
    return dxfOk(dxfPolylineVerticesToSegments(vertices, closed));
  }

  function convertDxfPolylineEntity(rec) {
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
    return dxfOk(dxfPolylineVerticesToSegments(vertices, closed));
  }

  function convertDxfEntity(rec) {
    switch (rec.type) {
      case 'LINE': return convertDxfLineEntity(rec);
      case 'ARC': return convertDxfArcEntity(rec);
      case 'CIRCLE': return convertDxfCircleEntity(rec);
      case 'LWPOLYLINE': return convertDxfLwpolylineEntity(rec);
      case 'POLYLINE': return convertDxfPolylineEntity(rec);
      default: return dxfUnsupportedType('entity type "' + rec.type + '" is not supported');
    }
  }

  // ---- INSERT -> BLOCK resolution ---------------------------------------------
  //
  // Real garment-CAD DXF exports (Gerber/Lectra/Rich-style) are the dominant
  // real-world shape this importer sees: every pattern piece's actual
  // LINE/POLYLINE geometry sits inside a named BLOCKS definition, and
  // ENTITIES only carries one INSERT per piece referencing it (see 2026-08-31
  // audit in docs/decisions/0067-dxf-grading-nest-import.md). Left
  // unresolved, a file built this way has ZERO directly-supported entities
  // and is rejected outright ("no supported entities were found") even
  // though it is a completely ordinary, valid pattern file — this is the bug
  // being fixed here. Deliberately scoped to a plain instance placement
  // (translate + uniform scale + rotation, bounded recursive nesting): a
  // non-uniform scale or MINSERT array is rejected with a stated reason
  // rather than silently producing distorted or duplicated geometry, since
  // no real sample file needs either.
  const DXF_INSERT_MAX_DEPTH = 8; // generous bound against a circular BLOCK/INSERT reference; no real file needs more than 1-2 levels

  function dxfInsertParams(rec) {
    const blockNameRaw = dxfFirst(rec.pairs, 2);
    return {
      blockName: blockNameRaw == null ? null : String(blockNameRaw).trim(),
      ix: dxfOptNum(rec.pairs, 10, 0),
      iy: dxfOptNum(rec.pairs, 20, 0),
      sx: dxfOptNum(rec.pairs, 41, 1),
      sy: dxfOptNum(rec.pairs, 42, 1),
      angleRad: dxfOptNum(rec.pairs, 50, 0) * Math.PI / 180,
      colCount: dxfOptNum(rec.pairs, 70, 1),
      rowCount: dxfOptNum(rec.pairs, 71, 1),
    };
  }

  // Scale about the block-local origin, then rotate, then translate to the
  // insertion point — the standard DXF INSERT transform order. Affine, so it
  // maps a straight segment's endpoints or a curve's Bézier control points
  // exactly, including a mirrored (negative-scale) instance of the block.
  function dxfInsertTransformPoint(p, ins) {
    const sx = p.x * ins.sx, sy = p.y * ins.sy;
    const cos = Math.cos(ins.angleRad), sin = Math.sin(ins.angleRad);
    return { x: ins.ix + sx * cos - sy * sin, y: ins.iy + sx * sin + sy * cos };
  }

  function dxfApplyInsertTransformToSegment(seg, ins) {
    return seg.kind === 'straight'
      ? { kind: 'straight', a: dxfInsertTransformPoint(seg.a, ins), b: dxfInsertTransformPoint(seg.b, ins) }
      : {
        kind: 'curve',
        p0: dxfInsertTransformPoint(seg.p0, ins), c1: dxfInsertTransformPoint(seg.c1, ins),
        c2: dxfInsertTransformPoint(seg.c2, ins), p3: dxfInsertTransformPoint(seg.p3, ins),
      };
  }

  // `buckets` is shared mutable state the caller also increments into — a
  // block's own unsupported/malformed children (e.g. TEXT alongside LINE)
  // are counted here as they're found, so one bucket total covers both
  // directly-placed and block-resolved entities uniformly. `instance`
  // (ADR 0069) is opaque here — always the SAME value this call's own
  // caller was given, propagated unchanged to every child so a piece
  // assembled from nested INSERTs still shares one instance boundary; see
  // dxfConnectedComponents/dxfMergeContainedComponents for what it's for.
  function dxfConvertInsertEntity(rec, blocks, depth, buckets, instance) {
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
    const blockRecords = blocks.get(p.blockName);
    if (!blockRecords) return dxfMalformed('INSERT references an undefined block "' + p.blockName + '"');
    if (depth >= DXF_INSERT_MAX_DEPTH) return dxfMalformed('INSERT nesting is too deep (possible circular BLOCK reference)');
    const segments = [];
    for (const childRec of blockRecords) {
      const result = dxfConvertEntityResolvingBlocks(childRec, blocks, depth + 1, buckets, instance);
      if (!result.ok) { buckets[result.bucket] += 1; continue; }
      segments.push(...result.segments);
    }
    if (!segments.length) return dxfMalformed('INSERT\'s block "' + p.blockName + '" has no supported geometry');
    return dxfOk(segments.map(seg => dxfApplyInsertTransformToSegment(seg, p)));
  }

  // Stamps every accepted segment with its placement `instance` (ADR 0069)
  // regardless of which branch produced it — the one place this needs to
  // happen, since dxfConvertInsertEntity's own return (after
  // dxfApplyInsertTransformToSegment rebuilds fresh segment objects) would
  // otherwise lose it.
  function dxfConvertEntityResolvingBlocks(rec, blocks, depth, buckets, instance) {
    const result = rec.type === 'INSERT'
      ? dxfConvertInsertEntity(rec, blocks, depth, buckets, instance)
      : convertDxfEntity(rec);
    if (!result.ok) return result;
    return { ok: true, segments: result.segments.map(seg => Object.assign({}, seg, { instance })) };
  }

  // ---- Y-flip (DXF Y-up -> board Y-down) -------------------------------------

  function dxfFlipPointY(p) { return { x: p.x, y: -p.y }; }

  // ADR 0069: preserves `instance` (set by dxfConvertEntityResolvingBlocks,
  // read by dxfConnectedComponents/dxfMergeContainedComponents) — dropping
  // it here would silently turn every segment's instance to `undefined`
  // before piece detection ever runs, making the whole instance-boundary
  // rule a no-op. Caught by this exact regression during development: the
  // fix initially had zero effect on any real file until this was found.
  function dxfFlipSegmentY(seg) {
    return seg.kind === 'straight'
      ? { kind: 'straight', a: dxfFlipPointY(seg.a), b: dxfFlipPointY(seg.b), instance: seg.instance }
      : { kind: 'curve', p0: dxfFlipPointY(seg.p0), c1: dxfFlipPointY(seg.c1), c2: dxfFlipPointY(seg.c2), p3: dxfFlipPointY(seg.p3), instance: seg.instance };
  }

  // US-105: a point at native arc parameter t in [0,1] — center + radius at
  // (startAngle + sweep*t). Shared by the native measurement kernel and, here,
  // by dxfSegmentEndpoints/dxfSegmentPoints below so an 'arc'-kind segment
  // (the native, non-Bézier representation the measurement parser emits) can
  // reuse the existing piece-detection primitives (dxfConnectedComponents,
  // dxfMergeContainedComponents, dxfBoundsOfSegments) unchanged. Never called
  // by parseDxfDocument's own pipeline, which only ever produces 'straight'/
  // 'curve' segments — this is purely additive.
  function dxfPointOnArcSegment(seg, t) {
    const a = seg.startAngle + seg.sweep * t;
    return { x: seg.center.x + seg.radius * Math.cos(a), y: seg.center.y + seg.radius * Math.sin(a) };
  }

  function dxfSegmentEndpoints(seg) {
    if (seg.kind === 'straight') return [seg.a, seg.b];
    if (seg.kind === 'arc') return [dxfPointOnArcSegment(seg, 0), dxfPointOnArcSegment(seg, 1)];
    return [seg.p0, seg.p3];
  }

  // Every point that defines the segment's painted extent, handles included
  // — mirrors shapeStampGeometryPoints's reasoning: a curve's bulge can sit
  // outside the a/b chord, so a bounds box built from endpoints alone can
  // clip or under-fit it. For 'arc' (US-105), the two corners of the full
  // circle's own bounding box are a deliberate, always-safe over-approximation
  // — cheaper than computing the arc's true axis-aligned extent and never
  // under-fits it, which is all dxfConnectedComponents/dxfMergeContainedComponents
  // need this for (an endpoint-touch tolerance and a containment test, neither
  // of which requires a pixel-exact box).
  function dxfSegmentPoints(seg) {
    if (seg.kind === 'straight') return [seg.a, seg.b];
    if (seg.kind === 'arc') {
      return [
        { x: seg.center.x - seg.radius, y: seg.center.y - seg.radius },
        { x: seg.center.x + seg.radius, y: seg.center.y + seg.radius },
      ];
    }
    return [seg.p0, seg.c1, seg.c2, seg.p3];
  }

  function dxfBoundsOfPoints(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  function dxfBoundsOfSegments(segments) {
    return dxfBoundsOfPoints(segments.flatMap(dxfSegmentPoints));
  }

  // ---- Piece detection: connected components, then containment merge --------

  function dxfUnionFind(n) {
    const parent = Array.from({ length: n }, (_, i) => i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    return { find, union };
  }

  // A relative tolerance (fraction of the whole drawing's diagonal), not an
  // absolute one — a DXF can be authored at any unit scale (mm, m, unitless)
  // and an absolute pixel-ish tolerance would either miss real joins on a
  // huge drawing or over-merge on a tiny one.
  //
  // ADR 0069: never union two segments from a DIFFERENT placed `instance`
  // (see dxfInstanceForEntity below) even if they geometrically touch or
  // nest. A grading-nest DXF places every size/piece as its own INSERT, all
  // at the SAME (usually identity) transform, so different sizes' outlines
  // routinely touch or cross within this relative tolerance — measured on
  // real files (SN0004-BRA0978--STRIKE COST VER D.dxf) a single raw
  // component ballooned to 2180 segments this way, several real sizes
  // fused into one. `instance` is `0` for every entity placed directly in
  // ENTITIES (matches this function's pre-existing behavior exactly — a
  // real multi-entity piece like 3380.dxf's is built from many direct
  // LINE/POLYLINE entities that must still freely connect) and a distinct
  // id per top-level INSERT (nested INSERTs inherit their parent's id, so
  // a piece assembled from nested reusable sub-blocks still connects as
  // one). Segments the native measurement parser (dxf-native-parser.js)
  // produces never set `instance` at all (`undefined`), so this guard is a
  // no-op there — untouched per ADR 0068's decision to scope block
  // resolution to board import only.
  function dxfConnectedComponents(segments) {
    const endpoints = segments.map(dxfSegmentEndpoints);
    const allPts = endpoints.flat();
    const bbox = dxfBoundsOfPoints(allPts);
    const diag = Math.hypot(bbox.width, bbox.height) || 1;
    const tol = 0.0001 * diag;
    const uf = dxfUnionFind(segments.length);
    for (let i = 0; i < segments.length; i += 1) {
      for (let j = i + 1; j < segments.length; j += 1) {
        if (segments[i].instance !== segments[j].instance) continue;
        let touch = false;
        for (const p of endpoints[i]) {
          for (const q of endpoints[j]) if (distance(p, q) <= tol) { touch = true; break; }
          if (touch) break;
        }
        if (touch) uf.union(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < segments.length; i += 1) {
      const root = uf.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(i);
    }
    return Array.from(groups.values()).map(segIdxs => ({
      segIdxs,
      bounds: dxfBoundsOfPoints(segIdxs.flatMap(i => dxfSegmentPoints(segments[i]))),
      // Every member's instance is identical by construction (the union
      // loop above never crosses instances), so any member's value is the
      // whole component's value.
      instance: segments[segIdxs[0]].instance,
    }));
  }

  // A drill hole, grainline, or other internal mark never touches its
  // panel's outline, so connectivity alone would split a real pattern piece
  // into several. Fully-contained components merge into the smallest
  // containing one; a merely-overlapping pair (not fully contained either
  // way) is deliberately left as two separate pieces, so two genuinely
  // different pieces whose boxes happen to graze never get wrongly fused.
  // Bounding-box containment, not point-in-polygon — a mark in the "cutout"
  // of a concave outline could be merged incorrectly; accepted for v1.
  function dxfMergeContainedComponents(components) {
    const n = components.length;
    const uf = dxfUnionFind(n);
    const contains = (outer, inner) => (
      inner.x >= outer.x - 1e-9 && inner.y >= outer.y - 1e-9
      && inner.x + inner.width <= outer.x + outer.width + 1e-9
      && inner.y + inner.height <= outer.y + outer.height + 1e-9
    );
    for (let i = 0; i < n; i += 1) {
      let bestJ = -1, bestArea = Infinity;
      for (let j = 0; j < n; j += 1) {
        if (i === j) continue;
        // ADR 0069: same instance-boundary rule as dxfConnectedComponents
        // above — a bounding-box nesting alone is not enough evidence two
        // components are "outline + internal mark," and area-ratio
        // thresholds were tried and rejected (measured, real: a legitimate
        // lining piece in 2927.dxf nests at 68.67% area ratio, well inside
        // the range grading-nest false merges occupy in other real files —
        // no threshold separates the two cases reliably). Placement
        // instance does: real drill holes/grainlines are always defined
        // INSIDE the same block/placement as their outline, never as a
        // separate INSERT.
        if (components[i].instance !== components[j].instance) continue;
        if (!contains(components[j].bounds, components[i].bounds)) continue;
        const area = components[j].bounds.width * components[j].bounds.height;
        if (area < bestArea) { bestArea = area; bestJ = j; }
      }
      if (bestJ !== -1) uf.union(i, bestJ);
    }
    const groups = new Map();
    for (let i = 0; i < n; i += 1) {
      const root = uf.find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(...components[i].segIdxs);
    }
    return Array.from(groups.values());
  }

  // segments -> array of pieces, each an array of segments (still in local
  // drawing space — no viewport transform applied yet).
  function dxfBuildPieces(segments) {
    const components = dxfConnectedComponents(segments);
    const pieceSegIdxLists = dxfMergeContainedComponents(components);
    return pieceSegIdxLists.map(idxs => idxs.map(i => segments[i]));
  }

  // ---- Placement transform ----------------------------------------------------

  // Round 11 (user-reported, then a follow-up review caught a real bug in
  // the first fix): this used to reuse createImageRecord's own
  // first-image-on-empty-board numbers verbatim (42%/180px floor) — sized
  // for a photo that might sit beside other photos, needlessly small for a
  // technical pattern that has no such neighbor and benefits from filling
  // most of the canvas (it also packs more of a tessellated curve's points
  // into the same screen distance, working against round 10's crowding
  // fix). DXF placement now has its own, larger DXF_FIT_RATIO and NO floor
  // — a "fit" that can force overflow at a tiny viewport (the old 180px
  // floor did exactly that) isn't a fit, and with an 85% ratio a floor is
  // already nearly always moot for a real viewport.
  //
  // `rect` is SCREEN-space (`getViewportRect()`, CSS pixels) but this
  // function's output (`outputWidth`/`outputHeight`/`originX`/`originY`) is
  // WORLD-space — the coordinate system annotations are stored in, which the
  // render loop then multiplies by `state.zoom` to get screen pixels. "Fit
  // to N% of the viewport" is therefore only true at zoom 1 unless the
  // current zoom is divided back out here: at zoom 2, an output sized for
  // 85% of a 1000px-wide viewport (850 world-px) would render at 1700
  // screen-px and overflow. Dividing the whole `rect * ratio` term by `zoom`
  // keeps `outputWidth * zoom` constant across any zoom the board happens to
  // be at when the import runs (verified in dxf-import-check.mjs at
  // 0.5x/1x/2x) — `zoom` defaults to 1 so existing callers (and the pure
  // debug-API test entry point) that don't pass it are unaffected.
  //
  // Unlike a raster image, DXF vector data has no native pixel resolution to
  // cap upscaling against, so there is no `Math.min(scale, 1)` "never
  // upscale" clause either — that remains an image-only concern.
  //
  // `centerWorld` is optional (tests pass one to get deterministic numbers
  // without a live pan/zoom); the real call site omits it and gets the
  // live `screenToWorld` result.
  function computeDxfPlacementTransform(bounds, rect, centerWorld, zoom) {
    const w = Math.max(bounds.width, 1e-9);
    const h = Math.max(bounds.height, 1e-9);
    const z = Math.max(0.0001, zoom || 1);
    const maxW = (rect.width * DXF_FIT_RATIO) / z;
    const maxH = (rect.height * DXF_FIT_RATIO) / z;
    const scale = Math.min(maxW / w, maxH / h);
    const outputWidth = w * scale;
    const outputHeight = h * scale;
    const center = centerWorld || screenToWorld(rect.width / 2, rect.height / 2);
    return {
      scale,
      originX: center.x - outputWidth / 2,
      originY: center.y - outputHeight / 2,
      outputWidth,
      outputHeight,
    };
  }

  function applyDxfTransform(p, bounds, transform) {
    return {
      x: transform.originX + (p.x - bounds.x) * transform.scale,
      y: transform.originY + (p.y - bounds.y) * transform.scale,
    };
  }

  // US-105: the missing inverse of applyDxfTransform — no board/world point
  // has ever needed to map BACK to the local (already-Y-flipped) drawing
  // space this transform's `bounds`/`transform` were computed against, until
  // Pattern Measure needs to turn a pointer click into "which native DXF
  // coordinate is under the cursor." Exact algebraic inverse of the affine
  // fit above; `transform.scale` is always > 0 for a real drawing (computed
  // from a non-degenerate bounds by computeDxfPlacementTransform), so no
  // separate degenerate-scale guard is needed here beyond the caller already
  // requiring a live measure session (which implies a successful prior parse).
  function invertDxfPlacementTransform(p, bounds, transform) {
    return {
      x: bounds.x + (p.x - transform.originX) / transform.scale,
      y: bounds.y + (p.y - transform.originY) / transform.scale,
    };
  }

  // ---- Document-level parse (pure; no state/DOM) -----------------------------

  // text -> { ok, pieces, buckets, ... } | { ok:false, atomic:true, reason,
  // message, buckets }. `pieces` (when ok) is an array of per-piece segment
  // arrays in LOCAL drawing space (already Y-flipped), each already under
  // the per-piece cap and the whole set already under the piece-count and
  // total-output caps — the only work left for the caller is the viewport
  // transform and building real annotation objects.
  function parseDxfDocument(text) {
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
    const buckets = { unsupportedType: 0, nonPlanar: 0, unsupportedFit: 0, malformed: 0 };
    const acceptedSegments = [];
    // ADR 0069: instance 0 is the single shared "placed directly in
    // ENTITIES" group (matches this loop's pre-INSERT-support behavior —
    // every direct entity could always freely connect/contain against any
    // other). Each top-level INSERT gets its own fresh, never-reused id, so
    // dxfConnectedComponents/dxfMergeContainedComponents never fuse two
    // separately-placed instances together.
    //
    // ADR 0070: a top-level INSERT's own block name (group 2) is the only
    // human-readable identity a grading-nest piece carries — real files name
    // blocks like "CUP_36C" or "BACKIN_38D" (see ADR 0067's Context). Recorded
    // here, keyed by instance, purely so the Pattern Pieces panel can label a
    // piece for the TD instead of an anonymous "Piece 3"; never read by parsing
    // or piece-detection itself. Instance 0 (direct entities, no INSERT) never
    // gets an entry — dxfBuildPieces callers fall back to a positional label.
    const instanceBlockNames = new Map();
    let nextDxfInstanceId = 1;
    for (const rec of scan.entityRecords) {
      const instance = rec.type === 'INSERT' ? nextDxfInstanceId++ : 0;
      if (rec.type === 'INSERT') instanceBlockNames.set(instance, dxfInsertParams(rec).blockName);
      const result = dxfConvertEntityResolvingBlocks(rec, scan.blocks, 0, buckets, instance);
      if (!result.ok) { buckets[result.bucket] += 1; continue; }
      acceptedSegments.push(...result.segments);
    }
    if (!acceptedSegments.length) {
      return { ok: false, atomic: true, reason: 'empty', message: 'No supported entities were found in this DXF file.', buckets };
    }
    const flipped = acceptedSegments.map(dxfFlipSegmentY);
    const allPieces = dxfBuildPieces(flipped);
    if (allPieces.length > DXF_PIECE_COUNT_CAP) {
      return {
        ok: false, atomic: true, reason: 'piece-cap', buckets,
        message: 'This DXF has ' + allPieces.length + ' pieces, over the ' + DXF_PIECE_COUNT_CAP + '-piece limit. Import rejected.',
      };
    }
    const keptPieces = [];
    let skippedOversizedPieces = 0;
    for (const piece of allPieces) {
      if (piece.length > DXF_PER_PIECE_CAP) { skippedOversizedPieces += 1; continue; }
      keptPieces.push(piece);
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
    return { ok: true, pieces: keptPieces, buckets, skippedOversizedPieces, instanceBlockNames };
  }

  // ---- Board mutation (real annotations, real state) -------------------------

  function dxfAnnotationFromSegment(seg, bounds, transform, groupId) {
    const T = (p) => applyDxfTransform(p, bounds, transform);
    const base = {
      id: state.idCounter++,
      seq: state.nextSequence, // never advanced — a Sketch Element spends no POM number (ADR 0058, matches createAnnotationFromTemplateMember)
      style: 'solid',
      color: 'black',
      arrowType: 'none',
      lineWidth: DEFAULT_LINE_WIDTH,
      lineTreatment: null,
      purpose: 'sketch-element',
      templateGroupId: groupId,
      midPoint: null,
      midHandleIn: null,
      midHandleOut: null,
      labelManual: false,
      text: null,
      value: null,
    };
    let ann;
    if (seg.kind === 'straight') {
      ann = Object.assign(base, { type: 'straight', start: T(seg.a), end: T(seg.b), control1: null, control2: null, points: [] });
    } else {
      ann = Object.assign(base, { type: 'curved', start: T(seg.p0), end: T(seg.p3), control1: T(seg.c1), control2: T(seg.c2), points: [] });
      ensureCurveControls(ann);
    }
    ann.label = computeDefaultLabelPosition(ann);
    return ann;
  }

  function dxfBucketLabel(key) {
    switch (key) {
      case 'unsupportedType': return 'unsupported type';
      case 'nonPlanar': return 'non-planar';
      case 'unsupportedFit': return 'unsupported polyline fit mode';
      case 'malformed': return 'malformed';
      default: return key;
    }
  }

  function dxfBucketsToast(buckets) {
    const parts = [];
    for (const key of ['unsupportedType', 'nonPlanar', 'unsupportedFit', 'malformed']) {
      const count = buckets && buckets[key];
      if (count) parts.push(count + ' ' + dxfBucketLabel(key));
    }
    return parts.length ? 'Skipped: ' + parts.join(', ') + '.' : '';
  }

  // The one entry point the Tools-menu button / test hooks call. `rect`
  // defaults to the real board viewport; tests may pass a fake one.
  function importDxfText(text, rect) {
    const parsed = parseDxfDocument(text);
    if (!parsed.ok) {
      const toastMsg = [parsed.message, dxfBucketsToast(parsed.buckets)].filter(Boolean).join(' ');
      showToast(toastMsg);
      return { ok: false, reason: parsed.reason, message: parsed.message, buckets: parsed.buckets || null };
    }
    const viewportRect = rect || getViewportRect();
    const bounds = dxfBoundsOfSegments(parsed.pieces.flat());
    const transform = computeDxfPlacementTransform(bounds, viewportRect, undefined, state.zoom);
    const allNewIds = [];
    let firstId = null;
    // US-105: one anchor annotation id per piece (its first segment's), so
    // the measure session can detect a piece having been dragged since
    // import (see dxfMeasureCurrentPieceOffset, dxf-measure-session.js) by
    // comparing that annotation's CURRENT position against where import
    // originally placed it — the board annotations are the only thing that
    // actually tracks a later whole-piece move.
    const pieceFirstAnnotationIds = [];
    // ADR 0070: one groupId per piece, in the same order as parsed.pieces, so
    // the Pattern Pieces panel (opened below) can label each row from the
    // block name recorded against that piece's instance — falling back to a
    // plain per-position label when the piece came from instance 0 (direct
    // ENTITIES, no INSERT) or an unnamed block.
    const groupIds = [];
    for (const piece of parsed.pieces) {
      const groupId = 'dxf-' + state.idCounter++;
      groupIds.push(groupId);
      const pieceAnns = piece.map(seg => dxfAnnotationFromSegment(seg, bounds, transform, groupId));
      pieceFirstAnnotationIds.push(pieceAnns.length ? pieceAnns[0].id : null);
      const blockName = piece.length ? parsed.instanceBlockNames.get(piece[0].instance) : null;
      if (blockName) {
        if (!state.templateGroupLabels) state.templateGroupLabels = {};
        state.templateGroupLabels[groupId] = blockName;
      }
      // One sourceImageId per PIECE (not per segment), matching
      // createAnnotationFromTemplateMember's own convention: landing outside
      // every board image gives the piece no sourceImageId at all, which is
      // exactly the Scratch Area placement semantics already documented for
      // every other sketch-element source.
      const pieceBounds = dxfBoundsOfPoints(pieceAnns.flatMap(a => a.type === 'straight'
        ? [a.start, a.end] : [a.start, a.control1, a.control2, a.end]));
      const owner = (typeof bgTopImageAt === 'function')
        ? bgTopImageAt({ x: pieceBounds.x + pieceBounds.width / 2, y: pieceBounds.y + pieceBounds.height / 2 })
        : null;
      for (const ann of pieceAnns) {
        if (owner) ann.sourceImageId = owner.id;
        state.annotations.push(ann);
        allNewIds.push(ann.id);
        if (firstId == null) firstId = ann.id;
      }
    }
    state.selection = { kind: 'annotation', id: firstId };
    state.selectedAnnotationIds = allNewIds;
    state.templateGroupEditId = null;
    pushHistoryIfChanged();
    // US-105: (re)build the native-coordinate measure session from the SAME
    // text and the SAME bounds/transform just used for the board
    // annotations above, so Pattern Measure's overlay is pixel-aligned with
    // what actually got drawn. Reset first — opening another DXF must never
    // leave a prior session's measurements dangling over new geometry.
    resetDxfMeasureSession();
    startDxfMeasureSession(text, bounds, transform, pieceFirstAnnotationIds);
    if (typeof updateUI === 'function') updateUI();
    if (typeof requestRender === 'function') requestRender();

    const pieceCount = parsed.pieces.length;
    const pieceWord = pieceCount === 1 ? 'piece' : 'pieces';
    const lineWord = allNewIds.length === 1 ? 'line' : 'lines';
    const skipParts = [dxfBucketsToast(parsed.buckets)];
    if (parsed.skippedOversizedPieces) {
      skipParts.push(parsed.skippedOversizedPieces + ' oversized piece'
        + (parsed.skippedOversizedPieces === 1 ? '' : 's') + ' (over ' + DXF_PER_PIECE_CAP + ' lines each).');
    }
    const skipMsg = skipParts.filter(Boolean).join(' ');
    // ADR 0073: a guessed unit rides on the import toast itself, not a
    // separate earlier toast — toast.js's fair-reading queue would swap a
    // separate warning away after ~900ms in favor of this success message.
    // Guarded: startDxfMeasureSession can fail and leave the session null
    // (it shows its own explanation in that case).
    const measureSession = state.dxfMeasureSession;
    const unitWarning = (measureSession && measureSession.source.unitSource !== 'dxf-header')
      ? ' Units assumed (in) — set them under Tools ▸ Pattern Measure if the file is mm/cm.'
      : '';
    showToast('Imported ' + pieceCount + ' ' + pieceWord + ' (' + allNewIds.length + ' ' + lineWord + ').'
      + (skipMsg ? ' ' + skipMsg : '') + unitWarning);
    // ADR 0070: a grading-nest file places every chosen size's piece at the
    // same board position (see ADR 0069's Context) — more than one piece
    // means the TD likely just imported an overlapping stack of sizes and
    // needs the Pattern Pieces panel to tell them apart, not a single
    // "1 piece" import where there is nothing to pick between.
    if (pieceCount > 1 && typeof openPatternPiecesPanel === 'function') openPatternPiecesPanel();
    return {
      ok: true,
      pieceCount,
      annotationCount: allNewIds.length,
      annotationIds: allNewIds.slice(),
      groupIds,
      buckets: parsed.buckets,
      skippedOversizedPieces: parsed.skippedOversizedPieces || 0,
    };
  }
