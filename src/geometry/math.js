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
