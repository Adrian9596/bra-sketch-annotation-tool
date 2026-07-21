// Annotation lifecycle helpers: create / delete / clear / copy / paste /
// reflect, plus default-label placement and label-collision nudging.
// Source part for app.js. Run `npm run build` after editing.
//
// createStraightAnnotation and computeDefaultLabelPosition are the
// canonical builders used by the drawing flow and the clipboard. The
// clipboard itself (lineClipboard) is a module-scope template that
// survives undo/redo and is not snapshotted. reflectSelectedAnnotation
// uses the detected view box (when present) to mirror across the local
// front/back column instead of the whole image, so a front-view line
// stays in the front view.

  function createStraightAnnotation(start, end, style, color = 'red', arrowType = 'double', lineWidth = DEFAULT_LINE_WIDTH) {
    const id = state.idCounter++;
    const label = computeDefaultLabelPosition({
      type: 'straight',
      start,
      end,
    });
    return {
      id,
      seq: state.nextSequence,
      type: 'straight',
      style,
      color,
      arrowType,
      lineWidth: normalizeLineWidth(lineWidth),
      start: clonePoint(start),
      end: clonePoint(end),
      control1: null,
      control2: null,
      label,
      labelManual: false,
      text: null,
      value: null,
    };
  }

  function computeDefaultLabelPosition(annLike) {
    if (annLike.type === 'straight') {
      const mid = midpoint(annLike.start, annLike.end);
      const angle = Math.atan2(annLike.end.y - annLike.start.y, annLike.end.x - annLike.start.x);
      const offset = 18 / state.zoom;
      return {
        x: mid.x + Math.cos(angle - Math.PI / 2) * offset,
        y: mid.y + Math.sin(angle - Math.PI / 2) * offset
      };
    }
    // Anchor the label to the middle of the curve. For a two-segment curve
    // that's the middle anchor (tangent = direction between its two handles);
    // otherwise fall back to the single cubic's t=0.5 point.
    let point, tangent;
    if (annLike.midPoint && annLike.midHandleIn && annLike.midHandleOut) {
      point = annLike.midPoint;
      tangent = {
        x: annLike.midHandleOut.x - annLike.midHandleIn.x,
        y: annLike.midHandleOut.y - annLike.midHandleIn.y,
      };
    } else {
      point = bezierPoint(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
      tangent = bezierTangent(annLike.start, annLike.control1, annLike.control2, annLike.end, 0.5);
    }
    const angle = Math.atan2(tangent.y, tangent.x);
    const offset = 20 / state.zoom;
    return {
      x: point.x + Math.cos(angle - Math.PI / 2) * offset,
      y: point.y + Math.sin(angle - Math.PI / 2) * offset
    };
  }

  // Numbered callouts cluster at the bra center-front: POMs 1, 5, 6, 7, 8 all
  // fall in the same vertical strip. Nudge labels apart along each line's
  // perpendicular so the numbers stay readable. Skips manually-placed labels.
  function nudgeAutoLabelsToAvoidCollisions(anns) {
    if (!anns || anns.length < 2) return;
    const items = anns.filter(a => a && a.label && !a.labelManual && a.start && a.end);
    if (items.length < 2) return;
    const minGap = 24 / Math.max(state.zoom || 1, 0.15);
    const perp = items.map((a) => {
      let dx, dy;
      if (a.type === 'curved' && a.control1 && a.control2) {
        const t = bezierTangent(a.start, a.control1, a.control2, a.end, 0.5);
        dx = t.x; dy = t.y;
      } else {
        dx = a.end.x - a.start.x;
        dy = a.end.y - a.start.y;
      }
      const len = Math.hypot(dx, dy) || 1;
      return { x: -dy / len, y: dx / len };
    });
    const labelBox = (ann) => {
      const text = String(getLabelText(ann) || '');
      const width = Math.max(22, text.length * 9 + 14) / Math.max(state.zoom || 1, 0.15);
      const height = 24 / Math.max(state.zoom || 1, 0.15);
      return {
        x1: ann.label.x - width / 2,
        y1: ann.label.y - height / 2,
        x2: ann.label.x + width / 2,
        y2: ann.label.y + height / 2,
      };
    };
    const overlapAmount = (a, b) => {
      const ax = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const ay = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      return ax > 0 && ay > 0 ? Math.min(ax, ay) : 0;
    };
    for (let iter = 0; iter < 36; iter += 1) {
      let moved = false;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const ai = items[i], bj = items[j];
          const a = ai.label, b = bj.label;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          const overlap = overlapAmount(labelBox(ai), labelBox(bj));
          if (d >= minGap && overlap <= 0) continue;
          const step = Math.max(minGap - d, overlap + 2 / Math.max(state.zoom || 1, 0.15)) * 0.55;
          const sameSpot = d < 0.001;
          const sep = sameSpot ? perp[i] : { x: dx / d, y: dy / d };
          const aiDir = {
            x: (perp[i].x * 0.68 + sep.x * 0.32),
            y: (perp[i].y * 0.68 + sep.y * 0.32),
          };
          const bjDir = {
            x: (perp[j].x * 0.68 - sep.x * 0.32),
            y: (perp[j].y * 0.68 - sep.y * 0.32),
          };
          a.x += aiDir.x * step;
          a.y += aiDir.y * step;
          b.x -= bjDir.x * step;
          b.y -= bjDir.y * step;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }

  function deleteSelected() {
    if (state.selection.kind == null) return;

    if (state.selection.kind === 'annotation') {
      const selectedAnn = state.annotations.find(a => a.id === state.selection.id) || null;
      const before = state.annotations.length;
      state.annotations = state.annotations.filter(a => a.id !== state.selection.id);
      if (state.annotations.length === before) return;
      // POM numbers are measurement identities, not list positions. Deleting
      // POM 7 must leave a gap instead of turning POM 8 into POM 7.
      if (selectedAnn && typeof markDeletedAutoAnnotationForEvidence === 'function') {
        markDeletedAutoAnnotationForEvidence(selectedAnn);
      }
      // US-047: deleting a POM line excludes that POM from the exported spec,
      // exactly like the review × Hide toggle (TD: "delete = hide"). The
      // annotation id is gone after this, so remember the POM label; the export
      // drops the row unless a line with that label is later redrawn.
      if (!Array.isArray(state.deletedPomKeys)) state.deletedPomKeys = [];
      if (selectedAnn) {
        const label = String(getLabelText(selectedAnn));
        if (label && !state.deletedPomKeys.includes(label)) state.deletedPomKeys.push(label);
      }
    } else if (state.selection.kind === 'image') {
      const target = getImageById(state.selection.id);
      if (target && target.locked) {
        showToast('Image is locked. Click Unlock first.');
        return;
      }
      const before = state.images.length;
      const deletedId = state.selection.id;
      state.images = state.images.filter(image => image.id !== deletedId);
      if (state.images.length === before) return;
      state.eraseStrokes = state.eraseStrokes.filter(stroke => stroke.imageId !== deletedId);
      // US-052: purge Auto Mode state tied to the removed photo so nothing
      // orphans (anchors/drafts pointing at a gone image, or its aux view). If
      // it was the detection SOURCE, clear the detection; if an aux view, drop
      // just that view. Re-derive the status chip afterward.
      const am = state.autoMode;
      if (am) {
        am.anchors = (am.anchors || []).filter(a => a.sourceImageId !== deletedId);
        am.draftAnnotations = (am.draftAnnotations || []).filter(d => d.sourceImageId !== deletedId);
        if (am.anchorSelectedId != null && !am.anchors.some(a => a.id === am.anchorSelectedId)) am.anchorSelectedId = null;
        if (am.detection) {
          if (am.detection.sourceImageId === deletedId) am.detection = null;
          else if (Array.isArray(am.detection.auxViews)) {
            am.detection.auxViews = am.detection.auxViews.filter(v => v.sourceImageId !== deletedId);
          }
        }
        if (typeof ensureAutoModeStatus === 'function') ensureAutoModeStatus();
      }
    }

    state.selection = { kind: null, id: null };
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  function clearAllAnnotations() {
    if (!state.annotations.length) return;
    state.annotations = [];
    state.deletedAutoAnnotations = [];
    state.deletedPomKeys = [];
    state.nextSequence = 1;
    if (state.selection.kind === 'annotation') {
      state.selection = { kind: null, id: null };
    }
    state.drawSession = null;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
  }

  // Module-scope clipboard — survives undo/redo and isn't snapshotted in
  // history. Paste always builds a fresh annotation off this template.
  let lineClipboard = null;

  function copySelectedAnnotation() {
    if (state.appMode === 'auto') return;
    if (state.selection.kind !== 'annotation') {
      showToast('Select a line to copy first.');
      return;
    }
    const ann = state.annotations.find(a => a.id === state.selection.id);
    if (!ann) return;
    lineClipboard = clone(ann);
    updateUI();
    showToast('Line copied.');
  }

  function pasteLineFromClipboard() {
    if (state.appMode === 'auto') return;
    if (!lineClipboard) {
      showToast('Nothing to paste — copy a line first.');
      return;
    }
    const src = clone(lineClipboard);
    const offset = 20 / state.zoom;
    const shift = (p) => (p ? { x: p.x + offset, y: p.y + offset } : null);
    const start = shift(src.start);
    const end = shift(src.end);
    const isCurved = src.type === 'curved';
    const midPoint = isCurved ? shift(src.midPoint) : null;
    const midHandleIn = isCurved ? shift(src.midHandleIn) : null;
    const midHandleOut = isCurved ? shift(src.midHandleOut) : null;
    const control1 = isCurved ? shift(src.control1) : null;
    const control2 = isCurved ? shift(src.control2) : null;
    const ann = {
      id: state.idCounter++,
      seq: state.nextSequence,
      type: src.type,
      style: src.style,
      color: src.color,
      arrowType: src.arrowType,
      lineWidth: src.lineWidth,
      start,
      end,
      midPoint,
      midHandleIn,
      midHandleOut,
      control1,
      control2,
      label: computeDefaultLabelPosition({ type: src.type, start, end, control1, control2, midPoint, midHandleIn, midHandleOut }),
      labelManual: false,
      text: src.text || null,
      value: null,
    };
    if (isCurved) ensureCurveControls(ann);
    state.annotations.push(ann);
    state.selection = { kind: 'annotation', id: ann.id };
    state.nextSequence += 1;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Line pasted.');
  }

  function reflectSelectedAnnotation() {
    if (state.appMode === 'auto') return;
    if (state.selection.kind !== 'annotation') {
      showToast('Select a line to reflect first.');
      return;
    }
    const src = state.annotations.find(a => a.id === state.selection.id);
    if (!src) return;
    const axisX = findReflectionAxisX(src);
    if (axisX == null) {
      showToast('Place the line over an image to reflect.');
      return;
    }
    const mirror = (p) => (p ? { x: 2 * axisX - p.x, y: p.y } : null);
    const ann = {
      ...clone(src),
      id: state.idCounter++,
      seq: state.nextSequence,
      start: mirror(src.start),
      end: mirror(src.end),
      control1: mirror(src.control1),
      control2: mirror(src.control2),
      midPoint: mirror(src.midPoint),
      midHandleIn: mirror(src.midHandleIn),
      midHandleOut: mirror(src.midHandleOut),
      label: mirror(src.label),
      value: null,
    };
    // Mirroring is exact, so every handle carries over and the curve keeps its
    // shape; backfill the anchor set for any older single-cubic source.
    ensureCurveControls(ann);
    state.annotations.push(ann);
    state.selection = { kind: 'annotation', id: ann.id };
    state.nextSequence += 1;
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast('Reflected copy added.');
  }

  // Pick the vertical axis to mirror across: prefer the detected view box
  // containing the line so a front-view line stays in the front view; fall
  // back to the containing image's horizontal centre.
  function findReflectionAxisX(ann) {
    if (!ann || !ann.start || !ann.end) return null;
    const midX = (ann.start.x + ann.end.x) / 2;
    const midY = (ann.start.y + ann.end.y) / 2;
    let image = ann.sourceImageId ? getImageById(ann.sourceImageId) : null;
    if (!image) {
      image = state.images.find(img =>
        midX >= img.x && midX <= img.x + img.width &&
        midY >= img.y && midY <= img.y + img.height) || null;
    }
    if (!image || !image.width) return null;
    const det = state.autoMode && state.autoMode.detection;
    if (det && det.sourceImageId === image.id && Array.isArray(det.viewBoxes) && det.viewBoxes.length) {
      const nx = (midX - image.x) / image.width;
      const ny = (midY - image.y) / Math.max(1, image.height);
      let best = null;
      let bestArea = Infinity;
      for (const b of det.viewBoxes) {
        if (!b) continue;
        if (nx >= b.x && nx <= b.x + b.width && ny >= b.y && ny <= b.y + b.height) {
          const area = b.width * b.height;
          if (area < bestArea) { bestArea = area; best = b; }
        }
      }
      if (best) return image.x + (best.x + best.width / 2) * image.width;
    }
    return image.x + image.width / 2;
  }

  function hasLineClipboard() {
    return lineClipboard != null;
  }
