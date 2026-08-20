// Manual mode: viewport / fit / panel-toggle helpers. resizeCanvas keeps the
// canvas backing buffer in sync with its CSS box and holds the board still on
// screen while it does; the fit-to-* helpers compute pan/zoom to frame either
// the selected image or every image on the board.
// Source part for app.js. Run `npm run build` after editing.

// US-088 (ADR 0051). Two things have to happen every time the canvas box
// changes, and before this story neither did unless the WINDOW itself resized:
//
//   1. The backing buffer must be resized. `canvas { width:100%; height:100% }`
//      means a stale buffer is not clipped, it is STRETCHED into the new box —
//      so the whole board is painted at the wrong scale while every hit-test
//      still assumes 1:1. Measured on a 1512px window: selecting a line shrank
//      the canvas 35.5px and left the buffer at its old height, painting the
//      board 5.25% short. The gap between where a POM line is drawn and where
//      the pointer code thinks it is reached 27px near the bottom of the board
//      — nearly three times the 10px endpoint catch radius, so the TD could
//      aim dead-on at a line and never hit it.
//
//   2. The board must not move under the cursor. Preserving the world-space
//      CENTER (what this did before) is wrong for a chrome reflow: the canvas
//      top edge moves down by the same amount the height shrinks, so
//      re-centering still slid the board ~18px down the screen. Preserving the
//      board's SCREEN position — hold `pan + rect.origin` constant — is what
//      "the view did not change" actually means. A window resize keeps its
//      origin, so it now reveals board instead of sliding it, which is also the
//      better answer there.
//
// A ResizeObserver (see initCanvasResizeObserver) drives this for every layout
// change, so no future toolbar/panel edit has to remember to call it.
function resizeCanvas() {
  const previousRect = state.sizedCanvasRect;
  const rect = el.canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  // The backing buffer is a function of the CSS box AND the pixel density, so
  // both have to be in the "does this need redoing?" test. Measured: dragging
  // the window to a Retina display doubles devicePixelRatio while the CSS box
  // stays put (or settles a frame later), and render() picks the new dpr up
  // immediately for its ctx transform — so a buffer still sized for the old dpr
  // gets drawn into at 2x and the whole board doubles. Comparing only width and
  // height skipped exactly that case.
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const movedX = previousRect ? previousRect.left - rect.left : 0;
  const movedY = previousRect ? previousRect.top - rect.top : 0;
  const resized = !previousRect
    || state.sizedCanvasDpr !== dpr
    || Math.abs(previousRect.width - rect.width) > 0.01
    || Math.abs(previousRect.height - rect.height) > 0.01;
  if (!resized && movedX === 0 && movedY === 0) return;

  state.sizedCanvasRect = rect;
  state.lastCanvasRect = rect;
  state.panX += movedX;
  state.panY += movedY;

  // The gesture pin and the pan have to move together or they double-count:
  // `pan + rect.top` is what maps a clientY to a world point, and this shifted
  // both halves. Re-pinning to the new rect leaves that mapping identical, so a
  // reflow in the middle of a drag is invisible to the drag. Leaving the old
  // pin behind while pan moved would put the line back exactly where US-086
  // found it — lurching the moment the TD grabs it.
  if (state.gestureCanvasRect) state.gestureCanvasRect = rect;

  if (resized) {
    state.sizedCanvasDpr = dpr;
    el.canvas.width = Math.round(rect.width * dpr);
    el.canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  requestRender();
}

// The canvas box changes without a window resize far more often than the ad-hoc
// resizeCanvas() calls covered: the contextual toolbar row appears when a line
// is selected, the Measurements panel toggles, a page tab switches, a mode
// changes. Observing the element itself means correctness no longer depends on
// every one of those call sites remembering.
function initCanvasResizeObserver() {
  if (typeof ResizeObserver === 'function' && el.canvas) {
    new ResizeObserver(() => resizeCanvas()).observe(el.canvas);
  }
  watchDevicePixelRatio();
}

// A ResizeObserver cannot see a density change: drag the window from a Retina
// laptop panel to an external 1080p monitor and devicePixelRatio halves while
// the CSS box stays exactly the same, so nothing fires. Chrome happens to emit
// a `resize` here too, but that is not guaranteed across browsers and is the
// kind of thing that quietly stops being true. A resolution media query is the
// one signal that is actually about density; it has to be re-armed after every
// change because the query pins the old value.
function watchDevicePixelRatio() {
  if (typeof window.matchMedia !== 'function') return;
  const arm = () => {
    const dpr = window.devicePixelRatio || 1;
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => {
      if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onChange);
      resizeCanvas();
      arm();
    };
    if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange, { once: true });
  };
  arm();
}

function toggleSpecPanel() {
  const hidden = el.workspace.classList.toggle('panel-hidden');
  el.togglePanelBtn.textContent = hidden ? 'Show Measurements' : 'Hide Measurements';
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
  return annotationsWithinBounds(getImageBounds(image));
}

// Split out of getAnnotationsOnImage (US-091) so a resize can ask which lines
// belonged to the image as it was BEFORE the rect changed — asking afterwards
// would test the new bounds and lose any line the shrink pushed outside.
function annotationsWithinBounds(bounds) {
  // Auto Mode drafts live outside state.annotations (see getAnnotationById,
  // which already resolves both arrays) but they sit on the same photo and have
  // to travel with it. Filtering state.annotations alone meant that in Auto Mode
  // — where state.annotations is still empty — dragging the sketch moved the
  // photo and its anchors and left all 18 drafts standing on empty board, and
  // Apply Lines then committed them at those stale coordinates. Measured: photo
  // +92.8 world units, 0 of 18 drafts moved; the same drag after Apply moves
  // 18 of 18 by exactly 92.8.
  const drafts = state.autoMode && state.autoMode.draftAnnotations
    ? state.autoMode.draftAnnotations
    : [];
  const pool = drafts.length ? state.annotations.concat(drafts) : state.annotations;
  return pool.filter(ann => {
    if (!ann || !ann.start || !ann.end) return false;
    const cx = (ann.start.x + ann.end.x) / 2;
    const cy = (ann.start.y + ann.end.y) / 2;
    return cx >= bounds.x && cx <= bounds.x + bounds.width
      && cy >= bounds.y && cy <= bounds.y + bounds.height;
  });
}

// US-091: resizing a sketch scales the POM lines drawn on it, and leaves every
// measured value exactly where it was.
//
// The two halves are separate problems. Anchors are stored normalized to their
// image so they scale for free; annotations are absolute world coordinates and
// did not move at all — measured, a photo scaled x1.2354 left 0/18 lines
// behind, detached from the garment they annotate. Scaling them about the
// resize anchor fixes the geometry.
//
// That alone would silently restate every measurement, because a value is
// lineLength x unitsPerPx and the line just got longer. Resizing the photo on
// the board is a layout act, not a re-measurement, so each scaled line carries
// the factor in `measureScale` and lineLength divides it back out. Kept on the
// ANNOTATION rather than on the image on purpose: the line/image association is
// positional and can change, while the factor belongs to the line for good.
// calibration.unitsPerPx is global and cannot express a per-image scale, which
// is why it is not touched.
function scalePointAbout(point, origin, factor) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  point.x = origin.x + (point.x - origin.x) * factor;
  point.y = origin.y + (point.y - origin.y) * factor;
}

function scaleAnnotationsForImageResize(previousBounds, origin, factor) {
  if (!previousBounds || !origin) return;
  if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 1e-9) return;
  for (const ann of annotationsWithinBounds(previousBounds)) {
    scalePointAbout(ann.start, origin, factor);
    scalePointAbout(ann.end, origin, factor);
    for (const key of ['midPoint', 'midHandleIn', 'midHandleOut', 'control1', 'control2']) {
      if (ann[key]) scalePointAbout(ann[key], origin, factor);
    }
    scalePointAbout(ann.label, origin, factor);
    ann.measureScale = (ann.measureScale || 1) * factor;
  }
}
