// Pure math / geometry helpers shared across rendering, interactions,
// hit testing, and annotation builders. Source part for app.js.
// Run `npm run build` after editing.

  function midpoint(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function clonePoint(point) {
    return { x: point.x, y: point.y };
  }

  function pointToSegmentDistance(p, a, b) {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (l2 === 0) return distance(p, a);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = clamp(t, 0, 1);
    const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    return distance(p, proj);
  }

  // Strict segment-segment intersection (both t and u in [0,1]) — null when
  // the two SEGMENTS don't actually cross (parallel, coincident, or crossing
  // only on their infinite extensions). Deliberately stricter than a
  // line-line intersection: a snap target should be a crossing the TD can
  // actually see drawn on the board, not a projection past either line's end.
  function segmentIntersection(a1, a2, b1, b2) {
    const rX = a2.x - a1.x, rY = a2.y - a1.y;
    const sX = b2.x - b1.x, sY = b2.y - b1.y;
    const denom = rX * sY - rY * sX;
    if (Math.abs(denom) < 1e-9) return null;
    const dx = b1.x - a1.x, dy = b1.y - a1.y;
    const t = (dx * sY - dy * sX) / denom;
    const u = (dx * rY - dy * rX) / denom;
    if (t < 0 || t > 1 || u < 0 || u > 1) return null;
    return { x: a1.x + t * rX, y: a1.y + t * rY };
  }
