// ADR 0071: the Notch tool. A garment-pattern notch is a small alignment mark
// cut into a piece's outline, used to match up two pieces while sewing. The
// TD clicks near an existing line (most often a DXF-imported piece's
// outline); this drops a short tick mark AT the nearest point on that line,
// oriented perpendicular to it there. `state.notches` is a new, standalone
// collection — plain WORLD coordinates (like state.graphics/state.notes, not
// normalized to an owning image: a piece can sit in blank Scratch Area space
// with no image to normalize against). A notch carries no POM identity and
// is never a measurement, mirroring how a Board text note is handled.
// Source part for app.js. Run `npm run build` after editing.
//
// v1 scope, deliberately: place + select + delete. No drag-to-reposition
// (delete and re-place instead) and no length/angle editing UI — the tick's
// direction and length are fully derived at placement time from the nearest
// line there. Revisit if a real workflow need for repositioning shows up.

  const NOTCH_TOLERANCE_PX = 16; // same order as other click tolerances (e.g. endpointRadiusPx: 14)
  const NOTCH_LENGTH_PX = 16; // desired ON-SCREEN tick length at the moment it is placed
  const NOTCH_CURVE_SAMPLES = 48; // dense enough that the nearest-sample error is sub-pixel at typical zoom

  // The closest point on a single straight or curved annotation to `p`, plus
  // the curve/line's own tangent direction there (for the perpendicular tick
  // angle) and the distance (for the click-tolerance gate). Curved segments
  // are sampled rather than solved in closed form — this mirrors how the
  // board already tessellates a curve for hit-testing/length elsewhere; a
  // notch's placement accuracy does not need to beat that.
  function nearestPointOnAnnotation(ann, p) {
    if (ann.type === 'straight') {
      const a = ann.start, b = ann.end;
      const abx = b.x - a.x, aby = b.y - a.y;
      const lenSq = abx * abx + aby * aby;
      let t = lenSq > 1e-9 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq : 0;
      t = Math.max(0, Math.min(1, t));
      const point = { x: a.x + abx * t, y: a.y + aby * t };
      return { point, tangent: { x: abx, y: aby }, dist: distance(point, p) };
    }
    let best = null;
    for (const seg of getCurveBeziers(ann)) {
      for (let i = 0; i <= NOTCH_CURVE_SAMPLES; i += 1) {
        const t = i / NOTCH_CURVE_SAMPLES;
        const point = bezierPoint(seg.p0, seg.p1, seg.p2, seg.p3, t);
        const dist = distance(point, p);
        if (!best || dist < best.dist) best = { point, tangent: bezierTangent(seg.p0, seg.p1, seg.p2, seg.p3, t), dist };
      }
    }
    return best;
  }

  // The closest point across EVERY annotation on the board — a notch may sit
  // on any line, not only a DXF piece's, since nothing about the mark itself
  // is DXF-specific.
  function nearestPointOnBoard(p) {
    let best = null;
    for (const ann of state.annotations) {
      const hit = nearestPointOnAnnotation(ann, p);
      if (hit && (!best || hit.dist < best.dist)) best = hit;
    }
    return best;
  }

  // Click too far from any line: do nothing rather than guess a direction
  // for a mark that would not actually sit on the pattern's edge.
  function placeNotchAt(world) {
    const hit = nearestPointOnBoard(world);
    const tolWorld = NOTCH_TOLERANCE_PX / Math.max(0.0001, state.zoom);
    if (!hit || hit.dist > tolWorld) {
      showToast('Click closer to a line to place a notch.');
      return;
    }
    const tangentLen = Math.hypot(hit.tangent.x, hit.tangent.y) || 1;
    // Rotate the tangent 90°; either perpendicular direction draws the same
    // symmetric tick, so no "which side" choice is needed.
    const angle = Math.atan2(-hit.tangent.x / tangentLen, hit.tangent.y / tangentLen);
    const notch = {
      id: state.idCounter++,
      x: hit.point.x,
      y: hit.point.y,
      angle,
      length: NOTCH_LENGTH_PX / Math.max(0.0001, state.zoom),
      color: 'black',
    };
    if (!Array.isArray(state.notches)) state.notches = [];
    state.notches.push(notch);
    setSelection('notch', notch.id);
    pushHistoryIfChanged();
    showToast('Notch placed.');
  }

  function getNotchById(id) {
    return (state.notches || []).find(n => n.id === id) || null;
  }

  // Mirrors normalizeNote's own defensiveness (src/manual/note-model.js): a
  // record whose position isn't finite is dropped rather than crashing the
  // load or drawing garbage at (NaN, NaN).
  function normalizeNotch(raw) {
    if (!raw || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) return null;
    return {
      id: raw.id,
      x: raw.x,
      y: raw.y,
      angle: Number.isFinite(raw.angle) ? raw.angle : 0,
      length: Number.isFinite(raw.length) && raw.length > 0 ? raw.length : NOTCH_LENGTH_PX,
      color: normalizeColorKey(raw.color || 'black'),
    };
  }

  // Endpoints of the tick, for both rendering and hit-testing — a notch is
  // drawn straddling its anchor point, half each side along its own angle.
  function notchEndpoints(notch) {
    const half = notch.length / 2;
    const dx = Math.cos(notch.angle) * half, dy = Math.sin(notch.angle) * half;
    return { a: { x: notch.x - dx, y: notch.y - dy }, b: { x: notch.x + dx, y: notch.y + dy } };
  }

  // A fixed WORLD length (set once at placement — see placeNotchAt), unlike
  // a "feature size" (stroke width, handles) that stays a constant SCREEN
  // size at every zoom: a notch is a real mark on the pattern, so it should
  // visually grow/shrink with the piece exactly like the outline it sits on.
  // Only the STROKE THICKNESS is a feature size, so a notch stays legible
  // whether the piece is tiny or filling the whole board.
  function drawNotch(notch) {
    const { a, b } = notchEndpoints(notch);
    ctx.save();
    ctx.strokeStyle = getAnnotationColor({ color: notch.color });
    ctx.lineWidth = 3 / featureZoom();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    if (state.selection.kind === 'notch' && state.selection.id === notch.id) {
      ctx.beginPath();
      ctx.fillStyle = SELECT_COLOR;
      ctx.arc(notch.x, notch.y, 4 / featureZoom(), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Radius-based, like an endpoint handle — a notch is a short tick, not an
  // area with an interior, so there is no reason to hit-test along its whole
  // length versus just how close the click landed to it.
  function hitTestNotches(world) {
    const notches = state.notches || [];
    const tolWorld = NOTCH_TOLERANCE_PX / Math.max(0.0001, state.zoom);
    for (let i = notches.length - 1; i >= 0; i -= 1) {
      const notch = notches[i];
      const { a, b } = notchEndpoints(notch);
      if (pointToSegmentDistance(world, a, b) <= tolWorld) return { id: notch.id };
    }
    return null;
  }
