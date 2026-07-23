// PDF export pipeline: build an A4 page snapshot of the board and
// emit a single-page PDF blob without any external dependencies.
// Source part for app.js. Run `npm run build` after editing.
//
// exportPdf orchestrates: createExportCanvas redirects the global ctx onto
// a high-DPI temp canvas, drawAnnotationForExport draws each annotation at
// full alpha, then dataURLToUint8Array + makeSinglePagePdfBlob assemble a
// PDF 1.4 byte stream that downloadBlob hands off to the browser.

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

// Applied annotations minus the ones the TD hid via the row × toggle. Every
// export image path (PDF, Copy Image, Excel embedded PNG) renders and crops
// from this, so a hidden POM's line + label is dropped from exports and no
// longer pads the frame — matching the live canvas (render-loop.js) and the
// Excel table (export-xlsx.js). Drafts are never exported, so only isAnnHidden
// applies here.
function visibleExportAnnotations() {
  return state.annotations.filter(ann => !isAnnHidden(ann.id));
}

function getContentBounds() {
  const boxes = [];
  for (const image of state.images) boxes.push(getImageBounds(image));
  for (const ann of visibleExportAnnotations()) boxes.push(getAnnotationBounds(ann));
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
    for (const s of getCurveBeziers(ann)) {
      points.push(s.p1, s.p2);
      for (let i = 0; i <= BEZIER_SAMPLES; i += 1) points.push(bezierPoint(s.p0, s.p1, s.p2, s.p3, i / BEZIER_SAMPLES));
    }
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
  // 300 DPI (print standard). At the old 150 DPI the A4 page held too few
  // pixels, so a photo fit to the page rendered below its native resolution and
  // looked soft; 300 DPI lets a single/dual-photo board render at (or above)
  // native. Doubling DPI quadruples the JPEG pixels — still well within a
  // single-page PDF budget at quality 0.94.
  const mmToPx = 300 / 25.4;
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
  exportCtx.imageSmoothingEnabled = true;
  exportCtx.imageSmoothingQuality = 'high';
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
  for (const ann of visibleExportAnnotations()) drawAnnotationForExport(ann);
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
