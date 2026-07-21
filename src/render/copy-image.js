// Copy Image: render the whole board (sketch + applied lines + labels) to
// an offscreen canvas at content bounds and place a PNG on the system
// clipboard. Fully offline — canvas.toBlob feeds navigator.clipboard
// directly, so the pixels never leave the machine (offline invariant).
// Source part for app.js. Run `npm run build` after editing.
//
// copyBoardImageToClipboard reuses the export-pdf render core:
// getContentBounds picks the region, then renderBoardRegionToCanvas applies
// the same ctx-redirect trick as createExportCanvas to draw images, erase
// strokes, and annotations at full alpha — without the A4 page fitting.

  async function copyBoardImageToClipboard() {
    const bounds = getContentBounds();
    if (!bounds) {
      showToast('Nothing to copy yet. Paste an image or draw annotations first.');
      return;
    }
    if (!(navigator.clipboard
        && typeof navigator.clipboard.write === 'function'
        && typeof window.ClipboardItem === 'function')) {
      showToast('Copy Image is not supported by this browser. Use Export PDF instead.', 4200);
      return;
    }
    try {
      const canvas = renderBoardRegionToCanvas(bounds);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob produced no data'))),
          'image/png'
        );
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      showToast('Board copied as a PNG image — paste it into any app.');
    } catch (error) {
      console.error('[Copy Image] failed:', error);
      showToast('Could not copy — the browser blocked clipboard access. Use Export PDF instead.', 4200);
    }
  }

  // Draw everything inside `bounds` onto a fresh canvas sized to the content
  // (2x for crisp lines, capped so huge sketches cannot allocate absurd
  // bitmaps). Same redirect-the-global-ctx approach as createExportCanvas in
  // export-pdf.js; restore is wrapped in try/finally so a draw error can
  // never leave the live board pointing at the temp canvas.
  function renderBoardRegionToCanvas(bounds) {
    const MAX_COPY_DIMENSION = 4096;
    const scale = Math.min(2, MAX_COPY_DIMENSION / bounds.width, MAX_COPY_DIMENSION / bounds.height);
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    const copyCanvas = document.createElement('canvas');
    copyCanvas.width = width;
    copyCanvas.height = height;
    const copyCtx = copyCanvas.getContext('2d');
    const oldCtx = ctx;
    const oldZoom = state.zoom;
    const oldPanX = state.panX;
    const oldPanY = state.panY;
    ctx = copyCtx;
    state.zoom = scale;
    state.panX = -bounds.x * scale;
    state.panY = -bounds.y * scale;
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.save();
      ctx.translate(state.panX, state.panY);
      ctx.scale(state.zoom, state.zoom);
      for (const image of state.images) drawImageItem(image);
      for (const stroke of state.eraseStrokes) drawEraseStroke(stroke);
      for (const ann of visibleExportAnnotations()) drawAnnotationForExport(ann);
      ctx.restore();
    } finally {
      ctx = oldCtx;
      state.zoom = oldZoom;
      state.panX = oldPanX;
      state.panY = oldPanY;
    }
    requestRender();
    return copyCanvas;
  }
