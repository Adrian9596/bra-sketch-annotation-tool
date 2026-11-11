// US-124 Phase 5 (ADR 0091): the PURE DXF parse layer, split out of
// src/dxf/dxf-import.js. Nothing in this part touches Board state, the DOM or
// window — the DXF parse-layer purity gate in scripts/check.mjs enforces that
// (DXF_PARSE_PARTS in scripts/source-parts.mjs) — and every function
// here is a hoisted declaration, so the board layer (dxf-import.js, later in
// SOURCE_PARTS) calls them unchanged.
//
// Contents: text normalization + group-code tokenizing, section scan, byte
// decoding, arc/bulge/SPLINE geometry, marks/annotation collection, INSERT
// parameters, the board view (Y-flip, arcs -> Béziers), the legacy grouping
// (dxfBuildPiecesLegacy), placement transform, and the ONE parse:
// dxfParseDocumentAndModel. The per-entity converters and INSERT->BLOCK
// resolution live in dxf-native-parser.js — there is one set, and it emits
// exact native geometry.
//
// A file is parsed ONCE (ADR 0105 follow-up). dxfParseDocumentAndModel
// tokenizes, converts and classifies, then returns two views of the same
// pieces: the board document (parseDxfDocument's shape — Y flipped, arcs as
// cubic Béziers) and the native measurement model (parseDxfNativeModel's
// shape — authored coordinates, exact arcs). Until then each view was its own
// full parse of the text, paired by index, and they drifted (see
// dxf-native-parser.js's header). The original file header follows for its
// history.
//
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
//   1. dxfParseDocumentAndModel(text)      — pure text -> pieces (board view:
//      local drawing space, DXF's own units, Y already flipped to screen-down;
//      plus the native model). parseDxfDocument(text) is its board view.
//   2. computeDxfPlacementTransform(...)    — pure bounds+viewport+zoom -> one
//      shared scale/offset, DXF's own DXF_FIT_RATIO (round 11 — no longer
//      createImageRecord's numbers; see the function's own comment).
//   3. importDxfText(text, rect)            — orchestrates 1 + 2, builds real
//      annotation objects, performs the one board mutation, and hands the
//      native model it already has to the Pattern Measure session.
// A .dxf reaches importDxfText through File > Open project… (the dedicated
// DXF import panel was retired by ADR 0087).
// Source part for app.js. Run `npm run build` after editing.

  // Shared number formatting for the parse-layer messages and the board
  // toasts.
  function dxfFormatCount(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

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
  // There is no piece-COUNT cap. History: it was revised 40 -> 120 (ADR 0068
  // Follow-Up): the real file above needed only 6, but two other real files
  // now resolvable via INSERT->BLOCK need more: `1290. Flexcamo .dxf`
  // legitimately decomposes into 75 pieces (many tiny — notches/grainline
  // marks that never touch the outline) and `SofyLift v.A 1.0_Pattern.dxf`
  // into 96. 120 cleared both with headroom.
  //
  // ADR 0091 / US-124 Phase 4 (owner decision 3): NO LONGER A REJECTION, and
  // since ADR 0105 no longer a constant at all. Pattern count alone never
  // refuses a file — the numbers above were over-counts (Flexcamo is 30
  // patterns, SofyLift 48; VeraLifting read 133 for 57 and was refused).
  // DXF_TOTAL_OUTPUT_CAP (board performance) is the only hard stop.

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
  // ENTITIES — see the INSERT -> BLOCK section below for why that reference
  // must be resolved rather than treated as an unsupported entity type.
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
        // One entry per DEFINITION, never concatenated (ADR 0091 follow-up,
        // 2026-09-04): 7 of the 36 real corpus files (BUYI-TECH exports —
        // 2827, 3039, 3087, 3114, 3179, 3286, 1290. Flexcamo) define the SAME
        // block name several times, one per graded size/piece, and reference
        // each once via INSERT in the same order. Concatenating them drew
        // every duplicate-named piece for every INSERT (2844: 6 INSERTs read
        // as 10 pieces; Flexcamo 30 → 97). See dxfBlockRecordsFor.
        if (!blocks.has(name)) blocks.set(name, []);
        blocks.get(name).push(body.records);
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
          for (const [name, definitions] of body.blocks) {
            if (!blocks.has(name)) blocks.set(name, []);
            blocks.get(name).push(...definitions);
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

  // `blocks` maps a name to its list of DEFINITIONS (see dxfCollectBlocksBody).
  // `ordinal` is how many top-level INSERTs of this name preceded the one
  // being resolved: the k-th INSERT of a duplicated name takes the k-th
  // definition. Verified exact on every duplicate-name file in the corpus —
  // in all 7 the ordered BLOCK-name sequence equals the ordered INSERT-name
  // sequence. More INSERTs than definitions (not seen) clamp to the last
  // definition rather than fail: a block genuinely placed N times has ONE
  // definition and ordinal 0..N-1, and must keep resolving. Nested INSERTs
  // (inside a block body) pass no ordinal and take the first definition.
  function dxfBlockRecordsFor(blocks, name, ordinal) {
    const definitions = blocks.get(name);
    if (!definitions || !definitions.length) return null;
    const k = Number.isInteger(ordinal) && ordinal > 0 ? Math.min(ordinal, definitions.length - 1) : 0;
    return definitions[k];
  }

  // ---- Byte-level decoding (ADR 0091 follow-up) -------------------------------
  //
  // FileReader.readAsText() decodes as UTF-8 and silently replaces every
  // undecodable byte with U+FFFD. Real Chinese-vendor exports name their
  // blocks in GBK (e.g. "2844裁片.前片.S"), so two DIFFERENT names of the same
  // byte length decoded to the SAME "2844��…" string and their
  // INSERTs resolved to one block: measured 2026-09-04 on the corpus —
  // 1290. Flexcamo .dxf 30 blocks → 13 distinct names after lossy decoding,
  // 2844 6 → 4, 637L 7 → 4, 721 9 → 7, 3179 11 → 9, 3114 11 → 10. Geometry
  // is ASCII, so only names/annotation text are at stake — but names decide
  // which block an INSERT draws. Strict UTF-8 first (a UTF-8 file is never
  // misread), then the file's own $DWGCODEPAGE, then GBK (this repo's
  // vendors), then windows-1252, which cannot fail.
  const DXF_CODEPAGE_TO_ENCODING = {
    ANSI_936: 'gbk', ANSI_950: 'big5', ANSI_932: 'shift_jis', ANSI_949: 'euc-kr',
    ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
    ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1257: 'windows-1257',
    ANSI_874: 'windows-874', ANSI_1258: 'windows-1258',
  };

  function dxfCodepageToEncoding(label) {
    if (!label) return null;
    const key = String(label).trim().toUpperCase();
    return DXF_CODEPAGE_TO_ENCODING[key] || null;
  }

  function decodeDxfBytes(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const tryDecode = (label) => {
      try { return new TextDecoder(label, { fatal: true }).decode(bytes); } catch (error) { return null; }
    };
    const strictUtf8 = tryDecode('utf-8');
    if (strictUtf8 != null) return { text: strictUtf8, encoding: 'utf-8' };
    const lossy = new TextDecoder('utf-8').decode(bytes);
    const match = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*([^\s]+)/i.exec(lossy);
    const declared = dxfCodepageToEncoding(match && match[1]);
    for (const label of [declared, 'gbk', 'windows-1252']) {
      if (!label) continue;
      const text = tryDecode(label);
      if (text != null) return { text, encoding: label, declaredCodepage: match ? match[1] : null };
    }
    return { text: lossy, encoding: 'utf-8-lossy', declaredCodepage: match ? match[1] : null };
  }

  // ---- Per-entity outcome helpers --------------------------------------------

  function dxfOk(segments) { return { ok: true, segments }; }
  function dxfSkip(bucket, reason) { return { ok: false, bucket, reason }; }
  function dxfMalformed(reason) { return dxfSkip('malformed', reason); }
  function dxfNonPlanar(reason) { return dxfSkip('nonPlanar', reason); }
  function dxfUnsupportedType(reason) { return dxfSkip('unsupportedType', reason); }
  function dxfUnsupportedFit(reason) { return dxfSkip('unsupportedFit', reason); }
  // US-127 / ADR 0102: an entity with no length at all. The board's toast
  // names these 'zero-length lines'; the native model has filed them under
  // 'malformed' since RB-4, and its tally is pinned by suites, so a skip can
  // carry a different native bucket.
  function dxfDegenerate(reason) { return { ok: false, bucket: 'degenerate', nativeBucket: 'malformed', reason }; }

  // The rejection tallies of one parse. The board document and the native
  // model report the same rejections under their own historic keys: the
  // board's `degenerate` = the native `malformed` share above + every dropped
  // zero-length polyline hop, which the native model counts separately as
  // `rejectedDegenerateSegments`.
  function dxfNewBuckets() {
    return {
      board: { unsupportedType: 0, nonPlanar: 0, unsupportedFit: 0, malformed: 0, nonGeometry: 0, degenerate: 0 },
      native: { unsupportedType: 0, nonPlanar: 0, unsupportedFit: 0, malformed: 0, nonGeometry: 0, rejectedDegenerateSegments: 0 },
    };
  }

  function dxfCountRejected(buckets, result) {
    buckets.board[result.bucket] += 1;
    buckets.native[result.nativeBucket || result.bucket] += 1;
  }

  function dxfCountDegenerateHops(buckets, count) {
    buckets.board.degenerate += count;
    buckets.native.rejectedDegenerateSegments += count;
  }

  // ---- Arc / bulge -> cubic Bézier geometry ----------------------------------
  //
  // One shared chunker for ARC, CIRCLE and a polyline bulge alike: given a
  // center, radius, start angle and a SIGNED sweep (radians, CCW positive,
  // magnitude <= 2*PI), split into pieces no wider than 90 degrees and convert
  // each with the standard tangent-based cubic approximation. The board view
  // calls it on an arc that is already Y-flipped (dxfBoardOrientedSegment
  // negates the center's y, the start angle and the sweep). That is the exact
  // mirror image of chunking in native Y-up space and flipping the control
  // points afterward, bit for bit: sin and tan are odd and cos is even in
  // IEEE arithmetic, and every sum below only changes sign.
  function dxfArcChunkToBezier(cx, cy, r, a0, a1) {
    const theta = a1 - a0;
    const alpha = (4 / 3) * Math.tan(theta / 4);
    const p0 = { x: cx + r * Math.cos(a0), y: cy + r * Math.sin(a0) };
    const p3 = { x: cx + r * Math.cos(a1), y: cy + r * Math.sin(a1) };
    const c1 = { x: p0.x - alpha * r * Math.sin(a0), y: p0.y + alpha * r * Math.cos(a0) };
    const c2 = { x: p3.x + alpha * r * Math.sin(a1), y: p3.y - alpha * r * Math.cos(a1) };
    return { kind: 'curve', p0, c1, c2, p3 };
  }

  // A CIRCLE (|sweep| = 2*PI) is exactly four 90-degree quarters, per the
  // product contract.
  function dxfArcChunkCount(sweep) {
    return Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  }

  // How many board LINES a segment is drawn as: an exact arc becomes
  // dxfArcChunkCount Bézier curves, anything else one line. The classifier
  // counts in these units (dxfPatternLineCount) because the toast, the
  // Pattern Pieces panel and the line caps all count what is drawn.
  function dxfBoardLineCount(seg) {
    return seg.kind === 'arc' ? dxfArcChunkCount(seg.sweep) : 1;
  }

  function dxfArcToBezierChunks(cx, cy, r, startAngle, sweep) {
    const count = dxfArcChunkCount(sweep);
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
  // US-105: returns the exact {center, radius, startAngle, sweep} an ARC
  // entity would carry, so a bulge stays exactly circular in the native model
  // (the board view chunks it like any other arc). Null for a zero-length
  // chord.
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

  // ---- SPLINE -> exact cubic Bezier parts -------------------------------------
  //
  // Measured on the 45-file corpus before writing a line of this: 24,652
  // SPLINE records across 4 files, ALL of them degree 3, none rational
  // (no weight differs from 1), every declared count matching its payload.
  // Three of those four files carry SPLINE and NOTHING else — no LINE, no
  // POLYLINE, no ARC — so before this they imported as "No supported
  // entities were found", i.e. 4 of 45 real factory files were 0% usable.
  //
  // A clamped non-rational B-spline is EXACTLY a chain of Bezier segments,
  // so nothing here samples or approximates: knot insertion (Boehm) raises
  // every interior knot to multiplicity `degree`, after which the control
  // points group span by span into Bezier control polygons. The corpus's own
  // files already arrive in that form (interior multiplicity 4 for a cubic,
  // control-point count an exact multiple of 4), so for them the insertion
  // loop does nothing at all and the conversion is a regrouping, not a
  // computation.
  //
  // The output is a `{kind:'curve'}` cubic, which is why
  // src/dxf/parse/dxf-path-kernel.js needed no change: its header has always
  // documented a cubic-Bezier segment shape that "no parser currently
  // produces" — point-at-t, length, projection and endpoint handling for it
  // were already written and already tested.
  const DXF_SPLINE_MAX_DEGREE = 3;
  const DXF_SPLINE_INSERT_GUARD = 4096;

  function dxfSplinePoints(pairs, codeX, codeY, codeZ) {
    const pts = [];
    let cur = null;
    for (const p of pairs) {
      if (p.code === codeX) {
        cur = { x: Number(String(p.value).trim()), y: undefined, z: 0 };
        pts.push(cur);
      } else if (p.code === codeY && cur) {
        cur.y = Number(String(p.value).trim());
      } else if (p.code === codeZ && cur) {
        cur.z = Number(String(p.value).trim());
      }
    }
    return pts;
  }

  // Knot vectors are non-decreasing, so equal values are contiguous: one
  // pass gives every distinct value with its multiplicity. This replaces a
  // per-index full-vector count, which was quadratic in the knot count — and
  // the corpus's largest spline carries 3,524 control points, so that cost
  // was real even though those splines need no insertion at all.
  function dxfSplineKnotRuns(knots) {
    const runs = [];
    for (let i = 0; i < knots.length;) {
      let j = i;
      while (j < knots.length && knots[j] === knots[i]) j += 1;
      runs.push({ value: knots[i], mult: j - i });
      i = j;
    }
    return runs;
  }

  // Boehm single knot insertion, non-rational. Returns the widened control
  // polygon and knot vector, or null when u is outside the usable span range.
  function dxfSplineInsertKnot(degree, ctrl, knots, u) {
    let k = -1;
    for (let i = degree; i < knots.length - degree - 1; i += 1) {
      if (u >= knots[i] && u < knots[i + 1]) { k = i; break; }
    }
    if (k < 0) return null;
    const out = [];
    for (let i = 0; i <= k - degree; i += 1) out.push(ctrl[i]);
    for (let i = k - degree + 1; i <= k; i += 1) {
      const den = knots[i + degree] - knots[i];
      const a = den > 0 ? (u - knots[i]) / den : 0;
      out.push({
        x: (1 - a) * ctrl[i - 1].x + a * ctrl[i].x,
        y: (1 - a) * ctrl[i - 1].y + a * ctrl[i].y,
      });
    }
    for (let i = k; i < ctrl.length; i += 1) out.push(ctrl[i]);
    return { ctrl: out, knots: knots.slice(0, k + 1).concat([u], knots.slice(k + 1)) };
  }

  // Clamped B-spline -> one control polygon per Bezier span, each of length
  // degree+1. Returns null for a knot vector this does not handle (unclamped
  // / periodic form), so the caller can report WHICH shape it refused rather
  // than emitting something wrong.
  //
  // Interior knots are raised to multiplicity `degree`, not degree+1: at that
  // point consecutive spans share their joint control point and the walk below
  // advances by the joint's own multiplicity, which handles BOTH the shared
  // form and the already-decomposed form (multiplicity degree+1, what every
  // spline in the corpus arrives as) with one rule.
  function dxfSplineBezierSpans(degree, ctrlIn, knotsIn) {
    let ctrl = ctrlIn.map(c => ({ x: c.x, y: c.y }));
    let knots = knotsIn.slice();
    let runs = dxfSplineKnotRuns(knots);
    if (runs.length < 2) return null;
    if (runs[0].mult !== degree + 1 || runs[runs.length - 1].mult !== degree + 1) return null;
    let guard = 0;
    for (;;) {
      let target = null;
      for (let r = 1; r < runs.length - 1; r += 1) {
        if (runs[r].mult < degree) { target = runs[r].value; break; }
      }
      if (target === null) break;
      const step = dxfSplineInsertKnot(degree, ctrl, knots, target);
      if (!step) return null;
      ctrl = step.ctrl;
      knots = step.knots;
      runs = dxfSplineKnotRuns(knots);
      guard += 1;
      if (guard > DXF_SPLINE_INSERT_GUARD) return null;
    }
    const spans = [];
    let offset = 0;
    for (let r = 0; r < runs.length - 1; r += 1) {
      if (offset + degree >= ctrl.length) return null;
      spans.push(ctrl.slice(offset, offset + degree + 1));
      offset += runs[r + 1].mult;
    }
    return spans.length ? spans : null;
  }

  // Neutral parts the SPLINE converter maps onto its segment shape:
  //   { type: 'line', a, b }              (degree 1 — exact, no elevation)
  //   { type: 'cubic', p0, p1, p2, p3 }   (degree 2 elevated exactly, degree 3 as-is)
  function dxfSplineSpanToPart(span, degree) {
    if (degree === 1) {
      return { type: 'line', a: span[0], b: span[1] };
    }
    if (degree === 2) {
      const [q0, q1, q2] = span;
      return {
        type: 'cubic',
        p0: q0,
        p1: { x: q0.x + (2 / 3) * (q1.x - q0.x), y: q0.y + (2 / 3) * (q1.y - q0.y) },
        p2: { x: q2.x + (2 / 3) * (q1.x - q2.x), y: q2.y + (2 / 3) * (q1.y - q2.y) },
        p3: q2,
      };
    }
    return { type: 'cubic', p0: span[0], p1: span[1], p2: span[2], p3: span[3] };
  }

  function dxfSplinePartIsDegenerate(part) {
    if (part.type === 'line') return part.a.x === part.b.x && part.a.y === part.b.y;
    const { p0, p1, p2, p3 } = part;
    return p0.x === p1.x && p0.x === p2.x && p0.x === p3.x
      && p0.y === p1.y && p0.y === p2.y && p0.y === p3.y;
  }

  // The one SPLINE reader. Every rejection names the exact shape refused, so
  // an unsupported file says WHICH spline form it holds instead of vanishing
  // into an aggregate count (findings-dxf.md Findings 4 and 6, same lesson).
  function dxfSplineParts(rec) {
    const degreeRaw = dxfOptNum(rec.pairs, 71, NaN);
    const flagsRaw = dxfOptNum(rec.pairs, 70, 0);
    if (!Number.isFinite(degreeRaw)) return dxfMalformed('SPLINE missing or non-finite degree (group 71)');
    if (!Number.isFinite(flagsRaw)) return dxfMalformed('SPLINE has a non-finite flag value');
    const degree = Math.trunc(degreeRaw);
    const flags = Math.trunc(flagsRaw);
    if (degree < 1) return dxfMalformed('SPLINE degree is below 1');
    const knots = [];
    const weights = [];
    for (const p of rec.pairs) {
      if (p.code === 40) knots.push(Number(String(p.value).trim()));
      else if (p.code === 41) weights.push(Number(String(p.value).trim()));
    }
    const ctrl = dxfSplinePoints(rec.pairs, 10, 20, 30);
    const fit = dxfSplinePoints(rec.pairs, 11, 21, 31);
    if (!ctrl.length) {
      return fit.length
        ? dxfUnsupportedFit('SPLINE carries fit points only (no control points)')
        : dxfMalformed('SPLINE has no control points');
    }
    for (const c of ctrl) {
      if (![c.x, c.y, c.z].every(Number.isFinite)) return dxfMalformed('SPLINE has a non-finite control point');
    }
    if (!knots.every(Number.isFinite)) return dxfMalformed('SPLINE has a non-finite knot value');
    const declaredKnots = dxfOptNum(rec.pairs, 72, knots.length);
    const declaredCtrl = dxfOptNum(rec.pairs, 73, ctrl.length);
    if (!Number.isFinite(declaredKnots) || Math.trunc(declaredKnots) !== knots.length) {
      return dxfMalformed('SPLINE group-72 knot count does not match its knot values');
    }
    if (!Number.isFinite(declaredCtrl) || Math.trunc(declaredCtrl) !== ctrl.length) {
      return dxfMalformed('SPLINE group-73 count does not match its control points');
    }
    if ((flags & 4) || weights.some(w => Number.isFinite(w) && w !== 1)) {
      return dxfUnsupportedFit('SPLINE is rational (weighted control points)');
    }
    if (degree > DXF_SPLINE_MAX_DEGREE) {
      return dxfUnsupportedFit('SPLINE of degree ' + degree + ' is above the supported cubic maximum');
    }
    if (knots.length !== ctrl.length + degree + 1) {
      return dxfMalformed('SPLINE knot count is not control points + degree + 1');
    }
    for (let i = 1; i < knots.length; i += 1) {
      if (knots[i] < knots[i - 1]) return dxfMalformed('SPLINE knot vector is not non-decreasing');
    }
    const thickness = dxfOptNum(rec.pairs, 39, 0);
    const ext = dxfExtrusion(rec.pairs);
    if (!Number.isFinite(thickness) || !ext.finite) return dxfMalformed('SPLINE has a non-finite planarity field');
    if (!dxfPlanarOk(ctrl.map(c => c.z), thickness, ext)) return dxfNonPlanar('SPLINE is not flat');
    const spans = dxfSplineBezierSpans(degree, ctrl, knots);
    if (!spans) return dxfUnsupportedFit('SPLINE knot vector is not in clamped form');
    const parts = [];
    let degenerate = 0;
    for (const span of spans) {
      const part = dxfSplineSpanToPart(span, degree);
      if (dxfSplinePartIsDegenerate(part)) degenerate += 1;
      else parts.push(part);
    }
    return { ok: true, parts, degenerate };
  }

  // ---- LWPOLYLINE vertex read (shared with the native converters) -------------

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

  // ---- Marks and annotation text (Phase 3) ------------------------------------
  //
  // A second, cheap pass over the scanned records — independent of geometry
  // conversion so the converter signatures stay small — that counts
  // POINT/TEXT per instance and pulls the ASTM piece annotation
  // (`PIECE NAME:` / `SIZE:` / `QUANTITY:`, the CLO convention) out of the
  // TEXT that shares a block with the piece. Same instance/ordinal scheme as
  // dxfParseDocumentAndModel so `labelsByInstance` lines up with
  // `instanceBlockNames`.
  const DXF_POINT_LAYER_CLASS = { '2': 'turn', '3': 'curve', '4': 'notch', '13': 'drill' };

  function dxfMarkText(rec) {
    const parts = [];
    for (const p of rec.pairs) if (p.code === 3) parts.push(String(p.value));
    for (const p of rec.pairs) if (p.code === 1) parts.push(String(p.value));
    return parts.join('').trim();
  }

  function dxfParseAnnotationLabel(texts) {
    const label = { pieceName: null, size: null, quantity: null };
    for (const t of texts) {
      let m = /^\s*PIECE\s*NAME\s*:\s*(.+?)\s*$/i.exec(t);
      if (m) { label.pieceName = m[1]; continue; }
      m = /^\s*SIZE\s*:\s*(.+?)\s*$/i.exec(t);
      if (m) { label.size = m[1]; continue; }
      m = /^\s*QUANTITY\s*:\s*(\d+)\s*$/i.exec(t);
      if (m) { label.quantity = Number(m[1]); continue; }
    }
    return (label.pieceName || label.size || label.quantity != null) ? label : null;
  }

  function dxfCollectMarks(scan) {
    const marks = {
      points: { total: 0, byClass: {} },
      texts: { total: 0 },
      labelsByInstance: {},
      textsByInstance: {},
    };
    const insertOrdinals = new Map();
    let nextInstance = 1;
    const visit = (records, instance) => {
      const texts = [];
      for (const rec of records) {
        if (rec.type === 'POINT') {
          marks.points.total += 1;
          const layer = dxfFirst(rec.pairs, 8);
          const cls = DXF_POINT_LAYER_CLASS[layer == null ? '' : String(layer).trim()] || 'other';
          marks.points.byClass[cls] = (marks.points.byClass[cls] || 0) + 1;
        } else if (rec.type === 'TEXT' || rec.type === 'MTEXT') {
          marks.texts.total += 1;
          const t = dxfMarkText(rec);
          if (t) texts.push(t);
        }
      }
      if (texts.length) {
        marks.textsByInstance[instance] = (marks.textsByInstance[instance] || []).concat(texts);
        const label = dxfParseAnnotationLabel(texts);
        if (label) marks.labelsByInstance[instance] = label;
      }
    };
    const direct = [];
    for (const rec of scan.entityRecords) {
      if (rec.type !== 'INSERT') { direct.push(rec); continue; }
      const instance = nextInstance++;
      const name = dxfInsertParams(rec).blockName;
      const ordinal = insertOrdinals.get(name) || 0;
      insertOrdinals.set(name, ordinal + 1);
      const records = dxfBlockRecordsFor(scan.blocks, name, ordinal);
      if (records) visit(records, instance);
    }
    visit(direct, 0);
    return marks;
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
  // no real sample file needs either. The parameters and the point transform
  // live here; the resolution itself is dxfNativeConvertInsertEntity in
  // dxf-native-parser.js.
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

  // ---- The board view: Y-flip (DXF Y-up -> board Y-down), arcs -> Béziers ----

  function dxfFlipPointY(p) { return { x: p.x, y: -p.y }; }

  // A native segment as the BOARD sees it: Y flipped, carrying exactly the
  // board's own fields — `instance` (ADR 0069, read by piece detection),
  // `layer` (ADR 0091, read by the classifier) and `entityType`. A straight
  // line or a SPLINE curve (renamed to the board's c1/c2) is already the board
  // segment the import draws; an arc stays an exact arc, mirrored, until
  // dxfBoardPiece chunks it after classification.
  //
  // dxfParseDocumentAndModel classifies THESE, not the native segments. The
  // classifier clusters points on a grid, so its decisions — which of two
  // near-coincident copies it keeps, even whether a chain closes — can depend
  // on the sign of y: run in native orientation it kept different copies on
  // SE0583-LACE (both files) and SN1252, and read the refused 2999 nest as 25
  // patterns instead of 2. Classifying the board orientation keeps every
  // board the import has ever drawn, and every corpus oracle row, unchanged;
  // the native model takes the same pieces back in authored coordinates.
  function dxfBoardOrientedSegment(seg) {
    const instance = seg.instance, layer = seg.layer, entityType = seg.entityType;
    if (seg.kind === 'straight') {
      return { kind: 'straight', a: dxfFlipPointY(seg.a), b: dxfFlipPointY(seg.b), instance, layer, entityType };
    }
    if (seg.kind === 'curve') {
      return {
        kind: 'curve', p0: dxfFlipPointY(seg.p0), c1: dxfFlipPointY(seg.p1), c2: dxfFlipPointY(seg.p2), p3: dxfFlipPointY(seg.p3),
        instance, layer, entityType,
      };
    }
    return {
      kind: 'arc', center: dxfFlipPointY(seg.center), radius: seg.radius, startAngle: -seg.startAngle, sweep: -seg.sweep,
      instance, layer, entityType,
    };
  }

  // A classified board-oriented piece -> the board's own segments: each arc
  // becomes dxfArcChunkCount cubic Béziers (a circle exactly four quarters),
  // stamped with the arc's provenance. A piece with no arc is returned as is.
  function dxfBoardPiece(piece) {
    if (!piece.some(seg => seg.kind === 'arc')) return piece;
    return piece.flatMap(seg => (seg.kind !== 'arc' ? [seg]
      : dxfArcToBezierChunks(seg.center.x, seg.center.y, seg.radius, seg.startAngle, seg.sweep)
        .map(chunk => Object.assign(chunk, { instance: seg.instance, layer: seg.layer, entityType: seg.entityType }))));
  }

  // US-105: a point at native arc parameter t in [0,1] — center + radius at
  // (startAngle + sweep*t). Shared by the native measurement kernel and, here,
  // by dxfSegmentEndpoints/dxfSegmentPoints below so an 'arc'-kind segment
  // (the exact representation the converters emit, and the classifier sees)
  // can reuse the piece-detection primitives (dxfConnectedComponents,
  // dxfMergeContainedComponents, dxfBoundsOfSegments) unchanged.
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
    // A cubic Bezier lies inside the convex hull of its control polygon, so
    // its four control points bound it. TWO shapes reach here: the board's
    // `{p0,c1,c2,p3}` and — since SPLINE support — the native measurement
    // model's `{p0,p1,p2,p3}` (see dxf-path-kernel.js's header for both).
    // Read whichever naming is present instead of assuming the board's: a
    // native curve read as a board one yields `undefined` control points and
    // takes the whole classify pass down with it, which is exactly what the
    // first SPLINE run did.
    // Inlined for the same reason as dxfPatternCubicPoint: this runs per
    // segment inside the per-instance bounds passes. `c1/c2` is the board
    // curve shape, `p1/p2` the native measurement one (dxf-path-kernel.js
    // documents the pair); a board curve costs one extra `undefined` test
    // here versus before SPLINE support existed.
    const c1 = seg.c1 !== undefined ? seg.c1 : seg.p1;
    const c2 = seg.c2 !== undefined ? seg.c2 : seg.p2;
    return (c1 !== undefined && c2 !== undefined) ? [seg.p0, c1, c2, seg.p3] : [seg.p0, seg.p3];
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
  // one).
  //
  // `tolOverride` (ADR 0091): dxfClassifyPatterns runs the legacy grouping
  // per instance and must pass in the WHOLE-drawing tolerance it computed, or
  // the fallback would judge "touching" against a per-instance diagonal and
  // stop being byte-identical to the pre-ADR-0091 result on a single-instance
  // file (3380.dxf). Omitted -> computed from `segments` exactly as before.
  function dxfConnectedComponents(segments, tolOverride) {
    const endpoints = segments.map(dxfSegmentEndpoints);
    const allPts = endpoints.flat();
    const bbox = dxfBoundsOfPoints(allPts);
    const diag = Math.hypot(bbox.width, bbox.height) || 1;
    const tol = Number.isFinite(tolOverride) ? tolOverride : 0.0001 * diag;
    const uf = dxfUnionFind(segments.length);
    // findings-dxf.md Finding 5: this was an all-pairs scan — 13,894 segments
    // (2892XL-new.dxf) held the main thread for ~19 s. Endpoints are bucketed
    // on a grid of cell size `tol`, so two endpoints within `tol` always sit
    // in the same or adjacent cells and only those are compared. The touching
    // PAIRS are exactly the ones the scan found, and union order cannot change
    // the result: groups are emitted by their lowest segment index below.
    const cell = tol > 0 ? tol : 1;
    const cellKey = (cx, cy) => cx + ',' + cy;
    const grid = new Map();
    for (let i = 0; i < segments.length; i += 1) {
      for (const p of endpoints[i]) {
        const key = cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell));
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
    }
    for (let i = 0; i < segments.length; i += 1) {
      for (const p of endpoints[i]) {
        const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            const bucket = grid.get(cellKey(cx + dx, cy + dy));
            if (!bucket) continue;
            for (const j of bucket) {
              if (j <= i || segments[i].instance !== segments[j].instance) continue;
              for (const q of endpoints[j]) if (distance(p, q) <= tol) { uf.union(i, j); break; }
            }
          }
        }
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
  //
  // ADR 0091: this is now the LEGACY grouping — connectivity + bounding-box
  // containment, the pre-2026-09-04 definition of a piece. dxfClassifyPatterns
  // (src/dxf/parse/dxf-pattern-classify.js) calls it, per instance, for any
  // instance with no closed ASTM boundary-layer chain (3380.dxf, 2927.dxf,
  // 2892XL-new.dxf have no layer 1 at all), passing the whole-drawing
  // tolerance so the result stays byte-identical to what this function
  // produced on those files before. Do not call it directly from a parser.
  function dxfBuildPiecesLegacy(segments, tolOverride) {
    const components = dxfConnectedComponents(segments, tolOverride);
    const pieceSegIdxLists = dxfMergeContainedComponents(components);
    return pieceSegIdxLists.map(idxs => idxs.map(i => segments[i]));
  }

  // ---- Fit bounds (US-127 / ADR 0102) -----------------------------------------
  //
  // The auto-fit used to frame the RAW bounding box of every placed segment,
  // which makes the whole import hostage to the file's worst coordinate. The
  // real SN1252-MFB253 export carries one corrupt polyline reaching
  // +/-214,588 while its 28 pattern pieces are ~10 units across: the fit
  // framed a 592,095-unit box, every real piece rendered at ~0.0002 board
  // pixels, and what the TD actually saw was a lattice of stray lines with
  // the patterns invisible inside it. Nothing was missing and nothing was
  // wrong with the pieces — they were just 3 million times too small to see,
  // move or click.
  //
  // So: frame the pieces that are the same ORDER OF SIZE as each other, and
  // let a wildly out-of-scale piece fall outside the viewport rather than
  // shrink every good piece to nothing. It is still placed, still listed in
  // the Pattern Pieces panel (flagged), still removable — never silently
  // dropped, because a piece the app decided not to look at is exactly the
  // kind of thing a TD must be told about.
  //
  // Choosing the ratio, measured on the real corpus (2026-09-08): across all
  // 40 parseable files the largest piece is at most 4.46x the median piece
  // (1290. Flexcamo; second place 3.95x), while the three pieces SN1252's one
  // corrupt block produces are 14.1x, 14.0x and 70,030x. Any ratio between
  // those two clusters works; 8 is roughly the geometric midpoint and errs
  // toward excluding, because the two error costs are wildly asymmetric —
  // a false exclusion leaves one real piece off-screen with a toast saying so
  // and Fit-to-view one gesture away, while a false inclusion is the failure
  // this whole function exists to stop: every piece in the file too small to
  // see. Below DXF_FIT_MIN_PIECES there is no meaningful median to compare
  // against, so the raw bounds stand.
  const DXF_FIT_OUTLIER_RATIO = 8;
  const DXF_FIT_MIN_PIECES = 4;

  function dxfFitBoundsForPieces(pieces) {
    const list = Array.isArray(pieces) ? pieces : [];
    const raw = dxfBoundsOfSegments(list.flat());
    if (list.length < DXF_FIT_MIN_PIECES) return { bounds: raw, outlierPieces: [] };
    const diagonals = list.map((piece) => {
      const b = dxfBoundsOfSegments(piece);
      return Math.hypot(b.width, b.height);
    });
    const sorted = diagonals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (!(median > 0)) return { bounds: raw, outlierPieces: [] };
    const limit = DXF_FIT_OUTLIER_RATIO * median;
    const keep = [];
    const outlierPieces = [];
    for (let i = 0; i < list.length; i += 1) {
      if (diagonals[i] > limit) outlierPieces.push(i); else keep.push(i);
    }
    if (!outlierPieces.length || !keep.length) return { bounds: raw, outlierPieces: [] };
    return { bounds: dxfBoundsOfSegments(keep.flatMap(i => list[i])), outlierPieces };
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
  // render loop then multiplies by the board zoom to get screen pixels. "Fit
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

  // ---- The one parse (pure; no state/DOM) --------------------------------------

  // text -> { board, native }: one tokenize, one conversion, one
  // classification, two views of the same pieces in the same order.
  //   board  — parseDxfDocument's shape: { ok, pieces, buckets,
  //            skippedOversizedPieces, instanceBlockNames, patterns, stats,
  //            marks }. `pieces` is an array of per-piece segment arrays in
  //            LOCAL drawing space (Y flipped, arcs as Béziers), already under
  //            the per-piece and total-output caps — the only work left for
  //            the caller is the viewport transform and real annotations.
  //   native — parseDxfNativeModel's shape (dxfNativeModelView): the same
  //            pieces as [{segments}] in authored coordinates, arcs exact.
  // A refusal is { ok:false, atomic:true, reason, message, buckets? } in both
  // views; they differ only in each view's own bucket keys and wording.
  function dxfParseDocumentAndModel(text, options) {
    const normalized = dxfNormalizeText(text);
    if (normalized.slice(0, DXF_BINARY_SENTINEL.length) === DXF_BINARY_SENTINEL) {
      const refused = {
        ok: false, atomic: true, reason: 'binary',
        message: 'This looks like a binary DXF file. Re-export as ASCII DXF and try again.',
      };
      return { board: refused, native: refused };
    }
    const pairs = dxfTokenizePairs(normalized);
    if (!pairs) {
      const refused = { ok: false, atomic: true, reason: 'corrupt', message: 'This file is not a valid ASCII DXF file.' };
      return { board: refused, native: refused };
    }
    const scan = dxfScanSections(pairs);
    if (scan.error) {
      const refused = { ok: false, atomic: true, reason: 'corrupt', message: 'This file is not a valid ASCII DXF file (' + scan.error + ').' };
      return { board: refused, native: refused };
    }
    const buckets = dxfNewBuckets();
    const segments = [];
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
    // gets an entry — the panel falls back to a positional label.
    const instanceBlockNames = new Map();
    let nextDxfInstanceId = 1;
    // k-th top-level INSERT of a name -> k-th BLOCK definition of that name
    // (see dxfBlockRecordsFor).
    const insertOrdinals = new Map();
    scan.entityRecords.forEach((rec, order) => {
      const instance = rec.type === 'INSERT' ? nextDxfInstanceId++ : 0;
      let ordinal = 0;
      if (rec.type === 'INSERT') {
        const blockName = dxfInsertParams(rec).blockName;
        instanceBlockNames.set(instance, blockName);
        ordinal = insertOrdinals.get(blockName) || 0;
        insertOrdinals.set(blockName, ordinal + 1);
      }
      const result = dxfNativeConvertEntityResolvingBlocks(rec, scan.blocks, 0, buckets, instance, order, ordinal);
      if (!result.ok) { dxfCountRejected(buckets, result); return; }
      dxfCountDegenerateHops(buckets, result.rejectedDegenerateSegments || 0);
      segments.push(...result.segments);
    });
    if (!segments.length) {
      const message = 'No supported entities were found in this DXF file.';
      return {
        board: { ok: false, atomic: true, reason: 'empty', message, buckets: buckets.board },
        native: { ok: false, atomic: true, reason: 'empty', message, buckets: buckets.native },
      };
    }
    // ADR 0091: classified grouping (closed boundary outline + assigned marks
    // per pattern), with the legacy grouping as a per-instance fallback —
    // ONCE, in board orientation (see dxfBoardOrientedSegment for why).
    // `classified.patterns[i]` describes `classified.pieces[i]`; both count
    // board lines.
    const oriented = segments.map(dxfBoardOrientedSegment);
    const classified = dxfClassifyPatterns(oriented, {
      diagnostics: !!(options && options.diagnostics),
      keepQualityCurves: !!(options && options.keepQualityCurves),
    });
    // Phase 4: pattern count alone never rejects a file.
    const keptPieces = [];
    const keptPatterns = [];
    let skippedOversizedPieces = 0;
    for (let i = 0; i < classified.pieces.length; i += 1) {
      const pattern = classified.patterns[i];
      // ADR 0091: the per-piece cap was sized against FUSED grading-nest
      // blobs (ADR 0069 — 3835..17182-segment "pieces" that were several
      // real pieces wrongly merged). A classified pattern cannot be such a
      // blob: it is one closed boundary plus the marks assigned to it, so
      // its size is real geometry and is bounded by DXF_TOTAL_OUTPUT_CAP
      // like everything else. Dropping a whole real pattern here would be
      // silent data loss (VeraLifting's 11_64_M is a legitimate 3,529-
      // segment pattern once its sew/QV twins are counted). Legacy pieces
      // and orphan chains keep the cap exactly as before. `segCount` is the
      // piece's board line count.
      if (pattern.segCount > DXF_PER_PIECE_CAP && pattern.kind !== 'classified') { skippedOversizedPieces += 1; continue; }
      keptPieces.push(classified.pieces[i]);
      keptPatterns.push(pattern);
    }
    if (!keptPieces.length) {
      const message = 'Every piece in this DXF exceeded the ' + DXF_PER_PIECE_CAP + '-line per-piece limit. Import rejected.';
      return {
        board: { ok: false, atomic: true, reason: 'empty-after-piece-cap', buckets: buckets.board, message },
        native: { ok: false, atomic: true, reason: 'empty-after-piece-cap', buckets: buckets.native, message },
      };
    }
    const totalOutputCount = keptPatterns.reduce((sum, pattern) => sum + pattern.segCount, 0);
    if (totalOutputCount > DXF_TOTAL_OUTPUT_CAP) {
      return {
        board: {
          ok: false, atomic: true, reason: 'total-cap', buckets: buckets.board, stats: classified.stats,
          message: 'This DXF would place ' + dxfFormatCount(totalOutputCount) + ' lines, over the ' + dxfFormatCount(DXF_TOTAL_OUTPUT_CAP) + '-line combined limit.',
        },
        native: {
          ok: false, atomic: true, reason: 'total-cap', buckets: buckets.native,
          message: 'This DXF would place ' + totalOutputCount + ' lines, over the ' + DXF_TOTAL_OUTPUT_CAP + '-line combined limit. Import rejected.',
        },
      };
    }
    const nativeOf = new Map();
    oriented.forEach((seg, i) => nativeOf.set(seg, segments[i]));
    return {
      board: {
        ok: true, pieces: keptPieces.map(dxfBoardPiece), buckets: buckets.board, skippedOversizedPieces, instanceBlockNames,
        // ADR 0091: per-piece classification (same index as `pieces`) and the
        // file-level tally the toast / Pattern Pieces panel / suites read.
        patterns: keptPatterns, stats: classified.stats,
        // Phase 3: POINT/TEXT counts and the per-instance piece annotation.
        marks: dxfCollectMarks(scan),
      },
      native: dxfNativeModelView({
        insunits: dxfReadInsunits(pairs),
        pieces: keptPieces.map(piece => ({ segments: piece.map(seg => nativeOf.get(seg)) })),
        patterns: keptPatterns,
        stats: classified.stats,
        buckets: buckets.native,
        skippedOversizedPieces,
      }),
    };
  }

  // The board view alone: what the debug hooks' `parse`/`parseWith` and the
  // suites read.
  function parseDxfDocument(text, options) {
    return dxfParseDocumentAndModel(text, options).board;
  }
