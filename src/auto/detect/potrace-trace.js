// Vector tracing and bezier curve fitting: wraps the vendored Potrace singleton
// (via an offscreen canvas), parses the SVG it emits into normalized contour
// paths, and fits a cubic through the traced arc between two POM endpoints.
//
// Also holds buildContourCurveCandidates, the one classification pass that turns
// traced paths into the reusable curve-candidate list on the detection object.
//
// matchContourForCurve is called cross-file from
// src/auto/drafts/pom-fixture-builder.js behind a `typeof` guard, so its name is
// part of the contract. Nothing else in the detector needs to know how an SVG
// path is parsed or matched.
// Source part for app.js. Run `npm run build` after editing.

  // Potrace vector tracer — wraps the singleton Potrace API (potrace.js) into
  // a Promise that takes the ink mask and returns normalized contour paths.
  //
  // Why we trace at all: the row/column peak detector finds straight reference
  // lines well (chest, band, axis), but cup arcs, strap curves and the back
  // hook are curved. Tracing gives real cubic-Bezier control points instead of
  // hand-tuned guesses.
  //
  // Returns: { paths: [{ start: {x,y}, segments: [{type:'C'|'L', c1?, c2?, end}], bbox }], sampleWidth, sampleHeight }
  // All coordinates are normalized to [0,1] of the source image.
  function tracePotraceFromMask(dark, w, h) {
    if (typeof Potrace === 'undefined' || !Potrace || typeof Potrace.process !== 'function') {
      return Promise.resolve(null);
    }
    // Render the binary mask as black ink on white background. Potrace
    // expects a normal raster image; it re-binarises from luminance.
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return Promise.resolve(null);
    const img = ctx.createImageData(w, h);
    const data = img.data;
    for (let p = 0, i = 0; p < dark.length; p += 1, i += 4) {
      const v = dark[p] ? 0 : 255;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);

    let url;
    try {
      url = off.toDataURL('image/png');
    } catch (err) {
      console.warn('[Auto Mode] Potrace: cannot encode mask to PNG:', err);
      return Promise.resolve(null);
    }

    // Tracing params tuned for technical-sketch ink: small turdsize so we
    // keep thin strap edges; alphamax 1.0 keeps smooth curves; optcurve so we
    // emit beziers instead of dense polylines.
    Potrace.setParameter({
      turdsize: 4,
      alphamax: 1.0,
      optcurve: true,
      opttolerance: 0.2,
      turnpolicy: 'minority',
    });
    Potrace.loadImageFromUrl(url);

    return new Promise((resolve) => {
      let waited = 0;
      function tick() {
        // potrace.js sets isReady inside img.onload — poll until it flips.
        if (!Potrace.img || !Potrace.img.complete) {
          waited += 1;
          if (waited > 200) { resolve(null); return; } // 4s ceiling
          setTimeout(tick, 20);
          return;
        }
        try {
          Potrace.process(() => {
            try {
              const svg = Potrace.getSVG(1, 'curve');
              const paths = parsePotraceSvgPaths(svg, w, h);
              resolve({ paths, sampleWidth: w, sampleHeight: h });
            } catch (err) {
              console.warn('[Auto Mode] Potrace: SVG parse failed:', err);
              resolve(null);
            }
          });
        } catch (err) {
          console.warn('[Auto Mode] Potrace.process failed:', err);
          resolve(null);
        }
      }
      tick();
    });
  }

  // Parse the SVG that Potrace emits. The SVG contains one <path d="...">
  // built from absolute M / C / L commands (no relatives, no arcs). We split
  // on M to get subpaths, then walk each subpath's commands.
  function parsePotraceSvgPaths(svg, w, h) {
    const match = /<path[^>]*\sd="([^"]+)"/.exec(svg);
    if (!match) return [];
    const d = match[1];
    // Tokens: command letter OR a signed decimal number.
    const tokens = d.match(/[MLC]|-?\d+(?:\.\d+)?/g) || [];
    const paths = [];
    let current = null;
    let cursorX = 0, cursorY = 0;
    let i = 0;
    const num = () => parseFloat(tokens[i++]);
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t === 'M') {
        if (current && current.segments.length) paths.push(finalizePath(current, w, h));
        cursorX = num(); cursorY = num();
        current = { start: { x: cursorX, y: cursorY }, segments: [] };
      } else if (t === 'L' && current) {
        // Potrace's CORNER segment emits FOUR numbers: an interior corner
        // vertex then the endpoint ("L x1 y1 x2 y2"). Push both as polyline
        // samples and advance the cursor to the true endpoint. (Reading only
        // two took the corner as the endpoint and desynced every later segment.)
        const x1 = num(); const y1 = num();
        const x2 = num(); const y2 = num();
        current.segments.push({ type: 'L', end: { x: x1, y: y1 } });
        current.segments.push({ type: 'L', end: { x: x2, y: y2 } });
        cursorX = x2; cursorY = y2;
      } else if (t === 'C' && current) {
        const c1x = num(); const c1y = num();
        const c2x = num(); const c2y = num();
        const ex  = num(); const ey  = num();
        current.segments.push({
          type: 'C',
          c1: { x: c1x, y: c1y },
          c2: { x: c2x, y: c2y },
          end:{ x: ex,  y: ey  },
        });
        cursorX = ex; cursorY = ey;
      } else {
        // Unknown token — number outside a command (shouldn't happen with
        // Potrace's output). Skip.
      }
    }
    if (current && current.segments.length) paths.push(finalizePath(current, w, h));
    return paths;
  }

  function finalizePath(path, w, h) {
    const pts = [path.start, ...path.segments.map(s => s.end)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    // Normalize to [0,1] over the source image so the consumer doesn't need
    // to know the analysis sample dimensions.
    const norm = (p) => ({ x: p.x / w, y: p.y / h });
    return {
      start: norm(path.start),
      segments: path.segments.map(s => {
        if (s.type === 'C') return { type: 'C', c1: norm(s.c1), c2: norm(s.c2), end: norm(s.end) };
        return { type: 'L', end: norm(s.end) };
      }),
      bbox: {
        x: minX / w,
        y: minY / h,
        width: (maxX - minX) / w,
        height: (maxY - minY) / h,
      },
      pointCount: pts.length,
    };
  }

  // Score how well a traced contour fits the line segment AB. The returned
  // shape contains bezier control points sampled from the matching arc — the
  // POM generator uses these for POM 9 / 10 / 14 instead of guessed S-curves.
  //
  // "preferThin" weights thin contours (real seam lines, strap edges) higher
  // than the bra outline.
  function matchContourForCurve(paths, A, B, options) {
    if (!paths || !paths.length || !A || !B) return null;
    const preferThin = !!(options && options.preferThin);
    const ax = A.x, ay = A.y, bx = B.x, by = B.y;
    const lineLen = Math.hypot(bx - ax, by - ay);
    if (lineLen < 1e-6) return null;
    // Tolerance: how far from the AB line a contour's nearest sample can be.
    const tol = Math.max(0.04, lineLen * 0.35);

    let best = null;
    let bestScore = -Infinity;
    for (const path of paths) {
      if (!path || !path.segments || !path.segments.length) continue;
      const bbox = path.bbox || { width: 1, height: 1 };
      // Reject paths whose bbox can't possibly contain both endpoints.
      const x0 = bbox.x - tol, y0 = bbox.y - tol;
      const x1 = bbox.x + bbox.width + tol, y1 = bbox.y + bbox.height + tol;
      if (ax < x0 || ax > x1 || bx < x0 || bx > x1 ||
          ay < y0 || ay > y1 || by < y0 || by > y1) continue;
      const samples = samplePathPoints(path);
      if (samples.length < 4) continue;
      let nearestA = Infinity, nearestB = Infinity;
      let idxA = -1, idxB = -1;
      for (let i = 0; i < samples.length; i += 1) {
        const dA = Math.hypot(samples[i].x - ax, samples[i].y - ay);
        const dB = Math.hypot(samples[i].x - bx, samples[i].y - by);
        if (dA < nearestA) { nearestA = dA; idxA = i; }
        if (dB < nearestB) { nearestB = dB; idxB = i; }
      }
      if (nearestA > tol || nearestB > tol) continue;
      // Thin contours score higher when preferThin is set — strap edges /
      // seam lines beat the bra outline.
      const aspect = Math.min(bbox.width, bbox.height) / Math.max(1e-6, Math.max(bbox.width, bbox.height));
      const thinness = preferThin ? clamp01(1 - aspect) : 0;
      const proximity = 1 - clamp01((nearestA + nearestB) / (2 * tol));
      const score = proximity * 1.0 + thinness * 0.6;
      if (score > bestScore) {
        bestScore = score;
        best = { path, samples, idxA, idxB };
      }
    }
    if (!best) return null;

    // Walk the closed contour from idxA → idxB the short way around (the seam
    // is one side of the loop). Sample 4 evenly-spaced points along that arc
    // and fit a cubic bezier to them by setting c1/c2 at the 1/3 and 2/3
    // sample positions.
    const arc = takeShortestArc(best.samples, best.idxA, best.idxB);
    if (arc.length < 4) return null;
    const p1 = arc[Math.floor(arc.length / 3)];
    const p2 = arc[Math.floor((2 * arc.length) / 3)];
    // A cubic does NOT pass through its control points, so using on-curve arc
    // samples directly as controls makes the curve overshoot the seam. Solve in
    // closed form for the controls C1,C2 of the cubic [A,C1,C2,B] that PASSES
    // THROUGH p1 at t=1/3 and p2 at t=2/3. Controls may fall outside [0,1].
    const fitControls = (a, b, q1, q2) => {
      const u = 27 * q1 - 8 * a - b;
      const v = 27 * q2 - a - 8 * b;
      return { c1: (2 * u - v) / 18, c2: (2 * v - u) / 18 };
    };
    const fitX = fitControls(A.x, B.x, p1.x, p2.x);
    const fitY = fitControls(A.y, B.y, p1.y, p2.y);
    return {
      c1: { x: fitX.c1, y: fitY.c1 },
      c2: { x: fitX.c2, y: fitY.c2 },
      arcLength: arc.length,
      score: bestScore,
    };
  }

  // Convert a path into a flat array of polyline samples. Cubic-segment
  // sampling at 6 points is enough to find the nearest-to-endpoint vertex.
  function samplePathPoints(path) {
    const out = [path.start];
    for (const seg of path.segments) {
      if (seg.type === 'C') {
        const prev = out[out.length - 1];
        for (let t = 0.2; t < 1; t += 0.2) {
          out.push(cubicBezierPoint(prev, seg.c1, seg.c2, seg.end, t));
        }
        out.push(seg.end);
      } else {
        out.push(seg.end);
      }
    }
    return out;
  }

  function cubicBezierPoint(p0, p1, p2, p3, t) {
    const u = 1 - t;
    const uu = u * u;
    const uuu = uu * u;
    const tt = t * t;
    const ttt = tt * t;
    return {
      x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
      y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    };
  }

  function takeShortestArc(samples, idxA, idxB) {
    if (samples.length === 0) return [];
    const n = samples.length;
    let a = idxA, b = idxB;
    if (a === b) return [samples[a]];
    // Forward arc length idxA→idxB
    const forwardLen = (b - a + n) % n;
    const backwardLen = n - forwardLen;
    const arc = [];
    if (forwardLen <= backwardLen) {
      for (let k = 0; k <= forwardLen; k += 1) arc.push(samples[(a + k) % n]);
    } else {
      for (let k = 0; k <= backwardLen; k += 1) arc.push(samples[(a - k + n) % n]);
    }
    return arc;
  }

  // Phase 4: normalize traced contour paths into a reusable curve-candidate
  // list. One classification pass shared by every downstream consumer (cup
  // inner seam, gore bottom, and future geometry/landmark curve reads) instead
  // of each re-scanning contours.paths ad hoc. Pure SHAPE evidence: bbox +
  // orientation + span flags + a back-reference to the source path index (full
  // samples remain available via samplePathPoints on demand, so this list stays
  // lean on the session-only detection object). No garment meaning is baked in.
  function buildContourCurveCandidates(traced, detection) {
    if (!traced || !Array.isArray(traced.paths)) return [];
    const axisX = detection && detection.axisX != null ? detection.axisX : null;
    const round6 = (v) => Math.round(v * 1e6) / 1e6;
    const out = [];
    for (let i = 0; i < traced.paths.length; i += 1) {
      const p = traced.paths[i];
      const b = p && p.bbox;
      if (!b) continue;
      const width = b.width, height = b.height;
      const orientation = width >= height * 1.6 ? 'horizontal'
        : height >= width * 1.6 ? 'vertical'
        : 'arc';
      const minX = b.x, maxX = b.x + width;
      const spansAxisX = axisX != null && minX < axisX && maxX > axisX;
      out.push({
        id: i,
        pathIndex: i,
        bbox: { x: round6(b.x), y: round6(b.y), width: round6(width), height: round6(height) },
        orientation,
        lengthNorm: round6(Math.hypot(width, height)),
        spansAxisX,
        center: { x: round6(minX + width / 2), y: round6(b.y + height / 2) },
        segmentCount: Array.isArray(p.segments) ? p.segments.length : 0,
      });
    }
    return out;
  }
