// Manual mode: viewport / fit / panel-toggle helpers. resizeCanvas keeps
// the canvas backing buffer in sync with its CSS box (and preserves the
// world-space center across resizes); the fit-to-* helpers compute pan/zoom
// to frame either the selected image or every image on the board.
// Source part for app.js. Run `npm run build` after editing.

function resizeCanvas() {
  const previousRect = state.lastCanvasRect;
  const worldCenter = previousRect
    ? {
        x: (previousRect.width / 2 - state.panX) / state.zoom,
        y: (previousRect.height / 2 - state.panY) / state.zoom,
      }
    : null;

  const rect = el.canvas.getBoundingClientRect();
  state.lastCanvasRect = rect;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  el.canvas.width = Math.round(rect.width * dpr);
  el.canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (worldCenter) {
    state.panX = rect.width / 2 - worldCenter.x * state.zoom;
    state.panY = rect.height / 2 - worldCenter.y * state.zoom;
  }

  requestRender();
}

function toggleSpecPanel() {
  const hidden = el.workspace.classList.toggle('panel-hidden');
  el.togglePanelBtn.textContent = hidden ? 'Show Panel' : 'Hide Panel';
  el.togglePanelBtn.classList.toggle('active', hidden);
  // Layout changed — recompute canvas size and keep current view.
  resizeCanvas();
}

function toggleLabels() {
  state.showLabels = !state.showLabels;
  // If a label editor is open and labels are being hidden, close it first so
  // the floating input doesn't linger over a now-invisible callout.
  if (!state.showLabels && state.editingLabelId != null) {
    cancelLabelEditor();
  }
  updateUI();
  requestRender();
}

function fitSelectionOrAll() {
  const selectedImage = getSelectedImage();
  if (selectedImage) {
    fitBoundsToViewport(getImageBounds(selectedImage));
    return;
  }
  fitImagesToBoard();
}

function fitImagesToBoard() {
  if (!state.images.length) {
    resetViewport();
    return;
  }
  fitBoundsToViewport(getImagesBounds());
}

function fitBoundsToViewport(bounds) {
  const rect = getViewportRect();
  if (!bounds || rect.width <= 0 || rect.height <= 0) {
    resetViewport();
    return;
  }

  const availW = Math.max(80, rect.width - IMAGE_PADDING * 2);
  const availH = Math.max(80, rect.height - IMAGE_PADDING * 2);
  const zoom = clamp(Math.min(availW / bounds.width, availH / bounds.height), MIN_ZOOM, MAX_ZOOM);
  state.zoom = zoom;
  state.panX = rect.width / 2 - (bounds.x + bounds.width / 2) * zoom;
  state.panY = rect.height / 2 - (bounds.y + bounds.height / 2) * zoom;
  updateUI();
  requestRender();
}

function resetViewport() {
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  updateUI();
  requestRender();
}

function getImagesBounds() {
    const first = state.images[0];
    let minX = first.x;
    let minY = first.y;
    let maxX = first.x + first.width;
    let maxY = first.y + first.height;
    for (let i = 1; i < state.images.length; i += 1) {
      const image = state.images[i];
      minX = Math.min(minX, image.x);
      minY = Math.min(minY, image.y);
      maxX = Math.max(maxX, image.x + image.width);
      maxY = Math.max(maxY, image.y + image.height);
    }
    return {
      x: minX,
      y: minY,
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    };
  }

function getImageBounds(image) {
  return {
    x: image.x,
    y: image.y,
    width: Math.max(1, image.width),
    height: Math.max(1, image.height),
  };
}

// Annotations whose line midpoint sits within the image are treated as part of
// that sketch, so dragging the image moves its callouts as one group.
function getAnnotationsOnImage(image) {
  const bounds = getImageBounds(image);
  return state.annotations.filter(ann => {
    const cx = (ann.start.x + ann.end.x) / 2;
    const cy = (ann.start.y + ann.end.y) / 2;
    return cx >= bounds.x && cx <= bounds.x + bounds.width
      && cy >= bounds.y && cy <= bounds.y + bounds.height;
  });
}
