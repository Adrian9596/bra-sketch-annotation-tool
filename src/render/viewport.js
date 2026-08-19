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
    const rect = el.canvas.getBoundingClientRect();
    state.lastCanvasRect = rect;
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
