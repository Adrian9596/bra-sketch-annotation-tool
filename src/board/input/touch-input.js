// Manual-mode touch/pen input layer (US-036). Source part for app.js.
// Run `npm run build` after editing.
//
// Translates pointer events into the SAME mouse handlers in
// pointer-events.js, and owns the pinch-zoom / tap / double-tap gesture
// state plus the wheel handler.

// ---- US-036: touch layer -----------------------------------------------
// Touch (and pen) input arrives as pointer events and routes into the SAME
// mouse handlers, so every gesture rule (selection, drag semantics, one
// history commit per gesture) is shared, not duplicated. Mouse pointers are
// filtered out — the existing mouse listeners keep handling them — and
// preventDefault() on pointerdown suppresses the browser's compatibility
// mouse events so nothing double-fires. Two fingers open a pinch session:
// zoom scales with finger distance, pan keeps the world point that was
// under the finger midpoint pinned to it (same math as zoomAtScreenPoint).
const touchPoints = new Map(); // pointerId -> {x, y} client coords
let touchPinch = null;         // { d0, zoom0, world0 }
let touchTapCandidate = null;  // current finger: { t, x, y, moved }
let lastTouchTap = null;       // last COMPLETED clean tap: { t, x, y }

function onTouchPointerDown(e) {
  if (e.pointerType === 'mouse') return;
  e.preventDefault();
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Synthetic PointerEvents (tests) carry no real pointer id to capture.
  try { el.canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
  if (touchPoints.size === 2) {
    // Second finger: this is a pinch, never a tap — kill tap tracking so a
    // pinch started near a recent tap can't trigger an accidental fit.
    touchTapCandidate = null;
    lastTouchTap = null;
    // Commit any in-flight one-finger drag first so the pinch never
    // smears into the drag's history entry.
    if (state.interaction || state.eraseSession) onMouseUp(e);
    beginTouchPinch();
    return;
  }
  if (touchPoints.size === 1) {
    touchTapCandidate = { t: performance.now(), x: e.clientX, y: e.clientY, moved: false };
    onMouseDown(e);
  }
}

function onTouchPointerMove(e) {
  if (e.pointerType === 'mouse' || !touchPoints.has(e.pointerId)) return;
  e.preventDefault();
  touchPoints.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touchPinch) {
    updateTouchPinch();
    return;
  }
  if (touchTapCandidate
      && Math.hypot(e.clientX - touchTapCandidate.x, e.clientY - touchTapCandidate.y) > 8) {
    touchTapCandidate.moved = true; // it's a drag, not a tap
  }
  onMouseMove(e);
}

function onTouchPointerEnd(e) {
  if (e.pointerType === 'mouse' || !touchPoints.has(e.pointerId)) return;
  touchPoints.delete(e.pointerId);
  if (touchPinch) {
    // Pinch over: a remaining finger starts nothing new until lifted —
    // that avoids a surprise drag from wherever the leftover finger sits.
    if (touchPoints.size < 2) touchPinch = null;
    return;
  }
  onMouseUp(e);
  // Double-tap = fit (parity with double-click / F): decided on the UP of a
  // clean tap (quick, unmoved, never joined by a second finger), so pinches
  // and drags can never fire it. touch-action:none means the browser won't
  // synthesize dblclick for us.
  const now = performance.now();
  const tap = touchTapCandidate;
  touchTapCandidate = null;
  if (!tap || tap.moved || now - tap.t > 400) { lastTouchTap = null; return; }
  if (lastTouchTap && now - lastTouchTap.t < 350
      && Math.hypot(tap.x - lastTouchTap.x, tap.y - lastTouchTap.y) < 20
      && state.tool === 'select') {
    lastTouchTap = null;
    onDoubleClick(e);
    return;
  }
  lastTouchTap = { t: now, x: tap.x, y: tap.y };
}

function touchMidAndDist() {
  const rect = el.canvas.getBoundingClientRect();
  const pts = [...touchPoints.values()];
  return {
    mid: {
      x: (pts[0].x + pts[1].x) / 2 - rect.left,
      y: (pts[0].y + pts[1].y) / 2 - rect.top,
    },
    dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
  };
}

function beginTouchPinch() {
  const { mid, dist } = touchMidAndDist();
  touchPinch = {
    d0: Math.max(1, dist),
    zoom0: state.zoom,
    world0: screenToWorld(mid.x, mid.y),
  };
}

function updateTouchPinch() {
  if (touchPoints.size < 2) return;
  const { mid, dist } = touchMidAndDist();
  const nextZoom = clamp(touchPinch.zoom0 * (dist / touchPinch.d0), MIN_ZOOM, MAX_ZOOM);
  state.zoom = nextZoom;
  state.panX = mid.x - touchPinch.world0.x * nextZoom;
  state.panY = mid.y - touchPinch.world0.y * nextZoom;
  updateUI();
  requestRender();
}

function onWheel(e) {
  e.preventDefault();

  if (e.shiftKey) {
    state.panX -= normalizeWheelDelta(e) * 0.45;
    updateUI();
    requestRender();
    return;
  }

  const mouse = getMousePos(e);
  const sensitivity = e.altKey ? PRECISE_ZOOM_SENSITIVITY : ZOOM_SENSITIVITY;
  const factor = Math.exp(-normalizeWheelDelta(e) * sensitivity);
  zoomAtScreenPoint(state.zoom * factor, mouse.x, mouse.y);
}
