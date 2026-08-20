// Pointer/viewport math + double-click dispatch. Source part for app.js.
// Run `npm run build` after editing.
//
// getMousePos/screenToWorld/getViewportRect/normalizeWheelDelta/
// zoomAtScreenPoint are the coordinate-space conversions used throughout
// the render/interaction code; onDoubleClick is the double-click input
// handler (select annotation / fit image / fit-all). The draw loop itself
// (render(), requestRender(), etc.) lives in the sibling render-loop.js,
// which loads after this file.

  function getMousePos(e) {
    // Read the live rect for pointer input. Mode/toolbars can change the
    // canvas position without a window resize, and a stale cached rect makes
    // clicks land offset from the cursor.
    //
    // US-086 — EXCEPT for the duration of one gesture. Selecting a line on
    // mousedown reveals the contextual toolbar row, which pushes the canvas
    // down (measured: 35.5px) BEFORE the first mousemove arrives. Read live,
    // the same physical cursor position then resolves to a world point ~35px
    // away, so the line lurched the instant the TD grabbed it and no
    // click-vs-drag threshold could hold. A gesture has to be measured in one
    // frame: mousedown pins the rect, mouseup releases it.
    //
    // Two limits keep the pin from leaking. state.lastCanvasRect always gets
    // the LIVE rect — Fit and the render loop read it, and a pinned value there
    // would shift the whole board after a drag. And the pin only applies while
    // a gesture is genuinely in flight, so a press that opened no interaction
    // (or a cleanup that never ran) cannot leave stale coordinates behind for
    // hover work that runs with no interaction at all.
    //
    // US-088 — the pin is no longer the whole story, and must not be read as
    // it. It froze the coordinates but not the canvas, which went on being
    // painted from a stale backing buffer; resizeCanvas now handles the reflow
    // itself and re-pins this rect in lockstep with the pan it compensates, so
    // the clientY -> world mapping is identical either side of a reflow. The
    // pin survives as the guarantee that a gesture reads ONE frame even if the
    // ResizeObserver has not run yet. resizeCanvas deliberately diffs
    // state.sizedCanvasRect, not the live value written just below.
    const live = el.canvas.getBoundingClientRect();
    state.lastCanvasRect = live;
    const inGesture = !!(state.interaction || state.drawSession || state.eraseSession);
    const rect = (inGesture && state.gestureCanvasRect) || live;
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

function screenToWorld(x, y) {
  return {
    x: (x - state.panX) / state.zoom,
    y: (y - state.panY) / state.zoom
  };
}

function getViewportRect() {
  return state.lastCanvasRect || el.canvas.getBoundingClientRect();
}

function normalizeWheelDelta(e) {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) return e.deltaY * 16;
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) return e.deltaY * getViewportRect().height;
  return e.deltaY;
}

function zoomAtScreenPoint(nextZoom, screenX, screenY) {
  const clampedZoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  if (Math.abs(clampedZoom - state.zoom) < 0.0001) return;
  const before = screenToWorld(screenX, screenY);
  state.zoom = clampedZoom;
  state.panX = screenX - before.x * state.zoom;
  state.panY = screenY - before.y * state.zoom;
  updateUI();
  requestRender();
}

function onDoubleClick(e) {
  if (state.tool !== 'select') return;
  const mouse = getMousePos(e);
  const world = screenToWorld(mouse.x, mouse.y);
  const annHit = hitTestAnnotations(world);
  if (annHit) {
    setSelection('annotation', annHit.id);
    openLabelEditor(annHit.id);
    return;
  }
  const imageHit = hitTestImages(world);
  if (imageHit) {
    setSelection('image', imageHit.id);
    const image = getImageById(imageHit.id);
    if (image) fitBoundsToViewport(getImageBounds(image));
    return;
  }
  fitSelectionOrAll();
}
