// Canvas rendering, export rendering, hit testing, drawing primitives and math helpers.
// Source part for app.js. Run `npm run build` after editing.

  // -------- Rendering / hit testing --------

  function drawAutoDraftAnnotation(ann) {
    if (isReviewOnlyDraft(ann)) return;
    if (!ann.start || !ann.end) return;
    ctx.save();
    // Drafts are drawn with reduced opacity and a halo so they read as
    // proposed (not yet committed) lines.
    const isSelected = state.selection.kind === 'draft' && state.selection.id === ann.id;
    const haloColor = ann.tdApproved ? '#16a34a' : '#f59e0b';
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = haloColor;
    ctx.lineWidth = (getLineWidth(ann) + 5) / state.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    drawAnnotationPath(ann);
    ctx.stroke();
    ctx.restore();

    drawLineCore(ann, ann.tdApproved ? 0.95 : 0.7);

    if (labelsVisible() && ann.label) {
      drawLabel(ann.label, getLabelText(ann), isSelected, 1, getAnnotationColor(ann));
    }
    ctx.restore();
  }

  function hitTestAutoDraftAnnotations(world) {
    const drafts = state.autoMode.draftAnnotations;
    for (let i = drafts.length - 1; i >= 0; i -= 1) {
      const ann = drafts[i];
      if (isReviewOnlyDraft(ann)) continue;
      if (!ann.start || !ann.end) continue;
      if (ann.label && pointInLabelBounds(world, ann.label, getLabelText(ann), 8 / state.zoom)) {
        return { id: ann.id, part: 'label' };
      }
      if (isPointNearAnnotation(world, ann, 8 / state.zoom)) {
        return { id: ann.id, part: 'body' };
      }
    }
    return null;
  }

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

async function exportPdf() {
  const bounds = getContentBounds();
  if (!bounds) {
    showToast('Nothing to export yet. Paste an image or draw annotations first.');
    return;
  }

  try {
    const page = createExportCanvas(bounds);
    const jpegDataURL = page.canvas.toDataURL('image/jpeg', 0.94);
    const jpegBytes = dataURLToUint8Array(jpegDataURL);
    const pdfBlob = makeSinglePagePdfBlob(jpegBytes, page.canvas.width, page.canvas.height, page.pageWidthPt, page.pageHeightPt);
    downloadBlob(pdfBlob, makeExportFileName());
    showToast('PDF exported. It is fitted to a clean A4 page.');
  } catch (error) {
    console.error(error);
    showToast('PDF export failed. Please try again after reducing image size.', 4200);
  }
}

function getContentBounds() {
  const boxes = [];
  for (const image of state.images) boxes.push(getImageBounds(image));
  for (const ann of state.annotations) boxes.push(getAnnotationBounds(ann));
  const validBoxes = boxes.filter(box => box && isFinite(box.x) && isFinite(box.y) && isFinite(box.width) && isFinite(box.height));
  if (!validBoxes.length) return null;
  let minX = validBoxes[0].x;
  let minY = validBoxes[0].y;
  let maxX = validBoxes[0].x + validBoxes[0].width;
  let maxY = validBoxes[0].y + validBoxes[0].height;
  for (let i = 1; i < validBoxes.length; i += 1) {
    const box = validBoxes[i];
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  const padding = 26;
  return { x: minX - padding, y: minY - padding, width: Math.max(1, maxX - minX + padding * 2), height: Math.max(1, maxY - minY + padding * 2) };
}

function getAnnotationBounds(ann) {
  const points = [ann.start, ann.end, ann.label];
  if (ann.type === 'curved') {
    points.push(ann.control1, ann.control2);
    for (let i = 0; i <= BEZIER_SAMPLES; i += 1) points.push(bezierPoint(ann.start, ann.control1, ann.control2, ann.end, i / BEZIER_SAMPLES));
  }
  let minX = points[0].x, minY = points[0].y, maxX = points[0].x, maxY = points[0].y;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const pad = 32;
  return { x: minX - pad, y: minY - pad, width: Math.max(1, maxX - minX + pad * 2), height: Math.max(1, maxY - minY + pad * 2) };
}

function createExportCanvas(bounds) {
  const isLandscape = bounds.width > bounds.height;
  const mmToPx = 150 / 25.4;
  const pageWidthMm = isLandscape ? 297 : 210;
  const pageHeightMm = isLandscape ? 210 : 297;
  const pageWidthPx = Math.round(pageWidthMm * mmToPx);
  const pageHeightPx = Math.round(pageHeightMm * mmToPx);
  const marginPx = Math.round(12 * mmToPx);
  const printableWidth = pageWidthPx - marginPx * 2;
  const printableHeight = pageHeightPx - marginPx * 2;
  const exportZoom = Math.min(printableWidth / bounds.width, printableHeight / bounds.height);
  const exportPanX = (pageWidthPx - bounds.width * exportZoom) / 2 - bounds.x * exportZoom;
  const exportPanY = (pageHeightPx - bounds.height * exportZoom) / 2 - bounds.y * exportZoom;
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = pageWidthPx;
  exportCanvas.height = pageHeightPx;
  const exportCtx = exportCanvas.getContext('2d');
  const oldCtx = ctx;
  const oldZoom = state.zoom;
  const oldPanX = state.panX;
  const oldPanY = state.panY;
  ctx = exportCtx;
  state.zoom = exportZoom;
  state.panX = exportPanX;
  state.panY = exportPanY;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);
  ctx.save();
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.zoom, state.zoom);
  for (const image of state.images) drawImageItem(image);
  for (const stroke of state.eraseStrokes) drawEraseStroke(stroke);
  for (const ann of state.annotations) drawAnnotationForExport(ann);
  ctx.restore();
  ctx = oldCtx;
  state.zoom = oldZoom;
  state.panX = oldPanX;
  state.panY = oldPanY;
  requestRender();
  return { canvas: exportCanvas, pageWidthPt: pageWidthMm * 72 / 25.4, pageHeightPt: pageHeightMm * 72 / 25.4 };
}

function drawAnnotationForExport(ann) {
  drawLineCore(ann, 1);
  if (!labelsVisible()) return;
  drawLabel(ann.label, getLabelText(ann), false, 1, getAnnotationColor(ann));
}

function dataURLToUint8Array(dataURL) {
  const base64 = dataURL.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function makeSinglePagePdfBlob(jpegBytes, imageWidthPx, imageHeightPx, pageWidthPt, pageHeightPt) {
  const encoder = new TextEncoder();
  const chunks = [];
  const offsets = [0];
  let offset = 0;

  function add(data) {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data;
    chunks.push(bytes);
    offset += bytes.length;
  }

  function addObject(number, content) {
    offsets[number] = offset;
    add(number + ' 0 obj\n');
    add(content);
    add('\nendobj\n');
  }

  const contentStream = 'q\n' + fixed(pageWidthPt) + ' 0 0 ' + fixed(pageHeightPt) + ' 0 0 cm\n/Im0 Do\nQ\n';

  add('%PDF-1.4\n');
  add(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // binary comment marker, raw bytes
  addObject(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  addObject(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fixed(pageWidthPt) + ' ' + fixed(pageHeightPt) + '] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
  addObject(4, '<< /Length ' + encoder.encode(contentStream).length + ' >>\nstream\n' + contentStream + 'endstream');

  offsets[5] = offset;
  add('5 0 obj\n');
  add('<< /Type /XObject /Subtype /Image /Width ' + imageWidthPx + ' /Height ' + imageHeightPx + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpegBytes.length + ' >>\nstream\n');
  add(jpegBytes);
  add('\nendstream\nendobj\n');

  const xrefOffset = offset;
  add('xref\n0 6\n');
  add('0000000000 65535 f \n');
  for (let i = 1; i <= 5; i += 1) {
    add(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  }
  add('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF');

  return new Blob(chunks, { type: 'application/pdf' });
}

function fixed(value) {
  return Number(value).toFixed(2).replace(/\.00$/, '');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function makeExportFileName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return 'bra-sketch-annotation-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.pdf';
}

function requestRender() {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => {
      state.rafPending = false;
      render();
    });
  }

  function render() {
    const rect = state.lastCanvasRect || el.canvas.getBoundingClientRect();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);

    ctx.save();
    ctx.translate(state.panX, state.panY);
    ctx.scale(state.zoom, state.zoom);

    for (const image of state.images) {
      drawImageItem(image);
    }

    for (const stroke of state.eraseStrokes) {
      drawEraseStroke(stroke);
    }
    if (state.eraseSession) {
      drawEraseStrokeSession(state.eraseSession);
    }

    // Auto Mode offline detection overlay — drawn below project annotations
    // so it never hides committed lines, but above the image so the TD can
    // sanity-check bbox / axis / band before generating POMs.
    if (state.appMode === 'auto' && state.autoMode.detection) {
      drawDetectionOverlay(state.autoMode.detection);
    }

    for (const ann of state.annotations) {
      drawAnnotation(ann);
    }

    // Auto Mode draft layer — rendered above project annotations so reviewers
    // see the proposed lines clearly. Drafts do not enter state.annotations
    // until applyApprovedDraftsAtomically() commits them.
    if (state.appMode === 'auto') {
      for (const draft of state.autoMode.draftAnnotations) {
        drawAutoDraftAnnotation(draft);
      }
    }

    // Anchors render above drafts so they always stay grabbable.
    if (state.appMode === 'auto') {
      drawAnchors();
    }

    if (state.drawSession) {
      drawPreview();
    }

    const selectedImage = getSelectedImage();
    if (selectedImage) {
      drawImageSelection(selectedImage);
    }

    const selectedAnnotation = getSelectedAnnotation();
    if (selectedAnnotation) {
      drawSelectionHelpers(selectedAnnotation);
    }

    if (state.appMode === 'auto') {
      const selectedDraft = getSelectedDraft();
      if (selectedDraft && !isReviewOnlyDraft(selectedDraft) && selectedDraft.start) {
        drawSelectionHelpers(selectedDraft);
      }
    }

    // Live length readout while the user is dragging a line endpoint, so
    // they can size the line accurately without releasing to check the
    // measurement panel.
    drawLengthReadoutDuringHandleDrag();

    ctx.restore();
    positionLabelEditor();
  }

  function drawLengthReadoutDuringHandleDrag() {
    const inter = state.interaction;
    if (!inter || inter.type !== 'drag-handle') return;
    if (inter.part !== 'start' && inter.part !== 'end') return;
    const ann = getAnnotationById(inter.id);
    if (!ann || !ann.start || !ann.end) return;
    const lengthPx = lineLength(ann);
    let label;
    if (state.calibration.unitsPerPx != null) {
      label = formatMeasure(lengthPx * state.calibration.unitsPerPx) + ' ' + state.calibration.unit;
    } else {
      label = Math.round(lengthPx) + ' px';
    }
    const anchor = inter.part === 'start' ? ann.start : ann.end;
    const z = Math.max(state.zoom, 0.15);
    const padX = 6 / z, padY = 4 / z;
    ctx.save();
    ctx.font = '600 ' + (12 / z).toFixed(1) + 'px system-ui, sans-serif';
    const metrics = ctx.measureText(label);
    const boxW = metrics.width + padX * 2;
    const boxH = 16 / z + padY * 2;
    const bx = anchor.x + 12 / z;
    const by = anchor.y - boxH - 6 / z;
    ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 1 / z;
    const r = 5 / z;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + boxW - r, by);
    ctx.quadraticCurveTo(bx + boxW, by, bx + boxW, by + r);
    ctx.lineTo(bx + boxW, by + boxH - r);
    ctx.quadraticCurveTo(bx + boxW, by + boxH, bx + boxW - r, by + boxH);
    ctx.lineTo(bx + r, by + boxH);
    ctx.quadraticCurveTo(bx, by + boxH, bx, by + boxH - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + padX, by + boxH / 2);
    ctx.restore();
  }

  function positionLabelEditor() {
    if (state.editingLabelId == null) return;
    const ann = getAnnotationById(state.editingLabelId);
    if (!ann) { cancelLabelEditor(); return; }
    const screen = worldToScreen(ann.label.x, ann.label.y);
    el.labelEditor.style.left = screen.x + 'px';
    el.labelEditor.style.top = screen.y + 'px';
  }

  function drawImageItem(image) {
    if (!image.img) return;
    ctx.drawImage(image.img, image.x, image.y, image.width, image.height);
    if (image.locked) drawLockBadge(image);
  }

  // Small lock chip pinned to an image's top-right corner so the user can
  // always see at a glance which images are protected.
  function drawLockBadge(image) {
    const z = Math.max(state.zoom, 0.15);
    const w = 22 / z;
    const h = 22 / z;
    const pad = 6 / z;
    const x = image.x + image.width - w - pad;
    const y = image.y + pad;
    ctx.save();
    ctx.fillStyle = 'rgba(31, 41, 55, 0.85)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 1.2 / z;
    const r = 4 / z;
    // Rounded rect background
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    // Padlock glyph centered in the badge
    const cx = x + w / 2;
    const cy = y + h / 2;
    const bw = w * 0.46;
    const bh = h * 0.36;
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 1.4 / z;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Body
    ctx.beginPath();
    ctx.rect(cx - bw / 2, cy - bh / 2 + bh * 0.18, bw, bh);
    ctx.fill();
    // Shackle
    ctx.beginPath();
    ctx.arc(cx, cy - bh * 0.18, bw * 0.34, Math.PI, 0, false);
    ctx.stroke();
    ctx.restore();
  }

  // Draw the offline detection result (bbox + axis + bottom band + optional
  // chest line) anchored to its source image. All detection coordinates are
  // normalized [0, 1] relative to the image, so they survive pans, zooms,
  // and image resizes.
  function drawDetectionOverlay(detection) {
    if (!detection || !detection.bbox) return;
    const image = getImageById(detection.sourceImageId);
    if (!image || !image.img) return;

    const bx = image.x + detection.bbox.x * image.width;
    const by = image.y + detection.bbox.y * image.height;
    const bw = detection.bbox.width * image.width;
    const bh = detection.bbox.height * image.height;
    // Visual line widths are kept readable across zoom levels.
    const px = 1 / Math.max(state.zoom, 0.1);

    ctx.save();

    // View boxes — shown when the detector found separated sketch views in
    // one source image. Each view is labeled FRONT / BACK / view N based on
    // the front/back classifier so the TD can see what the detector decided.
    if (Array.isArray(detection.viewBoxes) && detection.viewBoxes.length > 1) {
      const VIEW_STYLE = {
        front: { stroke: 'rgba(14, 165, 233, 0.85)', fill: 'rgba(14, 165, 233, 0.95)', dash: [], lineW: 1.4 },
        back:  { stroke: 'rgba(168, 85, 247, 0.85)', fill: 'rgba(168, 85, 247, 0.95)', dash: [], lineW: 1.4 },
        none:  { stroke: 'rgba(100, 116, 139, 0.45)', fill: 'rgba(100, 116, 139, 0.85)', dash: [3, 3], lineW: 0.9 },
      };
      detection.viewBoxes.forEach((view, index) => {
        if (!view) return;
        const vx = image.x + view.x * image.width;
        const vy = image.y + view.y * image.height;
        const vw = view.width * image.width;
        const vh = view.height * image.height;
        const role = view.role || (index === (detection.primaryViewIndex || 0) ? 'front' : null);
        const style = VIEW_STYLE[role] || VIEW_STYLE.none;
        const label = role ? role.toUpperCase() : ('view ' + (index + 1));
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = style.lineW * px;
        ctx.setLineDash(style.dash.map((v) => v * px));
        ctx.strokeRect(vx, vy, vw, vh);
        ctx.setLineDash([]);
        ctx.font = '700 ' + (11 * px).toFixed(1) + 'px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        // Background chip behind the label so it's readable on any sketch.
        const padX = 5 * px, padY = 3 * px;
        const textW = ctx.measureText(label).width;
        const chipH = 13 * px;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillRect(vx + 2 * px, vy + 2 * px, textW + padX * 2, chipH + padY * 2);
        ctx.strokeStyle = style.stroke;
        ctx.lineWidth = 0.8 * px;
        ctx.strokeRect(vx + 2 * px, vy + 2 * px, textW + padX * 2, chipH + padY * 2);
        ctx.fillStyle = style.fill;
        ctx.fillText(label, vx + 2 * px + padX, vy + 2 * px + padY);
      });
    }

    // Bounding box — soft cyan tint inside, solid outline.
    ctx.fillStyle = 'rgba(14, 165, 233, 0.06)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.85)';
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([6 * px, 4 * px]);
    ctx.strokeRect(bx, by, bw, bh);
    ctx.setLineDash([]);

    // Center axis — solid magenta line top to bottom of bbox.
    const axisXworld = image.x + detection.axisX * image.width;
    ctx.strokeStyle = 'rgba(217, 70, 239, 0.85)';
    ctx.lineWidth = 1.4 * px;
    ctx.beginPath();
    ctx.moveTo(axisXworld, by);
    ctx.lineTo(axisXworld, by + bh);
    ctx.stroke();

    // Bottom band — solid amber line across the bbox.
    const bandYworld = image.y + detection.bandY * image.height;
    ctx.strokeStyle = 'rgba(245, 158, 11, 0.9)';
    ctx.lineWidth = 1.6 * px;
    ctx.beginPath();
    ctx.moveTo(bx, bandYworld);
    ctx.lineTo(bx + bw, bandYworld);
    ctx.stroke();

    // Chest line — dashed teal if confident enough to surface.
    let chestYworld = null;
    if (detection.chestY != null) {
      chestYworld = image.y + detection.chestY * image.height;
      ctx.strokeStyle = 'rgba(20, 184, 166, 0.85)';
      ctx.lineWidth = 1.4 * px;
      ctx.setLineDash([5 * px, 4 * px]);
      ctx.beginPath();
      ctx.moveTo(bx, chestYworld);
      ctx.lineTo(bx + bw, chestYworld);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Cradle / cup-bottom — dashed indigo, drawn between chest and band.
    let cradleYworld = null;
    if (detection.cradleY != null) {
      cradleYworld = image.y + detection.cradleY * image.height;
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.75)';
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([3 * px, 4 * px]);
      ctx.beginPath();
      ctx.moveTo(bx + bw * 0.05, cradleYworld);
      ctx.lineTo(bx + bw * 0.95, cradleYworld);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Side seams — dashed slate, vertical, only where detected.
    const seamColor = 'rgba(100, 116, 139, 0.85)';
    const seamY1 = chestYworld != null ? chestYworld : by + bh * 0.20;
    const seamY2 = bandYworld;
    if (detection.sideLeftX != null) {
      const sx = image.x + detection.sideLeftX * image.width;
      ctx.strokeStyle = seamColor;
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath();
      ctx.moveTo(sx, seamY1);
      ctx.lineTo(sx, seamY2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (detection.sideRightX != null) {
      const sx = image.x + detection.sideRightX * image.width;
      ctx.strokeStyle = seamColor;
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath();
      ctx.moveTo(sx, seamY1);
      ctx.lineTo(sx, seamY2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Apex points — small rose circles.
    const drawApex = (apex) => {
      if (!apex) return;
      const ax = image.x + apex.x * image.width;
      const ay = image.y + apex.y * image.height;
      ctx.fillStyle = 'rgba(244, 63, 94, 0.18)';
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.95)';
      ctx.lineWidth = 1.2 * px;
      ctx.beginPath();
      ctx.arc(ax, ay, 5 * px, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    };
    drawApex(detection.apexLeft);
    drawApex(detection.apexRight);

    if (detection.strapTop && detection.strapBottom) {
      const sx1 = image.x + detection.strapTop.x * image.width;
      const sy1 = image.y + detection.strapTop.y * image.height;
      const sx2 = image.x + detection.strapBottom.x * image.width;
      const sy2 = image.y + detection.strapBottom.y * image.height;
      ctx.strokeStyle = 'rgba(124, 58, 237, 0.82)';
      ctx.fillStyle = 'rgba(124, 58, 237, 0.16)';
      ctx.lineWidth = 1.2 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of [detection.strapTop, detection.strapBottom]) {
        const sx = image.x + p.x * image.width;
        const sy = image.y + p.y * image.height;
        ctx.beginPath();
        ctx.rect(sx - 3.5 * px, sy - 3.5 * px, 7 * px, 7 * px);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Back center — axis line, top/bottom dots, dashed POM 12 link between
    // them. Drawn only when the detector found a back view with usable ink.
    let backAxisXworld = null;
    if (detection.back && detection.back.top && detection.back.bottom) {
      const back = detection.back;
      backAxisXworld = image.x + back.axisX * image.width;
      const btx = image.x + back.top.x * image.width;
      const bty = image.y + back.top.y * image.height;
      const bbtx = image.x + back.bottom.x * image.width;
      const bbty = image.y + back.bottom.y * image.height;

      ctx.strokeStyle = 'rgba(16, 185, 129, 0.85)';
      ctx.lineWidth = 1.3 * px;
      ctx.setLineDash([4 * px, 3 * px]);
      ctx.beginPath();
      ctx.moveTo(backAxisXworld, bty);
      ctx.lineTo(backAxisXworld, bbty);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(5, 150, 105, 0.95)';
      ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
      ctx.lineWidth = 1.2 * px;
      for (const p of [{ x: btx, y: bty }, { x: bbtx, y: bbty }]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5 * px, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    // Corner labels (screen-pixel sized).
    const badgeFont = (11 * px).toFixed(1) + 'px system-ui, sans-serif';
    ctx.font = badgeFont;
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(14, 165, 233, 0.95)';
    ctx.fillText('bbox', bx + 4 * px, by + 4 * px);
    ctx.fillStyle = 'rgba(217, 70, 239, 0.95)';
    ctx.fillText('axis', axisXworld + 3 * px, by + 4 * px);
    ctx.fillStyle = 'rgba(245, 158, 11, 0.95)';
    ctx.fillText('band', bx + 4 * px, bandYworld - 14 * px);
    if (chestYworld != null) {
      ctx.fillStyle = 'rgba(20, 184, 166, 0.95)';
      ctx.fillText('chest', bx + 4 * px, chestYworld - 14 * px);
    }
    if (cradleYworld != null) {
      ctx.fillStyle = 'rgba(99, 102, 241, 0.95)';
      ctx.fillText('cradle', bx + 4 * px, cradleYworld - 14 * px);
    }
    if (detection.back && detection.back.top && detection.back.bottom) {
      const back = detection.back;
      const btx = image.x + back.top.x * image.width;
      const bty = image.y + back.top.y * image.height;
      const bbty = image.y + back.bottom.y * image.height;
      ctx.fillStyle = 'rgba(5, 150, 105, 0.95)';
      ctx.fillText('back top', btx + 7 * px, bty - 7 * px);
      ctx.fillText('back btm', btx + 7 * px, bbty + 3 * px);
    }

    // Quality badge — top-right of bbox. Symmetry % + overall quality letter.
    if (detection.quality != null || detection.symmetry != null) {
      const sym = (detection.symmetry || 0) * 100;
      const q = detection.quality != null ? detection.quality : 0;
      const grade = q >= 0.65 ? 'A' : (q >= 0.40 ? 'B' : 'C');
      const tagText = 'fit ' + grade + ' • sym ' + sym.toFixed(0) + '%';
      const padding = 4 * px;
      const tagW = ctx.measureText(tagText).width + padding * 2;
      const tagH = 16 * px;
      const tagX = bx + bw - tagW - 4 * px;
      const tagY = by + 4 * px;
      ctx.fillStyle = q >= 0.65
        ? 'rgba(16, 185, 129, 0.95)'
        : (q >= 0.40 ? 'rgba(245, 158, 11, 0.95)' : 'rgba(239, 68, 68, 0.95)');
      ctx.beginPath();
      ctx.roundRect(tagX, tagY, tagW, tagH, 3 * px);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(tagText, tagX + padding, tagY + 2 * px);
    }

    ctx.restore();
  }

  function drawAnchors() {
    const anchors = state.autoMode.anchors;
    if (!anchors.length) return;
    const z = Math.max(state.zoom, 0.1);
    const radius = 6 / z;            // 6px screen radius
    const hitRadius = 9 / z;          // matches hitTestAnchors
    const ringWidth = 1.6 / z;
    const labelFont = (10.5 / z).toFixed(2) + 'px system-ui, sans-serif';

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const anchor of anchors) {
      const pos = anchorWorldPos(anchor);
      if (!pos) continue;
      const selected = state.autoMode.anchorSelectedId === anchor.id;
      const fill = anchorFillForConfidence(anchor.confidence);
      const ring = anchor.autoFilled ? 'rgba(15, 23, 42, 0.55)' : '#0f172a';

      // Halo when selected
      if (selected) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.30)';
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, hitRadius + 4 / z, 0, Math.PI * 2);
        ctx.fill();
      }

      // Soft outer hit ring so users see the grab area on hover-friendly devices
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius + 2 / z, 0, Math.PI * 2);
      ctx.fill();

      // Core dot
      ctx.fillStyle = fill;
      ctx.strokeStyle = ring;
      ctx.lineWidth = ringWidth;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Mini name label, offset so it doesn't sit on top of nearby anchors
      ctx.font = labelFont;
      ctx.textBaseline = 'middle';
      const labelOffsetX = anchorLabelOffsetX(anchor) / z;
      const labelOffsetY = anchorLabelOffsetY(anchor) / z;
      const text = anchor.name;
      const padX = 4 / z;
      const padY = 2 / z;
      ctx.font = labelFont;
      const metrics = ctx.measureText(text);
      const lw = metrics.width;
      const lh = (12 / z);
      const lx = pos.x + labelOffsetX;
      const ly = pos.y + labelOffsetY;
      // Background pill
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.15)';
      ctx.lineWidth = 0.8 / z;
      const bx = lx - padX;
      const by = ly - lh / 2 - padY;
      const bw = lw + padX * 2;
      const bh = lh + padY * 2;
      ctx.beginPath();
      const rr = Math.min(4 / z, bh / 2);
      ctx.moveTo(bx + rr, by);
      ctx.lineTo(bx + bw - rr, by);
      ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + rr);
      ctx.lineTo(bx + bw, by + bh - rr);
      ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - rr, by + bh);
      ctx.lineTo(bx + rr, by + bh);
      ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - rr);
      ctx.lineTo(bx, by + rr);
      ctx.quadraticCurveTo(bx, by, bx + rr, by);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#1f2937';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lx, ly);
    }

    ctx.restore();
  }

  function anchorFillForConfidence(c) {
    if (c === 'high')   return '#16a34a';
    if (c === 'medium') return '#f59e0b';
    return '#ef4444';
  }

  // Push labels left for anchors on the right half (so they don't fly off the
  // right edge of the image), and below for top-row anchors so they don't
  // collide with the bbox badge.
  function anchorLabelOffsetX(anchor) {
    const rightSide = anchor.kind === 'band-right'
      || anchor.kind === 'chest-right'
      || anchor.kind === 'apex-right'
      || anchor.kind === 'inner-cup-right'
      || anchor.kind === 'side-top'
      || anchor.kind === 'side-bottom'
      || anchor.kind === 'strap-top';
    return rightSide ? -68 : 10;
  }
  function anchorLabelOffsetY(anchor) {
    if (anchor.kind === 'cf-top' || anchor.kind === 'strap-top') return -14;
    if (anchor.kind === 'band-left' || anchor.kind === 'band-right' || anchor.kind === 'cf-bottom') return 14;
    return 0;
  }

  function drawEraseStroke(stroke) {
    const image = getImageById(stroke.imageId);
    if (!image || !image.img) return;
    drawEraseStrokeAt(image, stroke.size, stroke.points);
  }

  function drawEraseStrokeSession(session) {
    const image = getImageById(session.imageId);
    if (!image || !image.img) return;
    drawEraseStrokeAt(image, session.size, session.points);
  }

  // Render a single stroke clipped to its parent image. Points are stored in
  // the image's natural-pixel coordinate space, so a transform from local →
  // world is applied before stroking.
  function drawEraseStrokeAt(image, size, points) {
    if (!points || !points.length) return;
    const naturalW = image.img.naturalWidth || image.width;
    const naturalH = image.img.naturalHeight || image.height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(image.x, image.y, image.width, image.height);
    ctx.clip();
    ctx.translate(image.x, image.y);
    ctx.scale(image.width / naturalW, image.height / naturalH);
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size;
    if (points.length === 1) {
      ctx.beginPath();
      ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i += 1) {
        ctx.lineTo(points[i].x, points[i].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawImageSelection(image) {
    ctx.save();
    ctx.lineWidth = 2 / state.zoom;
    // Use a muted outline when the image is locked so the user sees the
    // selection but doesn't expect to drag corners that won't respond.
    ctx.strokeStyle = image.locked ? 'rgba(107, 114, 128, 0.85)' : SELECT_COLOR;
    ctx.setLineDash([10 / state.zoom, 6 / state.zoom]);
    ctx.strokeRect(image.x, image.y, image.width, image.height);
    ctx.setLineDash([]);
    if (!image.locked) {
      for (const corner of getImageCorners(image)) {
        drawImageResizeHandle(corner);
      }
    }
    ctx.restore();
  }

  function drawImageResizeHandle(point) {
    const r = 6.5 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = SELECT_COLOR;
    ctx.stroke();
    ctx.restore();
  }

  function drawPreview() {
    const preview = state.drawSession;
    const seq = state.nextSequence;
    if (!preview || !preview.current) return;

    if (preview.type === 'extension-followup') {
      const proj = projectionOnAxis(preview.current, preview.prevEnd, preview.prevDir);
      if (!proj.qualifies) return;
      const tip = {
        x: preview.prevEnd.x + preview.prevDir.x * proj.distance,
        y: preview.prevEnd.y + preview.prevDir.y * proj.distance,
      };
      const temp = {
        type: 'straight',
        style: 'dashed',
        color: preview.color,
        arrowType: 'single',
        lineWidth: preview.lineWidth,
        start: preview.prevEnd,
        end: tip,
        label: computeDefaultLabelPosition({
          type: 'straight',
          start: preview.prevEnd,
          end: tip,
        }),
        seq,
      };
      drawLineCore(temp, 0.6);
      drawLabel(temp.label, seq, false, 0.75, getAnnotationColor(temp));
      return;
    }

    if (preview.type === 'straight') {
      const temp = {
        type: 'straight',
        style: preview.style,
        color: preview.color,
        arrowType: preview.arrowType,
        lineWidth: preview.lineWidth,
        start: preview.start,
        end: preview.current,
        label: computeDefaultLabelPosition({
          type: 'straight',
          start: preview.start,
          end: preview.current
        }),
        seq
      };
      drawLineCore(temp, 0.78);
      drawLabel(temp.label, seq, false, 0.9, getAnnotationColor(temp));
      return;
    }

    const controls = makeNaturalCurveControls(preview.start, preview.current);
    const temp = {
      type: 'curved',
      style: preview.style,
      color: preview.color,
      arrowType: preview.arrowType,
      lineWidth: preview.lineWidth,
      start: preview.start,
      end: preview.current,
      control1: controls.control1,
      control2: controls.control2,
      label: computeDefaultLabelPosition({
        type: 'curved',
        start: preview.start,
        end: preview.current,
        control1: controls.control1,
        control2: controls.control2
      }),
      seq
    };
    drawLineCore(temp, 0.78);
    drawLabel(temp.label, seq, false, 0.9, getAnnotationColor(temp));
  }

  function drawAnnotation(ann) {
    drawLineCore(ann, 1);
    if (state.editingLabelId === ann.id) return;
    if (!labelsVisible()) return;
    drawLabel(ann.label, getLabelText(ann), state.selection.kind === 'annotation' && ann.id === state.selection.id, 1, getAnnotationColor(ann));
  }

  function drawLineCore(ann, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const color = getAnnotationColor(ann);
    ctx.strokeStyle = color;
    const lineWidth = getLineWidth(ann);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let style = getLineStyle(ann);
    if (style === 'solid' && annotationCrossesViews(ann)) style = 'dashed';

    if (style === 'zigzag') {
      drawZigzagStitchLine(ann, color, lineWidth);
    } else if (style === 'cover') {
      drawCoverStitchLine(ann, color, lineWidth);
    } else if (style === 'bartack') {
      drawBartackStitchLine(ann, color, lineWidth);
    } else {
      ctx.lineWidth = lineWidth / state.zoom;
      ctx.setLineDash(style === 'dashed' ? [10 / state.zoom, 7 / state.zoom] : []);
      drawAnnotationPath(ann);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    if (ann.type === 'straight') {
      drawArrowheadsForStraight(ann, color, lineWidth);
    } else {
      drawArrowheadsForCurve(ann, color, lineWidth);
    }
    ctx.restore();
  }

  function drawAnnotationPath(ann) {
    ctx.beginPath();
    ctx.moveTo(ann.start.x, ann.start.y);
    if (ann.type === 'straight') {
      ctx.lineTo(ann.end.x, ann.end.y);
    } else {
      ctx.bezierCurveTo(
        ann.control1.x, ann.control1.y,
        ann.control2.x, ann.control2.y,
        ann.end.x, ann.end.y
      );
    }
  }

  function drawZigzagStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const step = Math.max(3 / state.zoom, (4.5 + lineWidth * 0.5) / state.zoom);
    const amplitude = Math.max(3.5 / state.zoom, (lineWidth * 1.7 + 2) / state.zoom);
    const count = Math.max(2, Math.ceil(length / step));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.2, lineWidth * 0.72) / state.zoom;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i <= count; i += 1) {
      const sample = samplePolylineAt(points, length * (i / count));
      const side = i % 2 === 0 ? -1 : 1;
      const x = sample.point.x + sample.normal.x * amplitude * side;
      const y = sample.point.y + sample.normal.y * amplitude * side;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawCoverStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const railOffset = Math.max(3.5 / state.zoom, (lineWidth * 1.35 + 2) / state.zoom);
    const stitchStep = Math.max(8 / state.zoom, (12 + lineWidth) / state.zoom);
    const stitchLength = stitchStep * 0.55;
    const stitchWidth = Math.max(1, lineWidth * 0.62) / state.zoom;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = stitchWidth;
    drawStitchRow(points, length, railOffset, stitchStep, stitchLength);
    drawStitchRow(points, length, -railOffset, stitchStep, stitchLength);
    ctx.restore();
  }

  function drawBartackStitchLine(ann, color, lineWidth) {
    const points = getAnnotationPolyline(ann, ann.type === 'straight' ? 1 : 72);
    const length = polylineLength(points);
    if (length <= 0) return;

    const barLength = length;
    const zigzagHalfWidth = Math.max(5 / state.zoom, (lineWidth * 2.3 + 4) / state.zoom);
    const stitchStep = Math.max(1.8 / state.zoom, (2.6 + lineWidth * 0.12) / state.zoom);
    const stitchWidth = Math.max(1, lineWidth * 0.58) / state.zoom;
    const startAlong = 0;
    const count = Math.max(4, Math.ceil(barLength / stitchStep));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(0.8, lineWidth * 0.38) / state.zoom;
    ctx.globalAlpha *= 0.26;
    drawAnnotationPath(ann);
    ctx.stroke();

    ctx.globalAlpha /= 0.26;
    ctx.lineWidth = stitchWidth;
    ctx.beginPath();
    for (let i = 0; i <= count; i += 1) {
      const distanceAlong = clamp(startAlong + (barLength * i / count), 0, length);
      const sample = samplePolylineAt(points, distanceAlong);
      const side = i % 2 === 0 ? -1 : 1;
      const x = sample.point.x + sample.normal.x * zigzagHalfWidth * side;
      const y = sample.point.y + sample.normal.y * zigzagHalfWidth * side;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function drawStitchRow(points, length, offset, step, stitchLength) {
    for (let distanceAlong = 0; distanceAlong < length; distanceAlong += step) {
      const start = samplePolylineAt(points, distanceAlong);
      const end = samplePolylineAt(points, Math.min(length, distanceAlong + stitchLength));
      ctx.beginPath();
      ctx.moveTo(
        start.point.x + start.normal.x * offset,
        start.point.y + start.normal.y * offset
      );
      ctx.lineTo(
        end.point.x + end.normal.x * offset,
        end.point.y + end.normal.y * offset
      );
      ctx.stroke();
    }
  }

  function getAnnotationPolyline(ann, samples) {
    if (ann.type === 'straight') return [ann.start, ann.end];
    const points = [];
    for (let i = 0; i <= samples; i += 1) {
      points.push(bezierPoint(ann.start, ann.control1, ann.control2, ann.end, i / samples));
    }
    return points;
  }

  function polylineLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
    return total;
  }

  function samplePolylineAt(points, targetDistance) {
    let walked = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const segLen = distance(a, b);
      if (segLen <= 0) continue;
      if (walked + segLen >= targetDistance) {
        const t = clamp((targetDistance - walked) / segLen, 0, 1);
        const tangent = { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen };
        return {
          point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
          tangent,
          normal: { x: -tangent.y, y: tangent.x },
        };
      }
      walked += segLen;
    }
    const last = points.length - 1;
    const normal = polylineVertexNormal(points, last);
    const prev = points[Math.max(0, last - 1)];
    const len = Math.max(0.0001, distance(prev, points[last]));
    const tangent = {
      x: (points[last].x - prev.x) / len,
      y: (points[last].y - prev.y) / len,
    };
    return { point: points[last], tangent, normal };
  }

  function polylineVertexNormal(points, index) {
    const prev = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const len = Math.max(0.0001, distance(prev, next));
    const tx = (next.x - prev.x) / len;
    const ty = (next.y - prev.y) / len;
    return { x: -ty, y: tx };
  }

  function drawArrowheadsForStraight(ann, color, lineWidth) {
    const arrowType = getArrowType(ann);
    if (arrowType === 'none') return;
    const arrowSize = (10 + lineWidth * 0.55) / state.zoom;
    drawArrowhead(ann.end, Math.atan2(ann.end.y - ann.start.y, ann.end.x - ann.start.x), arrowSize, color);
    if (arrowType === 'double') {
      drawArrowhead(ann.start, Math.atan2(ann.start.y - ann.end.y, ann.start.x - ann.end.x), arrowSize, color);
    }
  }

  function drawArrowheadsForCurve(ann, color, lineWidth) {
    const arrowType = getArrowType(ann);
    if (arrowType === 'none') return;
    const arrowSize = (10 + lineWidth * 0.55) / state.zoom;
    const endAngle = Math.atan2(ann.end.y - ann.control2.y, ann.end.x - ann.control2.x);
    drawArrowhead(ann.end, endAngle, arrowSize, color);
    if (arrowType === 'double') {
      const startAngle = Math.atan2(ann.start.y - ann.control1.y, ann.start.x - ann.control1.x);
      drawArrowhead(ann.start, startAngle, arrowSize, color);
    }
  }

  function drawArrowhead(point, angle, size, color = LINE_COLOR) {
    const spread = Math.PI / 7;
    const wing = size * 0.9;
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(
      point.x - Math.cos(angle - spread) * wing,
      point.y - Math.sin(angle - spread) * wing
    );
    ctx.lineTo(
      point.x - Math.cos(angle + spread) * wing,
      point.y - Math.sin(angle + spread) * wing
    );
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawLabel(pos, text, selected, alpha = 1, color = LINE_COLOR) {
    const fontSize = 17 / state.zoom;
    const halo = 3 / state.zoom;
    // White label fill is invisible on the white canvas — use a dark halo so
    // the callout number still reads when the line color is white.
    const isWhiteFill = String(color || '').toLowerCase() === '#ffffff';
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = '700 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = isWhiteFill ? halo * 1.4 : halo;
    ctx.shadowColor = 'rgba(17,24,39,.18)';
    ctx.shadowBlur = 4 / state.zoom;
    ctx.shadowOffsetY = 1 / state.zoom;
    ctx.strokeStyle = isWhiteFill ? '#111827' : '#ffffff';
    ctx.strokeText(String(text), pos.x, pos.y);
    ctx.fillStyle = color;
    ctx.fillText(String(text), pos.x, pos.y);
    ctx.restore();
  }

  function drawSelectionHelpers(ann) {
    ctx.save();

    if (ann.type === 'curved') {
      ctx.setLineDash([6 / state.zoom, 5 / state.zoom]);
      ctx.strokeStyle = 'rgba(53,109,255,.45)';
      ctx.lineWidth = 1.2 / state.zoom;
      ctx.beginPath();
      ctx.moveTo(ann.start.x, ann.start.y);
      ctx.lineTo(ann.control1.x, ann.control1.y);
      ctx.moveTo(ann.end.x, ann.end.y);
      ctx.lineTo(ann.control2.x, ann.control2.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawHandle(ann.control1, false);
      drawHandle(ann.control2, false);
    }

    drawHandle(ann.start, true);
    drawHandle(ann.end, true);
    drawLabelHandle(ann.label, getAnnotationColor(ann));
    ctx.restore();
  }

  function drawHandle(point, emphasized) {
    const r = (emphasized ? 7.5 : 6.0) / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = emphasized ? SELECT_COLOR : 'rgba(53,109,255,.72)';
    ctx.stroke();
    ctx.restore();
  }

  function drawLabelHandle(point, color = LINE_COLOR) {
    const r = 7 / state.zoom;
    ctx.save();
    ctx.beginPath();
    ctx.arc(point.x, point.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fill();
    ctx.lineWidth = 2 / state.zoom;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.restore();
  }

  function hitTestSelectedHandles(world, ann) {
    // Generous radius for endpoints so resizing a line stays a one-click
    // grab even at low zoom. The visual handle is smaller; this is the
    // forgiving INVISIBLE catch zone around it.
    const endpointRadius = 14 / state.zoom;
    const controlRadius = 11 / state.zoom;
    if (distance(world, ann.start) <= endpointRadius) return { part: 'start' };
    if (distance(world, ann.end) <= endpointRadius) return { part: 'end' };
    if (ann.type === 'curved') {
      if (distance(world, ann.control1) <= controlRadius) return { part: 'control1' };
      if (distance(world, ann.control2) <= controlRadius) return { part: 'control2' };
    }
    if (pointInLabelBounds(world, ann.label, getLabelText(ann), 9 / state.zoom)) return { part: 'label' };
    return null;
  }

  function hitTestAnnotations(world) {
    for (let i = state.annotations.length - 1; i >= 0; i -= 1) {
      const ann = state.annotations[i];
      if (pointInLabelBounds(world, ann.label, getLabelText(ann), 8 / state.zoom)) {
        return { id: ann.id, part: 'label' };
      }
      if (isPointNearAnnotation(world, ann, 8 / state.zoom)) {
        return { id: ann.id, part: 'body' };
      }
    }
    return null;
  }

  function hitTestImages(world) {
    for (let i = state.images.length - 1; i >= 0; i -= 1) {
      const image = state.images[i];
      if (
        world.x >= image.x &&
        world.x <= image.x + image.width &&
        world.y >= image.y &&
        world.y <= image.y + image.height
      ) {
        return { id: image.id };
      }
    }
    return null;
  }

  function hitTestSelectedImageHandles(world, image) {
    const radius = 10 / state.zoom;
    const corners = getImageCorners(image);
    for (const corner of corners) {
      if (distance(world, corner) <= radius) {
        return { corner: corner.name };
      }
    }
    return null;
  }

  function getImageCorners(image) {
    return [
      { name: 'nw', x: image.x, y: image.y },
      { name: 'ne', x: image.x + image.width, y: image.y },
      { name: 'sw', x: image.x, y: image.y + image.height },
      { name: 'se', x: image.x + image.width, y: image.y + image.height },
    ];
  }

  function getOppositeImageCorner(image, corner) {
    if (corner === 'nw') return { x: image.x + image.width, y: image.y + image.height };
    if (corner === 'ne') return { x: image.x, y: image.y + image.height };
    if (corner === 'sw') return { x: image.x + image.width, y: image.y };
    return { x: image.x, y: image.y };
  }

  function resizeImageFromCorner(image, corner, anchor, aspect, world) {
    const MIN_IMAGE_SIZE = 48;
    let localW = 0;
    let localH = 0;

    if (corner === 'nw') {
      localW = anchor.x - world.x;
      localH = anchor.y - world.y;
    } else if (corner === 'ne') {
      localW = world.x - anchor.x;
      localH = anchor.y - world.y;
    } else if (corner === 'sw') {
      localW = anchor.x - world.x;
      localH = world.y - anchor.y;
    } else {
      localW = world.x - anchor.x;
      localH = world.y - anchor.y;
    }

    localW = Math.max(MIN_IMAGE_SIZE, localW);
    localH = Math.max(MIN_IMAGE_SIZE, localH);

    let width = Math.max(localW, localH * aspect);
    let height = width / aspect;

    if (height < MIN_IMAGE_SIZE) {
      height = MIN_IMAGE_SIZE;
      width = height * aspect;
    }

    if (corner === 'nw') {
      image.x = anchor.x - width;
      image.y = anchor.y - height;
    } else if (corner === 'ne') {
      image.x = anchor.x;
      image.y = anchor.y - height;
    } else if (corner === 'sw') {
      image.x = anchor.x - width;
      image.y = anchor.y;
    } else {
      image.x = anchor.x;
      image.y = anchor.y;
    }

    image.width = width;
    image.height = height;
  }

  function pointInLabelBounds(point, labelPos, seq, padding) {
    const fontSize = 17 / state.zoom;
    ctx.save();
    ctx.font = '700 ' + fontSize + 'px system-ui, -apple-system, sans-serif';
    const metrics = ctx.measureText(String(seq));
    ctx.restore();
    const width = Math.max(14 / state.zoom, metrics.width) + padding * 2;
    const height = fontSize + padding * 1.6;
    return (
      point.x >= labelPos.x - width / 2 &&
      point.x <= labelPos.x + width / 2 &&
      point.y >= labelPos.y - height / 2 &&
      point.y <= labelPos.y + height / 2
    );
  }

  function isPointNearAnnotation(point, ann, tolerance) {
    const hitTolerance = Math.max(tolerance, (getLineWidth(ann) / 2 + 6) / state.zoom);
    if (ann.type === 'straight') {
      return pointToSegmentDistance(point, ann.start, ann.end) <= hitTolerance;
    }
    let prev = ann.start;
    for (let i = 1; i <= BEZIER_SAMPLES; i += 1) {
      const t = i / BEZIER_SAMPLES;
      const cur = bezierPoint(ann.start, ann.control1, ann.control2, ann.end, t);
      if (pointToSegmentDistance(point, prev, cur) <= hitTolerance) return true;
      prev = cur;
    }
    return false;
  }

  function bezierPoint(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    const a = mt2 * mt;
    const b = 3 * mt2 * t;
    const c = 3 * mt * t2;
    const d = t * t2;
    return {
      x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
    };
  }

  function bezierTangent(p0, p1, p2, p3, t) {
    const mt = 1 - t;
    return {
      x: 3 * mt * mt * (p1.x - p0.x) + 6 * mt * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
      y: 3 * mt * mt * (p1.y - p0.y) + 6 * mt * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y)
    };
  }

  function pointToSegmentDistance(p, a, b) {
    const l2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    if (l2 === 0) return distance(p, a);
    let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
    t = clamp(t, 0, 1);
    const proj = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    return distance(p, proj);
  }

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
