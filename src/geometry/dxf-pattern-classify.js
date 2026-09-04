// US-124 / ADR 0091: DXF pattern identity is a classified closed outline.
//
// Pure, DOM-free grouping shared by BOTH DXF parsers (src/manual/dxf-import.js
// for the board, src/manual/dxf-native-parser.js for Pattern Measure) so the
// two can never disagree about what a pattern is — makeDxfMeasureSession pairs
// board pieces with native pieces BY INDEX, so a grouping difference between
// the two would silently null every pieceAnchor.
//
// Why this exists: the pre-ADR-0091 grouping (now dxfBuildPiecesLegacy in
// dxf-import.js — endpoint connectivity + bounding-box containment, never
// across a placement instance per ADR 0069) has no notion of which closed
// contour is the piece BOUNDARY. On every ASTM D6673 / AAMA-292 layered
// export (CLO, AccuMark, BUYI-TECH, RP_Design — 33 of the 36 parseable real
// files in demo/DXF file/**) a pattern's own grain line (layer 7) and
// internal lines (layers 8/85) routinely poke outside the boundary's
// bounding box and survive as separate "pieces": VeraLifting v.B 3.0.dxf
// (57 real patterns) read as 133 and was rejected by the 120-piece cap;
// BiancaBra 108 vs 41, SofyLift 105 vs 48, 3708 85 vs 48. See the story
// packet docs/stories/epics/E01-manual-mode/US-124-*/ for the corpus table.
//
// The rule (ADR 0091):
//   1. Per placement instance, the boundary layer is ASTM 1 ("piece
//      boundary"); 84 (its quality-validation twin) only when 1 is absent.
//   2. Every CLOSED simple chain on the boundary layer is one pattern's
//      outline. An instance with no closed boundary chain falls back — for
//      that instance only — to dxfBuildPiecesLegacy, byte-identical to the
//      pre-ADR-0091 result (3380.dxf, 2927.dxf, 2892XL-new.dxf have no layer
//      1 at all and must not change).
//   3. Every other chain in the instance (any layer, including an OPEN
//      boundary-layer chain) is assigned to the outline that contains the
//      largest fraction of its sample points (point-in-polygon, with an edge
//      tolerance so a chain drawn ON the boundary — a sew line, a QV twin —
//      counts as inside). Ties → the smaller outline, the same preference
//      the legacy containment merge had. Below the 50% score, a SHORT chain
//      whose endpoint touches an outline is a notch and joins it.
//   4. Anything still unassigned becomes its own pattern flagged `orphan` —
//      listed and drawn, never silently dropped — so a wrong assignment is
//      visible. The corpus oracle asserts orphans === 0 on every layered file.
//
// Layer classes are provenance for the Pattern Pieces panel and the import
// toast (Phase 3/4 of US-124); Phase 2 (this file) only needs "boundary or
// not" to decide grouping. Duplicate/QV-twin removal is Phase 3 and does
// not live here yet.
//
// Cross-part symbols used (all `function` declarations, hoisted bundle-wide
// per CLAUDE.md): distance, pointToSegmentDistance (src/geometry/math.js);
// dxfSegmentEndpoints, dxfPointOnArcSegment, dxfBoundsOfSegments,
// dxfBoundsOfPoints, dxfUnionFind, dxfBuildPiecesLegacy
// (src/manual/dxf-import.js).
// Source part for app.js. Run `npm run build` after editing.

  // ASTM D6673-10 / AAMA-292 layer table, verified against the corpus
  // (docs/stories/epics/E01-manual-mode/US-124-*/design.md). 8x = the
  // "quality validation curve" twins of 1/8/11/14.
  const DXF_PATTERN_LAYER_CLASS = {
    '1': 'boundary', '84': 'boundary-qv',
    '8': 'internal', '85': 'internal-qv',
    '14': 'sew', '87': 'sew-qv',
    '11': 'cutout', '86': 'cutout-qv',
    '7': 'grain', '5': 'gradeRef', '6': 'mirror',
    '15': 'annotation',
  };
  // Preference order for the boundary layer of an instance.
  const DXF_PATTERN_BOUNDARY_LAYERS = ['1', '84'];
  // Connectivity tolerance — the SAME relative figure dxfConnectedComponents
  // uses (fraction of the WHOLE drawing's diagonal), so the legacy fallback
  // and the classified path judge "touching" identically.
  const DXF_PATTERN_CONNECT_TOL_RATIO = 0.0001;
  // A sample point within this fraction of the OUTLINE's diagonal of the
  // outline itself counts as inside (sew lines and QV twins sit on/along it).
  const DXF_PATTERN_EDGE_TOL_RATIO = 0.002;
  // Notch rule: a chain no longer than this fraction of the INSTANCE
  // diagonal whose endpoint lies within the notch tolerance of an outline.
  const DXF_PATTERN_NOTCH_MAX_LEN_RATIO = 0.02;
  const DXF_PATTERN_NOTCH_TOL_RATIO = 0.005;
  const DXF_PATTERN_ASSIGN_MIN_SCORE = 0.5;
  // Sampling density for the containment score / polygon flattening.
  const DXF_PATTERN_SAMPLES_PER_CURVE = 8;
  const DXF_PATTERN_MAX_SAMPLES = 400;
  // Phase 3 (ADR 0091, owner decision 2): duplicates. Which copy of an EXACT
  // duplicate survives — lower rank wins (CLO exports layer 14 "sew line" as
  // a vertex-for-vertex copy of layer 1: keep the boundary, drop the sew
  // copy). QV twins rank last so a primary always beats its twin.
  const DXF_PATTERN_CLASS_RANK = {
    boundary: 0, sew: 1, internal: 2, cutout: 3, grain: 4, gradeRef: 5, mirror: 5,
    notch: 6, annotation: 7, unknown: 8,
    'boundary-qv': 9, 'sew-qv': 9, 'internal-qv': 9, 'cutout-qv': 9,
  };
  // A chain on an ASTM quality-validation layer (84/85/87/86) is a twin of
  // its pattern's primary geometry BY DEFINITION of the layer table; the
  // geometry check is only a sanity guard against a mislabelled layer, not
  // the classifier. Measured 2026-09-04 (one-sided Hausdorff / pattern
  // diagonal): real 84→1 twins deviate up to 4.0% (VeraLifting, 2.4× denser
  // re-tessellation of the same curve) while a genuinely different internal
  // line (8→1) sits as close as 0.03% — no distance threshold separates them,
  // so the layer decides and 10% only rejects the absurd.
  const DXF_PATTERN_QV_SANITY_RATIO = 0.10;

  function dxfPatternIsQvClass(cls) { return typeof cls === 'string' && cls.slice(-3) === '-qv'; }
  function dxfPatternClassRank(cls) {
    const r = DXF_PATTERN_CLASS_RANK[cls];
    return Number.isFinite(r) ? r : 8;
  }

  function dxfPatternLayerKey(layer) {
    return layer == null ? null : String(layer).trim();
  }

  function dxfPatternLayerClass(layer) {
    const key = dxfPatternLayerKey(layer);
    if (key == null || key === '') return 'unknown';
    return DXF_PATTERN_LAYER_CLASS[key] || 'unknown';
  }

  function dxfPatternCubicPoint(seg, t) {
    const mt = 1 - t;
    const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return {
      x: a * seg.p0.x + b * seg.c1.x + c * seg.c2.x + d * seg.p3.x,
      y: a * seg.p0.y + b * seg.c1.y + c * seg.c2.y + d * seg.p3.y,
    };
  }

  // n+1 points from t=0 to t=1 along the segment, in the segment's own
  // authored direction. A straight segment only ever needs its two ends.
  function dxfPatternSamplePoints(seg, n) {
    if (seg.kind === 'straight') return [seg.a, seg.b];
    const out = [];
    for (let i = 0; i <= n; i += 1) {
      const t = i / n;
      out.push(seg.kind === 'arc' ? dxfPointOnArcSegment(seg, t) : dxfPatternCubicPoint(seg, t));
    }
    return out;
  }

  function dxfPatternSegmentLength(seg) {
    if (seg.kind === 'straight') return distance(seg.a, seg.b);
    if (seg.kind === 'arc') return Math.abs(seg.sweep) * seg.radius;
    const pts = dxfPatternSamplePoints(seg, DXF_PATTERN_SAMPLES_PER_CURVE);
    let len = 0;
    for (let i = 1; i < pts.length; i += 1) len += distance(pts[i - 1], pts[i]);
    return len;
  }

  // Greedy grid clustering of endpoints: two points within `tol` share a
  // vertex id. O(k) via a cell hash (cell = tol, 3x3 neighbourhood) instead
  // of the legacy O(k^2) all-pairs scan — a real CLO instance has up to a
  // few thousand endpoints and a corpus file up to ~18k segments.
  function dxfPatternClusterPoints(points, tol) {
    const cell = tol > 0 ? tol : 1e-9;
    const grid = new Map();
    const ids = new Array(points.length).fill(-1);
    let next = 0;
    for (let i = 0; i < points.length; i += 1) {
      const p = points[i];
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      let found = -1;
      for (let dx = -1; dx <= 1 && found === -1; dx += 1) {
        for (let dy = -1; dy <= 1 && found === -1; dy += 1) {
          const bucket = grid.get((cx + dx) + ',' + (cy + dy));
          if (!bucket) continue;
          for (const j of bucket) {
            if (distance(p, points[j]) <= tol) { found = ids[j]; break; }
          }
        }
      }
      ids[i] = found === -1 ? next++ : found;
      const key = cx + ',' + cy;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    return { ids, count: next };
  }

  function dxfPatternMidpoint(seg) {
    if (seg.kind === 'straight') return { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 };
    if (seg.kind === 'arc') return dxfPointOnArcSegment(seg, 0.5);
    return dxfPatternCubicPoint(seg, 0.5);
  }

  // Endpoint-connected chains among `segIdxs`. `closed` means a SIMPLE loop:
  // every vertex has degree exactly 2 in the chain's TOPOLOGY. A figure-eight
  // or a chain with a dangling spur is not an outline; it goes to the pool.
  //
  // Two kinds of segment are members of the chain but NOT part of its
  // topology (measured on the corpus, 2026-09-04 — both made real closed
  // boundaries read as "not simple" and dropped whole files to legacy):
  //   - degenerate: both ends in one vertex cluster. `3708.dxf` closes every
  //     layer-1 POLYLINE with flag 1 AND repeats the first vertex as the last,
  //     so the closing edge has zero length and its vertex counted degree 4.
  //   - duplicate: same two vertices AND the same midpoint as an earlier
  //     segment — a stacked re-trace of one edge (`SN1252-MFB253` traces one
  //     rectangle 4x, see ADR 0073's kernel dedupe). A lens (two DIFFERENT
  //     arcs between the same two points) has different midpoints and stays
  //     two real edges, as ADR 0079's counter-case requires.
  // Neither is removed from the pattern — that is Phase 3's dedupe decision —
  // they simply do not vote on whether the boundary is closed.
  function dxfPatternChains(segments, segIdxs, tol) {
    if (!segIdxs.length) return [];
    const ends = segIdxs.map(i => dxfSegmentEndpoints(segments[i]));
    const { ids } = dxfPatternClusterPoints(ends.flat(), tol);
    const midIds = dxfPatternClusterPoints(segIdxs.map(i => dxfPatternMidpoint(segments[i])), tol).ids;
    const topo = new Array(segIdxs.length).fill(true);
    const seenEdge = new Set();
    for (let k = 0; k < segIdxs.length; k += 1) {
      const v0 = ids[2 * k], v1 = ids[2 * k + 1];
      if (v0 === v1) { topo[k] = false; continue; }
      const key = Math.min(v0, v1) + ':' + Math.max(v0, v1) + ':' + midIds[k];
      if (seenEdge.has(key)) { topo[k] = false; continue; }
      seenEdge.add(key);
    }
    const uf = dxfUnionFind(segIdxs.length);
    const firstAtVertex = new Map();
    for (let k = 0; k < segIdxs.length; k += 1) {
      for (let e = 0; e < 2; e += 1) {
        const v = ids[2 * k + e];
        if (firstAtVertex.has(v)) uf.union(k, firstAtVertex.get(v));
        else firstAtVertex.set(v, k);
      }
    }
    const groups = new Map();
    for (let k = 0; k < segIdxs.length; k += 1) {
      const root = uf.find(k);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(k);
    }
    const chains = [];
    for (const members of groups.values()) {
      const topoMembers = members.filter(k => topo[k]);
      const degree = new Map();
      for (const k of topoMembers) {
        for (let e = 0; e < 2; e += 1) {
          const v = ids[2 * k + e];
          degree.set(v, (degree.get(v) || 0) + 1);
        }
      }
      let simpleLoop = topoMembers.length > 0;
      for (const d of degree.values()) if (d !== 2) { simpleLoop = false; break; }
      // A single segment whose two ends coincide (a full circle) is a loop
      // with ONE vertex of degree 2 — but it is also "degenerate" by the
      // cluster test above. Keep it closed: one topo-less member whose
      // segment is an arc/curve of real length.
      if (!topoMembers.length && members.length === 1) {
        const seg = segments[segIdxs[members[0]]];
        if (seg.kind !== 'straight' && dxfPatternSegmentLength(seg) > tol) simpleLoop = true;
      }
      chains.push({
        members,
        topoMembers: topoMembers.length ? topoMembers : members,
        segIdxs: members.map(k => segIdxs[k]),
        vertexIds: members.map(k => [ids[2 * k], ids[2 * k + 1]]),
        topoVertexIds: (topoMembers.length ? topoMembers : members).map(k => [ids[2 * k], ids[2 * k + 1]]),
        topoSegIdxs: (topoMembers.length ? topoMembers : members).map(k => segIdxs[k]),
        closed: simpleLoop,
        oddVertices: Array.from(degree.values()).filter(d => d !== 2).length,
      });
    }
    return chains;
  }

  // Walk a simple loop in traversal order and flatten it to a polygon
  // (curves sampled, straight segments contribute their far end only).
  function dxfPatternLoopPolygon(segments, chain) {
    // Walk the TOPOLOGY only (degenerate / stacked-duplicate members would
    // stall the walk at a vertex of degree 4).
    const segIdxs = chain.topoSegIdxs, vertexIds = chain.topoVertexIds;
    const n = segIdxs.length;
    const atVertex = new Map();
    for (let m = 0; m < n; m += 1) {
      for (const v of vertexIds[m]) {
        if (!atVertex.has(v)) atVertex.set(v, []);
        atVertex.get(v).push(m);
      }
    }
    const poly = [];
    const used = new Array(n).fill(false);
    let m = 0;
    let enterVertex = vertexIds[0][0];
    for (let step = 0; step < n; step += 1) {
      used[m] = true;
      const seg = segments[segIdxs[m]];
      const [v0, v1] = vertexIds[m];
      const forward = v0 === enterVertex;
      const pts = dxfPatternSamplePoints(seg, DXF_PATTERN_SAMPLES_PER_CURVE);
      if (!forward) pts.reverse();
      for (let i = 1; i < pts.length; i += 1) poly.push(pts[i]);
      const exitVertex = forward ? v1 : v0;
      const nextCandidates = atVertex.get(exitVertex) || [];
      let next = -1;
      for (const c of nextCandidates) if (!used[c]) { next = c; break; }
      if (next === -1) break;
      m = next;
      enterVertex = exitVertex;
    }
    return poly;
  }

  function dxfPatternPolygonArea(poly) {
    let s = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      s += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
    }
    return Math.abs(s) / 2;
  }

  function dxfPatternPointInPolygon(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y)) {
        const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
        if (p.x < x) inside = !inside;
      }
    }
    return inside;
  }

  function dxfPatternDistanceToPolygon(p, poly) {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
      const d = pointToSegmentDistance(p, poly[j], poly[i]);
      if (d < best) best = d;
    }
    return best;
  }

  function dxfPatternMakeOutline(segments, chain) {
    const poly = dxfPatternLoopPolygon(segments, chain);
    const bounds = dxfBoundsOfPoints(poly);
    const diag = Math.hypot(bounds.width, bounds.height) || 1;
    return {
      segIdxs: chain.segIdxs.slice(),
      poly,
      bounds,
      area: dxfPatternPolygonArea(poly),
      edgeTol: DXF_PATTERN_EDGE_TOL_RATIO * diag,
    };
  }

  function dxfPatternInsideOrOn(p, outline) {
    const b = outline.bounds, t = outline.edgeTol;
    if (p.x < b.x - t || p.x > b.x + b.width + t || p.y < b.y - t || p.y > b.y + b.height + t) return false;
    if (dxfPatternPointInPolygon(p, outline.poly)) return true;
    return dxfPatternDistanceToPolygon(p, outline.poly) <= t;
  }

  // Sample points along a chain, capped so a 2000-segment internal mesh does
  // not turn the containment score into the dominant cost.
  function dxfPatternChainSamples(segments, chain) {
    const all = [];
    for (const i of chain.segIdxs) {
      const seg = segments[i];
      const pts = seg.kind === 'straight'
        ? [seg.a, { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2 }, seg.b]
        : dxfPatternSamplePoints(seg, DXF_PATTERN_SAMPLES_PER_CURVE);
      all.push(...pts);
    }
    if (all.length <= DXF_PATTERN_MAX_SAMPLES) return all;
    const stride = all.length / DXF_PATTERN_MAX_SAMPLES;
    const out = [];
    for (let k = 0; k < DXF_PATTERN_MAX_SAMPLES; k += 1) out.push(all[Math.floor(k * stride)]);
    return out;
  }

  function dxfPatternChainClass(segments, chain) {
    const counts = new Map();
    for (const i of chain.segIdxs) {
      const cls = dxfPatternLayerClass(segments[i].layer);
      counts.set(cls, (counts.get(cls) || 0) + 1);
    }
    let best = 'unknown', bestN = -1;
    for (const [cls, n] of counts) if (n > bestN) { best = cls; bestN = n; }
    return best;
  }

  function dxfPatternBump(counts, key, n) {
    counts[key] = (counts[key] || 0) + n;
  }

  // Flatten a segment to straight chords (curves sampled) for point-to-
  // geometry distance queries.
  function dxfPatternSegmentChords(seg) {
    if (seg.kind === 'straight') return [[seg.a, seg.b]];
    const pts = dxfPatternSamplePoints(seg, DXF_PATTERN_SAMPLES_PER_CURVE);
    const out = [];
    for (let i = 1; i < pts.length; i += 1) out.push([pts[i - 1], pts[i]]);
    return out;
  }

  function dxfPatternDistanceToChords(p, chords) {
    let best = Infinity;
    for (const [a, b] of chords) {
      const d = pointToSegmentDistance(p, a, b);
      if (d < best) best = d;
    }
    return best;
  }

  // Duplicate removal for ONE classified pattern (Phase 3 of US-124).
  // `entries` = every segment of the pattern as { segIdx, cls, chainKey }
  // (the outline's segments carry cls 'boundary' and chainKey 'outline').
  // Returns Map<segIdx, 'exact' | 'qvTwin'>.
  //   1. EXACT: same two endpoint clusters AND same midpoint cluster (within
  //      the connectivity tolerance) → one copy survives, chosen by class
  //      rank (boundary > sew > internal > … > qv), then file order. A lens
  //      (two different arcs between the same two points) has different
  //      midpoints and keeps both — ADR 0079's counter-case.
  //   2. QV TWIN (unless keepQualityCurves): every not-yet-dropped chain whose
  //      class is a quality-validation layer, provided the pattern still has
  //      primary geometry and the chain runs within DXF_PATTERN_QV_SANITY_RATIO
  //      of that primary geometry (one-sided Hausdorff over the chain's
  //      samples). Whole chains, never partial — a twin is a curve, not a
  //      segment.
  function dxfPatternDedupe(segments, entries, tol, patternDiag, keepQualityCurves) {
    const dropped = new Map();
    if (entries.length < 2) return dropped;
    const pts = [];
    for (const e of entries) {
      const seg = segments[e.segIdx];
      const ends = dxfSegmentEndpoints(seg);
      pts.push(ends[0], ends[1], dxfPatternMidpoint(seg));
    }
    const { ids } = dxfPatternClusterPoints(pts, tol);
    const byKey = new Map();
    for (let k = 0; k < entries.length; k += 1) {
      const v0 = ids[3 * k], v1 = ids[3 * k + 1], m = ids[3 * k + 2];
      const key = Math.min(v0, v1) + ':' + Math.max(v0, v1) + ':' + m;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(k);
    }
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => (dxfPatternClassRank(entries[a].cls) - dxfPatternClassRank(entries[b].cls))
        || (entries[a].segIdx - entries[b].segIdx));
      for (let g = 1; g < group.length; g += 1) dropped.set(entries[group[g]].segIdx, 'exact');
    }
    if (keepQualityCurves) return dropped;

    const primaryChords = [];
    const qvChains = new Map(); // chainKey -> entries
    for (const e of entries) {
      if (dropped.has(e.segIdx)) continue;
      if (dxfPatternIsQvClass(e.cls)) {
        if (!qvChains.has(e.chainKey)) qvChains.set(e.chainKey, []);
        qvChains.get(e.chainKey).push(e);
      } else {
        primaryChords.push(...dxfPatternSegmentChords(segments[e.segIdx]));
      }
    }
    if (!primaryChords.length || !qvChains.size) return dropped;
    const limit = DXF_PATTERN_QV_SANITY_RATIO * (patternDiag || 1);
    for (const chainEntries of qvChains.values()) {
      const pseudoChain = { segIdxs: chainEntries.map(e => e.segIdx) };
      const samples = dxfPatternChainSamples(segments, pseudoChain);
      let worst = 0;
      for (const p of samples) {
        const d = dxfPatternDistanceToChords(p, primaryChords);
        if (d > worst) { worst = d; if (worst > limit) break; }
      }
      if (worst <= limit) for (const e of chainEntries) dropped.set(e.segIdx, 'qvTwin');
    }
    return dropped;
  }

  // One instance -> { legacy: true, diag } or { legacy: false, patterns, diag }.
  // `diag` is the per-instance boundary diagnosis the debug hook and the
  // corpus suite read: how many boundary-layer segments/chains there were and
  // why none closed, so "fell back to legacy" is never a silent outcome.
  function dxfClassifyInstance(segments, idxs, tol, instance, options) {
    const keepQualityCurves = !!(options && options.keepQualityCurves);
    let outlines = null, boundaryLayer = null;
    const diag = { instance, segments: idxs.length, boundary: {} };
    for (const layer of DXF_PATTERN_BOUNDARY_LAYERS) {
      const bIdxs = idxs.filter(i => dxfPatternLayerKey(segments[i].layer) === layer);
      if (!bIdxs.length) continue;
      const chains = dxfPatternChains(segments, bIdxs, tol);
      const closed = chains.filter(c => c.closed);
      diag.boundary[layer] = {
        segments: bIdxs.length, chains: chains.length, closed: closed.length,
        openChains: chains.filter(c => !c.closed).map(c => ({ segments: c.segIdxs.length, topo: c.topoSegIdxs.length, oddVertices: c.oddVertices })).slice(0, 8),
      };
      if (!closed.length) continue;
      boundaryLayer = layer;
      outlines = closed.map(c => dxfPatternMakeOutline(segments, c));
      break;
    }
    if (!outlines) return { legacy: true, diag };

    const instBounds = dxfBoundsOfSegments(idxs.map(i => segments[i]));
    const instDiag = Math.hypot(instBounds.width, instBounds.height) || 1;
    const notchMaxLen = DXF_PATTERN_NOTCH_MAX_LEN_RATIO * instDiag;
    const notchTol = DXF_PATTERN_NOTCH_TOL_RATIO * instDiag;

    const inOutline = new Set();
    for (const o of outlines) for (const i of o.segIdxs) inOutline.add(i);
    const poolIdxs = idxs.filter(i => !inOutline.has(i));
    const poolChains = dxfPatternChains(segments, poolIdxs, tol);

    const patterns = outlines.map((o, oi) => ({
      kind: 'classified',
      instance,
      boundaryLayer,
      orphan: false,
      outlineIndex: oi,
      outlineSegCount: o.segIdxs.length,
      segIdxs: o.segIdxs.slice(),
      classCounts: { boundary: o.segIdxs.length },
      notchChains: 0,
      // Every assigned chain with its class, for the dedupe pass below.
      entries: o.segIdxs.map(i => ({ segIdx: i, cls: 'boundary', chainKey: 'outline' })),
    }));
    const orphans = [];

    let chainSerial = 0;
    for (const chain of poolChains) {
      const cls = dxfPatternChainClass(segments, chain);
      const chainKey = 'c' + (chainSerial++);
      let target = -1;
      let isNotch = false;
      let bestScore = -1;
      if (outlines.length === 1) {
        // The block IS the piece: a placement instance with exactly one
        // boundary outline owns everything placed with it, wherever it sits.
        // Measured on VeraLifting v.B 3.0.dxf: CLO exports the grain line
        // (layer 7) as ONE long LINE up to 8.6x the piece's own diagonal,
        // ending ~4 diagonals away from the outline — geometrically "outside"
        // by any containment score, yet unambiguously this piece's grain line
        // (49 of 57 would otherwise be orphans; BiancaBra 38, SofyLift 45).
        target = 0;
      } else {
        const samples = dxfPatternChainSamples(segments, chain);
        let best = -1, bestArea = Infinity;
        for (let oi = 0; oi < outlines.length; oi += 1) {
          const o = outlines[oi];
          let hit = 0;
          for (const p of samples) if (dxfPatternInsideOrOn(p, o)) hit += 1;
          const score = samples.length ? hit / samples.length : 0;
          if (score > bestScore + 1e-12 || (Math.abs(score - bestScore) <= 1e-12 && o.area < bestArea)) {
            best = oi; bestScore = score; bestArea = o.area;
          }
        }
        if (bestScore >= DXF_PATTERN_ASSIGN_MIN_SCORE) target = best;
        // A chain the ASTM layer table already names (grain, sew, internal,
        // cutout, their QV twins…) is a MARK by definition — it belongs to
        // whichever outline it touches at all, even when most of it runs
        // outside (the CLO grain-line case above, in a multi-outline
        // instance). Only an `unknown`-layer chain has to earn the 50%.
        else if (cls !== 'unknown' && bestScore > 0) target = best;
      }
      if (target === -1) {
        let len = 0;
        for (const i of chain.segIdxs) len += dxfPatternSegmentLength(segments[i]);
        if (len <= notchMaxLen) {
          let nearest = -1, nearestD = Infinity;
          for (let oi = 0; oi < outlines.length; oi += 1) {
            for (const i of chain.segIdxs) {
              for (const p of dxfSegmentEndpoints(segments[i])) {
                const d = dxfPatternDistanceToPolygon(p, outlines[oi].poly);
                if (d < nearestD) { nearestD = d; nearest = oi; }
              }
            }
          }
          if (nearest !== -1 && nearestD <= notchTol) { target = nearest; isNotch = true; }
        }
      }
      if (target !== -1) {
        const pat = patterns[target];
        pat.segIdxs.push(...chain.segIdxs);
        const effectiveCls = isNotch ? 'notch' : cls;
        dxfPatternBump(pat.classCounts, effectiveCls, chain.segIdxs.length);
        if (isNotch) pat.notchChains += 1;
        // Dedupe ranks and reports by each SEGMENT's own layer class, not the
        // chain's majority: CLO's layer-8 internal line and its layer-85 twin
        // share every vertex and so chain together — by majority class alone
        // the primary could lose the rank tie to its own twin and the report
        // would call the dropped twin "internal".
        for (const i of chain.segIdxs) {
          const own = isNotch ? 'notch' : dxfPatternLayerClass(segments[i].layer);
          pat.entries.push({ segIdx: i, cls: own === 'unknown' ? effectiveCls : own, chainKey });
        }
      } else {
        const classCounts = {};
        dxfPatternBump(classCounts, cls, chain.segIdxs.length);
        orphans.push({
          kind: 'orphan', instance, boundaryLayer, orphan: true,
          outlineSegCount: 0, segIdxs: chain.segIdxs.slice(), classCounts, notchChains: 0,
          keptSegIdxs: chain.segIdxs.slice(), dropped: { exact: 0, qvTwin: 0 }, droppedByClass: {},
        });
      }
    }

    // Phase 3: duplicates. Per pattern; orphans and legacy pieces are never
    // deduped (nothing is known about what they are).
    for (const pat of patterns) {
      const o = outlines[pat.outlineIndex];
      const patternDiag = Math.hypot(o.bounds.width, o.bounds.height) || 1;
      const droppedMap = dxfPatternDedupe(segments, pat.entries, tol, patternDiag, keepQualityCurves);
      pat.dropped = { exact: 0, qvTwin: 0 };
      pat.droppedByClass = {};
      for (const e of pat.entries) {
        const reason = droppedMap.get(e.segIdx);
        if (!reason) continue;
        pat.dropped[reason] += 1;
        dxfPatternBump(pat.droppedByClass, e.cls, 1);
      }
      pat.keptSegIdxs = pat.segIdxs.filter(i => !droppedMap.has(i));
      delete pat.entries;
    }

    const byFirst = (a, b) => Math.min(...a.segIdxs) - Math.min(...b.segIdxs);
    for (const p of patterns) { p.segIdxs.sort((a, b) => a - b); p.keptSegIdxs.sort((a, b) => a - b); }
    for (const p of orphans) p.segIdxs.sort((a, b) => a - b);
    patterns.sort(byFirst);
    orphans.sort(byFirst);
    diag.outlines = outlines.length;
    diag.orphans = orphans.length;
    return { legacy: false, patterns: patterns.concat(orphans), diag };
  }

  // segments -> { pieces, patterns, stats }. `pieces` has the exact shape
  // dxfBuildPieces always returned (array of arrays of the caller's own
  // segment objects) so parseDxfDocument / parseDxfNativeModel keep every
  // downstream cap and placement step unchanged; `patterns[i]` describes
  // `pieces[i]` (same index, same order).
  // `options.diagnostics` adds `stats.instances` (one dxfClassifyInstance
  // `diag` per instance) — off by default so a normal parse result stays
  // small; the debug hook turns it on for suites and corpus audits.
  // `options.keepQualityCurves` (Phase 3) keeps ASTM 84/85/86/87 twins in the
  // pieces; default drops them. Exact duplicates are always dropped.
  function dxfClassifyPatterns(segments, options) {
    const wantDiag = !!(options && options.diagnostics);
    const stats = {
      patternCount: 0, classifiedInstances: 0, legacyInstances: 0,
      classifiedPatterns: 0, legacyPieces: 0, orphans: 0,
      byClass: {}, boundaryLayers: {},
      totalSegments: segments ? segments.length : 0, keptSegments: 0,
      dropped: { exact: 0, qvTwin: 0 }, droppedByClass: {},
      keepQualityCurves: !!(options && options.keepQualityCurves),
    };
    if (wantDiag) stats.instances = [];
    stats.pipelineVersion = (options && options.pipelineVersion === 1) ? 1 : 2;
    // Phase 6 (owner decision 5): a saved pre-ADR-0091 source re-groups the
    // way its board was built — ONE global legacy pass over every segment
    // (instance-guarded connectivity + containment, root order), no dedupe,
    // no exclusions, no classification. This is the exact pre-change
    // dxfBuildPieces body, so the saved pieceFirstAnnotationIds keep pairing
    // by index with the rebuilt native pieces.
    if (stats.pipelineVersion === 1) {
      const legacyPieces = (segments && segments.length) ? dxfBuildPiecesLegacy(segments) : [];
      const patterns = legacyPieces.map(piece => ({
        kind: 'legacy', instance: piece.length ? (piece[0].instance == null ? 0 : piece[0].instance) : 0,
        boundaryLayer: null, orphan: false, outlineSegCount: 0, segCount: piece.length, totalSegCount: piece.length,
        classCounts: { unknown: piece.length }, notchChains: 0, dropped: { exact: 0, qvTwin: 0 }, droppedByClass: {},
      }));
      stats.patternCount = legacyPieces.length;
      stats.legacyPieces = legacyPieces.length;
      stats.legacyInstances = new Set(patterns.map(p => p.instance)).size;
      stats.keptSegments = legacyPieces.reduce((s, p) => s + p.length, 0);
      return { pieces: legacyPieces, patterns, stats };
    }
    // Phase 4 (ADR 0091, owner decision 3): the pre-placement pick. A TD who
    // hits DXF_TOTAL_OUTPUT_CAP deselects whole placement instances (a graded
    // size, a piece); both parsers receive the same list, so the pieces they
    // produce stay index-aligned. Instance 0 (direct ENTITIES) is one unit.
    const excluded = new Set(Array.isArray(options && options.excludeInstances) ? options.excludeInstances : []);
    stats.excludedInstances = 0;
    if (!segments || !segments.length) return { pieces: [], patterns: [], stats };
    const allBounds = dxfBoundsOfSegments(segments);
    const tol = DXF_PATTERN_CONNECT_TOL_RATIO * (Math.hypot(allBounds.width, allBounds.height) || 1);

    const byInstance = new Map();
    for (let i = 0; i < segments.length; i += 1) {
      const key = segments[i].instance == null ? 0 : segments[i].instance;
      if (!byInstance.has(key)) byInstance.set(key, []);
      byInstance.get(key).push(i);
    }
    const instanceKeys = Array.from(byInstance.keys()).sort((a, b) => a - b);

    const pieces = [];
    const patterns = [];
    // Phase 5: per-instance progress for the worker (one call per instance,
    // including excluded ones, so `done` reaches `total`). Pure — a callback
    // the caller owns; the synchronous path passes none.
    const onProgress = (options && typeof options.onProgress === 'function') ? options.onProgress : null;
    let progressDone = 0;
    for (const instance of instanceKeys) {
      progressDone += 1;
      if (onProgress) onProgress(progressDone, instanceKeys.length);
      if (excluded.has(instance)) { stats.excludedInstances += 1; continue; }
      const idxs = byInstance.get(instance);
      const result = dxfClassifyInstance(segments, idxs, tol, instance, options);
      if (wantDiag) stats.instances.push(Object.assign({ legacy: result.legacy }, result.diag));
      if (result.legacy) {
        stats.legacyInstances += 1;
        const legacyPieces = dxfBuildPiecesLegacy(idxs.map(i => segments[i]), tol);
        for (const piece of legacyPieces) {
          pieces.push(piece);
          patterns.push({
            kind: 'legacy', instance, boundaryLayer: null, orphan: false,
            outlineSegCount: 0, segCount: piece.length, totalSegCount: piece.length,
            classCounts: { unknown: piece.length }, notchChains: 0,
            dropped: { exact: 0, qvTwin: 0 }, droppedByClass: {},
          });
          stats.legacyPieces += 1;
          stats.keptSegments += piece.length;
        }
        continue;
      }
      stats.classifiedInstances += 1;
      for (const pat of result.patterns) {
        const kept = pat.keptSegIdxs || pat.segIdxs;
        pieces.push(kept.map(i => segments[i]));
        stats.keptSegments += kept.length;
        stats.dropped.exact += pat.dropped.exact;
        stats.dropped.qvTwin += pat.dropped.qvTwin;
        for (const key of Object.keys(pat.droppedByClass)) dxfPatternBump(stats.droppedByClass, key, pat.droppedByClass[key]);
        const record = {
          kind: pat.kind, instance, boundaryLayer: pat.boundaryLayer, orphan: pat.orphan,
          outlineSegCount: pat.outlineSegCount, segCount: kept.length, totalSegCount: pat.segIdxs.length,
          classCounts: pat.classCounts, notchChains: pat.notchChains,
          dropped: pat.dropped, droppedByClass: pat.droppedByClass,
        };
        patterns.push(record);
        if (pat.orphan) stats.orphans += 1; else stats.classifiedPatterns += 1;
        dxfPatternBump(stats.boundaryLayers, pat.boundaryLayer, 1);
        for (const key of Object.keys(pat.classCounts)) dxfPatternBump(stats.byClass, key, pat.classCounts[key]);
      }
    }
    stats.patternCount = pieces.length;
    return { pieces, patterns, stats };
  }
