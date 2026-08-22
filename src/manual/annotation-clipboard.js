// Line clipboard feature: copy / paste / reflect(mirror) a line, plus the
// module-scope lineClipboard template that deliberately survives undo/redo
// and is not snapshotted in history. reflectSelectedAnnotation uses the
// detected view box (when present) to mirror across the local front/back
// column instead of the whole image, so a front-view line stays in the front
// view. Must load after src/manual/annotation-factory.js (uses
// computeDefaultLabelPosition). Sibling files: annotation builders live in
// src/manual/annotation-factory.js; label-collision nudging lives in
// src/manual/label-layout.js; delete/clear lifecycle lives in
// src/manual/annotation-lifecycle.js.
// Source part for app.js. Run `npm run build` after editing.

  // Module-scope clipboard — survives undo/redo and isn't snapshotted in
  // history. Paste always builds a fresh annotation off this template.
  let lineClipboard = null;

  function copySelectedAnnotation() {
    if (state.appMode === 'auto') return;
    const anns = getSelectedAnnotations();
    if (!anns.length) {
      showToast('Select a line to copy first.');
      return;
    }
    lineClipboard = anns.map(clone);
    // Claim the OS clipboard (best-effort) so a photo copied EARLIER no
    // longer shadows this line copy on paste: onPasteEvent pastes an OS
    // image when present, otherwise the internal line clipboard — writing
    // this marker text replaces any stale image, so "last copy wins".
    if (navigator.clipboard && navigator.clipboard.writeText) {
      const marker = anns.length > 1 ? '[Bra Auto Measure] ' + anns.length + ' POM lines copied' : '[Bra Auto Measure] POM line copied';
      navigator.clipboard.writeText(marker).catch(() => {});
    }
    updateUI();
    showToast(anns.length > 1 ? anns.length + ' lines copied.' : 'Line copied.');
  }

  function pasteLineFromClipboard() {
    if (state.appMode === 'auto') return;
    const clips = Array.isArray(lineClipboard) ? lineClipboard : (lineClipboard ? [lineClipboard] : []);
    if (!clips.length) {
      showToast('Nothing to paste — copy a line first.');
      return;
    }
    const offset = 20 / state.zoom;
    const shift = (p) => (p ? { x: p.x + offset, y: p.y + offset } : null);
    const pastedIds = [];
    for (const clip of clips) {
      const src = clone(clip);
      const isCurved = src.type === 'curved';
      const start = shift(src.start);
      const end = shift(src.end);
      const midPoint = isCurved ? shift(src.midPoint) : null;
      const midHandleIn = isCurved ? shift(src.midHandleIn) : null;
      const midHandleOut = isCurved ? shift(src.midHandleOut) : null;
      const control1 = isCurved ? shift(src.control1) : null;
      const control2 = isCurved ? shift(src.control2) : null;
      // US-093: shift every interior anchor's point + both handles by the
      // same paste offset as everything else.
      const points = isCurved && Array.isArray(src.points)
        ? src.points.map(pt => ({ point: shift(pt.point), handleIn: shift(pt.handleIn), handleOut: shift(pt.handleOut) }))
        : [];
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
        points,
        // Derived below, once the geometry is normalized — see the note under
        // ensureCurveControls. Declared here so the key order of a pasted
        // annotation stays identical to every other annotation record.
        label: null,
        labelManual: false,
        text: src.text || null,
        value: null,
      };
      if (isCurved) ensureCurveControls(ann);
      // US-093 / ADR 0053 code review, 2026-08-21: derive the label AFTER
      // normalization rather than inside the literal above. For a curve with
      // interior anchors computeDefaultLabelPosition (annotation-factory.js)
      // now takes the half-arc-length point, which walks getCurveBeziers and
      // therefore reads control1/control2 — the very fields
      // ensureCurveControls exists to supply. Normalize, then derive.
      //
      // This does not change any reachable paste: lineClipboard is written
      // only from getSelectedAnnotations, every route into state.annotations
      // already runs ensureCurveControls (project-load.js, history.js,
      // apply-drafts.js, and both paths here), and the OS-clipboard marker
      // text copySelectedAnnotation writes is never read back — onPasteEvent
      // takes only image/* items, so no foreign text can become a clip. On a
      // normalized clip ensureCurveControls is a no-op and the label is
      // byte-identical to before. Passing the whole annotation also matches
      // handleAddPointClick (canvas-tools.js), the other caller.
      //
      // It is not a blanket guard, and should not be read as one: a clip
      // missing start or end makes ensureCurveControls return early, and
      // computeDefaultLabelPosition then throws on it exactly as it did
      // before interior anchors existed.
      ann.label = computeDefaultLabelPosition(ann);
      state.annotations.push(ann);
      state.nextSequence += 1;
      pastedIds.push(ann.id);
    }
    // Select the pasted group so it can be moved/nudged as one immediately.
    state.selectedAnnotationIds = pastedIds;
    state.selection = { kind: 'annotation', id: pastedIds[pastedIds.length - 1] };
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(pastedIds.length > 1 ? pastedIds.length + ' lines pasted.' : 'Line pasted.');
  }

  function reflectSelectedAnnotation() {
    if (state.appMode === 'auto') return;
    const srcs = getSelectedAnnotations();
    if (!srcs.length) {
      showToast('Select a line to reflect first.');
      return;
    }
    const reflectedIds = [];
    let skipped = 0;
    for (const src of srcs) {
      // Each line mirrors across ITS OWN view-box / image axis, so a group that
      // spans front + back reflects correctly per panel.
      const axisX = findReflectionAxisX(src);
      if (axisX == null) { skipped += 1; continue; }
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
        // US-093: mirror every interior anchor the same exact way as every
        // other curve field — the spread above would otherwise carry the
        // UNMIRRORED clone through untouched.
        points: (Array.isArray(src.points) ? src.points : []).map(pt => ({
          point: mirror(pt.point), handleIn: mirror(pt.handleIn), handleOut: mirror(pt.handleOut),
        })),
        label: mirror(src.label),
        value: null,
      };
      // Mirroring is exact, so every handle carries over and the curve keeps its
      // shape; backfill the anchor set for any older single-cubic source.
      ensureCurveControls(ann);
      state.annotations.push(ann);
      state.nextSequence += 1;
      reflectedIds.push(ann.id);
    }
    if (!reflectedIds.length) {
      showToast('Place the line over an image to reflect.');
      return;
    }
    state.selectedAnnotationIds = reflectedIds;
    state.selection = { kind: 'annotation', id: reflectedIds[reflectedIds.length - 1] };
    pushHistoryIfChanged();
    updateUI();
    requestRender();
    const base = reflectedIds.length > 1 ? reflectedIds.length + ' reflected copies added.' : 'Reflected copy added.';
    showToast(skipped ? base + ' (' + skipped + ' skipped — not over an image)' : base);
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
    return Array.isArray(lineClipboard) ? lineClipboard.length > 0 : lineClipboard != null;
  }
