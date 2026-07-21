// Junction / endpoint / corner detection on the cleaned ink mask.
// Source part for app.js. Run `npm run build` after editing.
//
// Classic-CV port of the structural idea in Deep-Sketch-Vectorization /
// PolyVector Flow (IMPLEMENT_PLAN_2.md Phase 1): skeletonize the ink mask
// with Zhang-Suen thinning, then classify skeleton pixels by local topology.
// No deep-learning model — the whole pass is pure typed-array work so it
// runs identically in the browser and in the Node VM test harness.
//
// The output is auxiliary data for later phases (semantic snap needs to ask
// "is there a real ink junction near this anchor?"). Nothing in the main
// detection reads it yet, so detection accuracy is unchanged by design.
//
//   detectJunctions(mask, w, h[, options]) → {
//     points: [{ x, y, xPx, yPx, type, confidence, ... }],
//     summary: { junctions, endpoints, corners, skeletonPx, thinningIterations,
//                capped, durationMs },
//   }
//
// Point fields per type:
//   junction — neighborCount (valid branches, ≥3)
//   endpoint — direction (radians of the outgoing branch, y-down)
//   corner   — angle (interior angle in degrees; smaller = sharper)
// x/y are normalized [0,1] to the mask size (same convention as the rest of
// the detection result); xPx/yPx are mask-pixel coords for tests/debug.

  // Zhang-Suen thinning. Operates on a 0/1 copy of the mask, restricted to
  // the foreground bounding box. Iteration cap keeps pathological fills
  // (solid lace blobs) from stalling the pipeline — a partially thinned blob
  // yields low-confidence noise that the merge/cap stages already bound.
  const JUNCTION_THINNING_MAX_ITERATIONS = 48;
  // Points closer than this (in mask pixels) are the same feature drawn
  // thick; merged with type priority junction > corner > endpoint.
  const JUNCTION_MERGE_RADIUS_PX = 3;
  // Hard cap on emitted points so detection payloads (and saved projects
  // that embed a detection) stay bounded on lace-heavy sketches.
  const JUNCTION_MAX_POINTS = 400;
  // Corner detector: walk this many skeleton steps each way from the pixel
  // and flag a corner when the path bends more than 60° (interior < 120°).
  const JUNCTION_CORNER_WALK_STEPS = 6;
  const JUNCTION_CORNER_MAX_INTERIOR_DEG = 120;
  // Skeleton spurs (ragged stroke edges thin into tiny stubs off the main
  // line) up to this length are pruned before classification — every spur
  // base would otherwise read as a false junction.
  const JUNCTION_MAX_SPUR_LENGTH = 5;
  const JUNCTION_SPUR_PASSES = 2;
  // A real junction needs 3 branches that each continue at least this many
  // skeleton steps. Skeleton fuzz forks immediately and fails the walk.
  const JUNCTION_MIN_BRANCH_STEPS = 4;
  // Decoration filter: lace / trim texture produces dozens of candidates in
  // one small area, and none of them are snappable structure. Cells of this
  // size holding more than the max are dropped wholesale.
  const JUNCTION_DENSITY_CELL_PX = 32;
  const JUNCTION_DENSITY_MAX_PER_CELL = 10;
  // Crowd filter, the finer decoration sieve: garment structure yields
  // ISOLATED junctions (armhole∩side, band∩side, cradle∩CF...), while lace
  // mesh yields a junction every few pixels. A point with more than this
  // many same-type neighbors within the radius is texture, not structure.
  const JUNCTION_CROWD_RADIUS_PX = 20;
  const JUNCTION_CROWD_MAX_SAME_TYPE = 3;

  function detectJunctions(mask, w, h, options) {
    const t0 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    const opts = options || {};
    const empty = {
      points: [],
      summary: {
        junctions: 0, endpoints: 0, corners: 0,
        skeletonPx: 0, thinningIterations: 0, prunedSpurs: 0,
        suppressedDense: 0, capped: false, durationMs: 0,
      },
    };
    if (!mask || !w || !h || mask.length < w * h) return empty;

    // Foreground bounding box — thinning and scanning stay inside it.
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        if (mask[row + x]) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return empty;
    // Keep a 1px clear border inside the box so 3x3 neighborhoods never
    // read outside the buffer.
    minX = Math.max(1, minX - 1); minY = Math.max(1, minY - 1);
    maxX = Math.min(w - 2, maxX + 1); maxY = Math.min(h - 2, maxY + 1);

    const skeleton = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i += 1) skeleton[i] = mask[i] ? 1 : 0;
    // Zero the outermost image border: Zhang-Suen assumes background there.
    for (let x = 0; x < w; x += 1) { skeleton[x] = 0; skeleton[(h - 1) * w + x] = 0; }
    for (let y = 0; y < h; y += 1) { skeleton[y * w] = 0; skeleton[y * w + (w - 1)] = 0; }

    const thinningIterations = zhangSuenThin(
      skeleton, w, minX, minY, maxX, maxY,
      opts.maxIterations || JUNCTION_THINNING_MAX_ITERATIONS
    );

    // Prune spurs BEFORE classification. Thick or ragged strokes thin into
    // a main line plus short stubs; each stub base reads as a junction and
    // each stub tip as an endpoint. Real seam lines are far longer than the
    // spur cap so they are never touched.
    const prunedSpurs = pruneSkeletonSpurs(
      skeleton, w, minX, minY, maxX, maxY,
      opts.maxSpurLength || JUNCTION_MAX_SPUR_LENGTH,
      JUNCTION_SPUR_PASSES
    );

    // ---- Classify skeleton pixels by 8-neighborhood topology ----
    const rawJunctions = [];
    const rawEndpoints = [];
    const twoNeighborIdx = [];
    let skeletonPx = 0;
    for (let y = minY; y <= maxY; y += 1) {
      const row = y * w;
      for (let x = minX; x <= maxX; x += 1) {
        const idx = row + x;
        if (!skeleton[idx]) continue;
        skeletonPx += 1;
        const branches = countValidBranches(skeleton, w, x, y);
        if (branches >= 3) {
          rawJunctions.push({ x, y, neighborCount: branches });
        } else if (branches === 1 && countNeighbors(skeleton, w, idx) === 1) {
          rawEndpoints.push({ x, y });
        } else if (countNeighbors(skeleton, w, idx) === 2) {
          twoNeighborIdx.push(idx);
        }
      }
    }

    // ---- Corners: 2-neighbor path pixels where the line bends sharply ----
    const rawCorners = [];
    for (let i = 0; i < twoNeighborIdx.length; i += 1) {
      const idx = twoNeighborIdx[i];
      const x = idx % w;
      const y = (idx / w) | 0;
      const angleDeg = pathInteriorAngle(skeleton, w, x, y, JUNCTION_CORNER_WALK_STEPS);
      if (angleDeg != null && angleDeg < JUNCTION_CORNER_MAX_INTERIOR_DEG) {
        rawCorners.push({ x, y, angle: angleDeg });
      }
    }

    // ---- Build typed points with confidence ----
    let points = [];
    for (const j of rawJunctions) {
      points.push({
        xPx: j.x, yPx: j.y, type: 'junction',
        neighborCount: j.neighborCount,
        // 3 clean branches is already a real junction; extra branches add a
        // little confidence (an X-crossing beats a T).
        confidence: clamp01(0.6 + 0.15 * (j.neighborCount - 3)),
      });
    }
    for (const e of rawEndpoints) {
      points.push({
        xPx: e.x, yPx: e.y, type: 'endpoint',
        direction: endpointDirection(skeleton, w, e.x, e.y),
        confidence: 0.6,
      });
    }
    for (const c of rawCorners) {
      points.push({
        xPx: c.x, yPx: c.y, type: 'corner',
        angle: Math.round(c.angle * 10) / 10,
        // Sharper bend → more likely a real drawn corner, not raster noise.
        confidence: clamp01(0.35 + 0.5 * (1 - c.angle / JUNCTION_CORNER_MAX_INTERIOR_DEG)),
      });
    }

    points = mergeNearbyFeaturePoints(points, opts.mergeRadius || JUNCTION_MERGE_RADIUS_PX);

    // Decoration filter: a 32px cell that still holds >10 merged features is
    // lace / trim texture, not structure — nothing in it is worth snapping
    // to, and it would otherwise dominate the point budget.
    const density = suppressDenseFeatureCells(
      points,
      opts.densityCellPx || JUNCTION_DENSITY_CELL_PX,
      opts.densityMaxPerCell || JUNCTION_DENSITY_MAX_PER_CELL
    );
    const crowd = suppressCrowdedFeatures(
      density.kept,
      opts.crowdRadiusPx || JUNCTION_CROWD_RADIUS_PX,
      opts.crowdMaxSameType || JUNCTION_CROWD_MAX_SAME_TYPE
    );
    points = crowd.kept;
    const suppressedDense = density.suppressed + crowd.suppressed;

    // Cap by confidence so lace-heavy sketches can't flood the payload.
    const cap = opts.maxPoints || JUNCTION_MAX_POINTS;
    let capped = false;
    if (points.length > cap) {
      points.sort((a, b) => b.confidence - a.confidence);
      points = points.slice(0, cap);
      capped = true;
    }

    // Normalized coordinates travel with the detection like everything else.
    for (const p of points) {
      p.x = Math.round((p.xPx / w) * 1e6) / 1e6;
      p.y = Math.round((p.yPx / h) * 1e6) / 1e6;
      p.confidence = Math.round(p.confidence * 1000) / 1000;
    }

    const t1 = (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
    return {
      points,
      summary: {
        junctions: points.filter(p => p.type === 'junction').length,
        endpoints: points.filter(p => p.type === 'endpoint').length,
        corners: points.filter(p => p.type === 'corner').length,
        skeletonPx,
        thinningIterations,
        prunedSpurs,
        suppressedDense,
        capped,
        durationMs: Math.max(0, Math.round(t1 - t0)),
      },
    };
  }

  // Standard Zhang-Suen two-subiteration thinning, in place. Returns the
  // number of full iterations run (both subpasses = one iteration).
  function zhangSuenThin(img, w, minX, minY, maxX, maxY, maxIterations) {
    const toClear = [];
    let iterations = 0;
    for (; iterations < maxIterations; iterations += 1) {
      let changed = false;
      for (let sub = 0; sub < 2; sub += 1) {
        toClear.length = 0;
        for (let y = minY; y <= maxY; y += 1) {
          const row = y * w;
          for (let x = minX; x <= maxX; x += 1) {
            const idx = row + x;
            if (!img[idx]) continue;
            // Neighbors clockwise from north: p2..p9.
            const p2 = img[idx - w],     p3 = img[idx - w + 1];
            const p4 = img[idx + 1],     p5 = img[idx + w + 1];
            const p6 = img[idx + w],     p7 = img[idx + w - 1];
            const p8 = img[idx - 1],     p9 = img[idx - w - 1];
            const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (b < 2 || b > 6) continue;
            // A(p1): number of 0→1 transitions in the ordered ring.
            let a = 0;
            if (!p2 && p3) a += 1; if (!p3 && p4) a += 1;
            if (!p4 && p5) a += 1; if (!p5 && p6) a += 1;
            if (!p6 && p7) a += 1; if (!p7 && p8) a += 1;
            if (!p8 && p9) a += 1; if (!p9 && p2) a += 1;
            if (a !== 1) continue;
            if (sub === 0) {
              if (p2 * p4 * p6 !== 0) continue;
              if (p4 * p6 * p8 !== 0) continue;
            } else {
              if (p2 * p4 * p8 !== 0) continue;
              if (p2 * p6 * p8 !== 0) continue;
            }
            toClear.push(idx);
          }
        }
        if (toClear.length) {
          changed = true;
          for (let i = 0; i < toClear.length; i += 1) img[toClear[i]] = 0;
        }
      }
      if (!changed) break;
    }
    return iterations;
  }

  function countNeighbors(img, w, idx) {
    return img[idx - w - 1] + img[idx - w] + img[idx - w + 1]
         + img[idx - 1]                    + img[idx + 1]
         + img[idx + w - 1] + img[idx + w] + img[idx + w + 1];
  }

  // A junction needs ≥3 branches that each WALK at least
  // JUNCTION_MIN_BRANCH_STEPS pixels away from the center (plan mitigation:
  // thick strokes thin into doubled pixels whose neighbors are all mutual,
  // and stroke-edge fuzz forks immediately — both fail a 3-step walk, while
  // real seam arms pass it easily). Each branch walk is blocked from the
  // center's OTHER neighbors so it must leave along its own arm.
  function countValidBranches(img, w, cx, cy) {
    const cIdx = cy * w + cx;
    const raw = countNeighbors(img, w, cIdx);
    if (raw < 3) return raw;
    const neighborIdx = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        const idx = (cy + dy) * w + (cx + dx);
        if (img[idx]) neighborIdx.push(idx);
      }
    }
    let branches = 0;
    for (const nIdx of neighborIdx) {
      const nx = nIdx % w;
      const ny = (nIdx / w) | 0;
      const blocked = neighborIdx.filter(i => i !== nIdx);
      const path = walkSkeleton(
        img, w, nx, ny, { x: cx, y: cy },
        JUNCTION_MIN_BRANCH_STEPS, blocked
      );
      const tip = path[path.length - 1];
      const reach = Math.max(Math.abs(tip.x - cx), Math.abs(tip.y - cy));
      if (reach >= JUNCTION_MIN_BRANCH_STEPS) branches += 1;
    }
    return branches;
  }

  // Remove short skeleton stubs. Two kinds die here: spurs (≤ maxSpurLen
  // pixels hanging off a junction — thinning artifacts of thick/ragged
  // strokes) and tiny floating fragments (≤3 px — speckle that survived
  // component cleanup). Real lines are far longer and are never touched.
  // Runs `passes` times because deleting one spur can expose another.
  function pruneSkeletonSpurs(img, w, minX, minY, maxX, maxY, maxSpurLen, passes) {
    let totalRemoved = 0;
    for (let pass = 0; pass < passes; pass += 1) {
      let removed = 0;
      for (let y = minY; y <= maxY; y += 1) {
        const row = y * w;
        for (let x = minX; x <= maxX; x += 1) {
          const idx = row + x;
          if (!img[idx] || countNeighbors(img, w, idx) !== 1) continue;
          // Walk inward from the endpoint until a junction, a dead end, or
          // the length budget.
          const path = [idx];
          let cx = x, cy = y, px = -1, py = -1;
          let reachedJunction = false;
          let deadEnd = false;
          for (let s = 0; s < maxSpurLen; s += 1) {
            let nextX = -1, nextY = -1, n = 0;
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                if (!dx && !dy) continue;
                const nx = cx + dx, ny = cy + dy;
                if (nx === px && ny === py) continue;
                if (img[ny * w + nx]) { nextX = nx; nextY = ny; n += 1; }
              }
            }
            if (n === 0) { deadEnd = true; break; }
            if (n > 1 || countNeighbors(img, w, nextY * w + nextX) >= 3) {
              reachedJunction = true;
              break;
            }
            px = cx; py = cy; cx = nextX; cy = nextY;
            path.push(cy * w + cx);
          }
          if (reachedJunction || (deadEnd && path.length <= 3)) {
            for (const p of path) {
              if (img[p]) { img[p] = 0; removed += 1; }
            }
          }
        }
      }
      totalRemoved += removed;
      if (!removed) break;
    }
    return totalRemoved;
  }

  // Crowd sieve: drop any point with more than maxSameType same-type
  // neighbors inside radiusPx. Lace mesh crossings sit a few pixels apart,
  // so each one sees many peers; a real seam junction sees none or one.
  function suppressCrowdedFeatures(points, radiusPx, maxSameType) {
    if (points.length <= maxSameType) return { kept: points, suppressed: 0 };
    const cell = Math.max(1, radiusPx);
    const grid = new Map();
    const keyOf = (gx, gy) => gx * 100000 + gy;
    for (const p of points) {
      const key = keyOf((p.xPx / cell) | 0, (p.yPx / cell) | 0);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(p);
    }
    const kept = [];
    let suppressed = 0;
    for (const p of points) {
      const gx = (p.xPx / cell) | 0;
      const gy = (p.yPx / cell) | 0;
      let sameType = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const bucket = grid.get(keyOf(gx + dx, gy + dy));
          if (!bucket) continue;
          for (const q of bucket) {
            if (q === p || q.type !== p.type) continue;
            if (Math.hypot(q.xPx - p.xPx, q.yPx - p.yPx) <= radiusPx) sameType += 1;
          }
        }
      }
      if (sameType > maxSameType) suppressed += 1;
      else kept.push(p);
    }
    return { kept, suppressed };
  }

  // Drop every feature in any grid cell holding more than maxPerCell merged
  // points — dense texture (lace, trim, hatching) is decoration, not
  // snappable garment structure.
  function suppressDenseFeatureCells(points, cellPx, maxPerCell) {
    if (points.length <= maxPerCell) return { kept: points, suppressed: 0 };
    const counts = new Map();
    const cellKey = p => (((p.xPx / cellPx) | 0) * 100000) + ((p.yPx / cellPx) | 0);
    for (const p of points) {
      const key = cellKey(p);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const kept = [];
    let suppressed = 0;
    for (const p of points) {
      if (counts.get(cellKey(p)) > maxPerCell) suppressed += 1;
      else kept.push(p);
    }
    return { kept, suppressed };
  }

  // Direction (radians, y-down screen convention) of the single branch
  // leaving an endpoint, averaged over a short walk for stability.
  function endpointDirection(img, w, x, y) {
    const walked = walkSkeleton(img, w, x, y, null, JUNCTION_CORNER_WALK_STEPS);
    const tip = walked[walked.length - 1];
    if (!tip || (tip.x === x && tip.y === y)) return 0;
    return Math.round(Math.atan2(tip.y - y, tip.x - x) * 1000) / 1000;
  }

  // Interior angle (degrees) at a 2-neighbor path pixel: walk k steps down
  // both branches and measure the angle between the two arms. Straight line
  // → ~180°; sharp drawn corner → well under 120°. Returns null when either
  // walk terminates immediately (too near a junction/endpoint to judge).
  function pathInteriorAngle(img, w, x, y, steps) {
    const n = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dy) continue;
        if (img[(y + dy) * w + (x + dx)]) n.push({ x: x + dx, y: y + dy });
      }
    }
    if (n.length !== 2) return null;
    // Block each arm's walk from stepping into the OTHER arm's first pixel:
    // on an 8-connected corner the two arms touch diagonally right next to
    // the center, and without the block the walker reads that contact as a
    // fork and aborts before it can measure the bend.
    const armA = walkSkeleton(img, w, n[0].x, n[0].y, { x, y }, steps, [n[1].y * w + n[1].x]);
    const armB = walkSkeleton(img, w, n[1].x, n[1].y, { x, y }, steps, [n[0].y * w + n[0].x]);
    const a = armA[armA.length - 1];
    const b = armB[armB.length - 1];
    if (!a || !b) return null;
    // Require both arms to have real length; a 1px stub says nothing.
    if (Math.hypot(a.x - x, a.y - y) < 2 || Math.hypot(b.x - x, b.y - y) < 2) return null;
    const v1x = a.x - x, v1y = a.y - y;
    const v2x = b.x - x, v2y = b.y - y;
    const dot = v1x * v2x + v1y * v2y;
    const m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    if (!m1 || !m2) return null;
    const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
    return (Math.acos(cos) * 180) / Math.PI;
  }

  // Walk along the skeleton from (x, y), never revisiting pixels, stopping
  // at forks, dead ends, or after `steps`. `from` seeds the visited set with
  // the pixel we came from; `blockedIdx` (optional array of mask indices)
  // marks pixels the walk must never enter. Returns visited pixels in order.
  function walkSkeleton(img, w, x, y, from, steps, blockedIdx) {
    const path = [{ x, y }];
    const visited = new Set([y * w + x]);
    if (from) visited.add(from.y * w + from.x);
    if (blockedIdx) for (const b of blockedIdx) visited.add(b);
    let cx = x, cy = y;
    for (let s = 0; s < steps; s += 1) {
      let next = null;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          const idx = ny * w + nx;
          if (visited.has(idx)) continue;
          if (img[idx]) {
            if (!next) next = { x: nx, y: ny };
            count += 1;
          }
        }
      }
      // Stop at forks (ambiguous continuation) and dead ends.
      if (!next || count > 1) break;
      visited.add(next.y * w + next.x);
      cx = next.x; cy = next.y;
      path.push(next);
    }
    return path;
  }

  // Phase 4 (contour evidence): shape the raw skeleton feature points from
  // detectJunctions into a reusable, decision-free topology bundle — points
  // split by type plus normalized stroke statistics. Pure: same junctionMap in
  // → same topology out. It lives in the junction module so the endpoint /
  // junction evidence shaping stays unit-testable alongside detectJunctions
  // (scripts/junction-tests.mjs), and carries NO garment-level meaning: it is
  // shape evidence only, never an anchor or a geometry verdict.
  function buildContourTopology(junctionMap) {
    const points = junctionMap && Array.isArray(junctionMap.points) ? junctionMap.points : [];
    const summary = (junctionMap && junctionMap.summary) || {};
    const junctions = [];
    const endpoints = [];
    const corners = [];
    for (const p of points) {
      if (p.type === 'junction') junctions.push(p);
      else if (p.type === 'endpoint') endpoints.push(p);
      else if (p.type === 'corner') corners.push(p);
    }
    const strokeStats = {
      skeletonPx: summary.skeletonPx || 0,
      thinningIterations: summary.thinningIterations || 0,
      prunedSpurs: summary.prunedSpurs || 0,
      suppressedDense: summary.suppressedDense || 0,
      featurePoints: points.length,
      junctionCount: junctions.length,
      endpointCount: endpoints.length,
      cornerCount: corners.length,
      capped: !!summary.capped,
    };
    return { junctions, endpoints, corners, strokeStats };
  }

  // Merge points closer than radius. Type priority junction > corner >
  // endpoint (a thick junction often also reads as several corners). Points are
  // processed highest-priority-first, so the survivor is the highest-priority
  // (tie-broken by confidence) point and keeps ITS OWN position; each absorbed
  // duplicate only adds a small confidence boost. (Earlier the comment claimed
  // a confidence-weighted mean position — the code never averaged positions.)
  function mergeNearbyFeaturePoints(points, radius) {
    if (points.length < 2) return points;
    const prio = { junction: 3, corner: 2, endpoint: 1 };
    const sorted = points.slice().sort((a, b) =>
      (prio[b.type] - prio[a.type]) || (b.confidence - a.confidence));
    const cell = Math.max(1, radius);
    const grid = new Map();
    const keyOf = (x, y) => ((x / cell) | 0) + ':' + ((y / cell) | 0);
    const out = [];
    for (const p of sorted) {
      let absorbed = false;
      const gx = (p.xPx / cell) | 0;
      const gy = (p.yPx / cell) | 0;
      for (let dy = -1; dy <= 1 && !absorbed; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const bucket = grid.get((gx + dx) + ':' + (gy + dy));
          if (!bucket) continue;
          for (const q of bucket) {
            if (Math.hypot(q.xPx - p.xPx, q.yPx - p.yPx) <= radius) {
              q.confidence = clamp01(q.confidence + 0.05);
              absorbed = true;
              break;
            }
          }
          if (absorbed) break;
        }
      }
      if (absorbed) continue;
      const key = keyOf(p.xPx, p.yPx);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(p);
      out.push(p);
    }
    return out;
  }
