// Auto Mode overlay rendering: draft annotation drawing, detection
// bounding boxes / axes / view boxes, and the draggable anchor pins.
// Source part for app.js. Run `npm run build` after editing.
//
// drawAutoDraftAnnotation renders a Auto Mode draft with a halo + reduced
// alpha so the TD can distinguish it from committed work. drawAnchors
// draws the per-anchor pins; anchorLabelOffsetX/Y bias the pin label so
// labels don't pile on top of the anchor or sketch features.

  function drawAutoDraftAnnotation(ann, withLabel = true) {
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

    if (withLabel) drawAutoDraftLabel(ann);
    ctx.restore();
  }

  // Draft POM number, drawn in the label pass (after all lines + anchors) so it
  // is never covered by a later draft line or an anchor — see render().
  function drawAutoDraftLabel(ann) {
    if (isReviewOnlyDraft(ann)) return;
    if (!ann.start || !ann.end) return;
    if (!labelsVisible() || !ann.label) return;
    const isSelected = state.selection.kind === 'draft' && state.selection.id === ann.id;
    drawLabel(ann.label, getLabelText(ann), isSelected, 1, getAnnotationColor(ann));
  }

  function hitTestAutoDraftAnnotations(world) {
    const drafts = state.autoMode.draftAnnotations;
    for (let i = drafts.length - 1; i >= 0; i -= 1) {
      const ann = drafts[i];
      if (isReviewOnlyDraft(ann)) continue;
      if (isDraftHidden(ann.id)) continue;
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

    // View boxes — labeled FRONT / BACK / FRONT INNER by role so the TD can see
    // what the detector decided. Two sources feed this: the detector's
    // per-view split of the ONE source image (viewBoxes), and any AUXILIARY
    // views recognized on EXTRA board photos (auxViews, US-039). Aux views are
    // recognition-only — no POM is placed on them (ADR 0011) — and render
    // against their OWN image. All coordinates are normalized [0,1] to their
    // image, so boxes survive pans, zooms, and image resizes.
    const VIEW_STYLE = {
      front_outer: { stroke: 'rgba(14, 165, 233, 0.85)', fill: 'rgba(14, 165, 233, 0.95)', dash: [], lineW: 1.4 },
      front_inner: { stroke: 'rgba(22, 163, 74, 0.85)', fill: 'rgba(22, 163, 74, 0.95)', dash: [], lineW: 1.4 },
      front:       { stroke: 'rgba(14, 165, 233, 0.85)', fill: 'rgba(14, 165, 233, 0.95)', dash: [], lineW: 1.4 },
      back:        { stroke: 'rgba(168, 85, 247, 0.85)', fill: 'rgba(168, 85, 247, 0.95)', dash: [], lineW: 1.4 },
      unknown:     { stroke: 'rgba(100, 116, 139, 0.45)', fill: 'rgba(100, 116, 139, 0.85)', dash: [3, 3], lineW: 0.9 },
      none:        { stroke: 'rgba(100, 116, 139, 0.45)', fill: 'rgba(100, 116, 139, 0.85)', dash: [3, 3], lineW: 0.9 },
    };
    const paintViewBox = (img, view, role, labelFallback) => {
      const vx = img.x + view.x * img.width;
      const vy = img.y + view.y * img.height;
      const vw = view.width * img.width;
      const vh = view.height * img.height;
      const style = VIEW_STYLE[role] || VIEW_STYLE.none;
      const label = role && role !== 'unknown'
        ? role.replace('_', ' ').toUpperCase()
        : labelFallback;
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
    };

    // Per-view split of the source image (only when >1 view was found).
    if (Array.isArray(detection.viewBoxes) && detection.viewBoxes.length > 1) {
      detection.viewBoxes.forEach((view, index) => {
        if (!view) return;
        const role = view.viewRole || view.role || (index === (detection.primaryViewIndex || 0) ? 'front_outer' : 'unknown');
        paintViewBox(image, view, role, 'view ' + (index + 1));
      });
    }

    // Auxiliary views recognized on extra board photos (e.g. a front-inner
    // cutaway added as its own image). Drawn against their own image.
    if (Array.isArray(detection.auxViews)) {
      detection.auxViews.forEach((view) => {
        if (!view) return;
        const auxImg = getImageById(view.sourceImageId);
        if (!auxImg || !auxImg.img) return;
        paintViewBox(auxImg, view, view.viewRole || 'unknown', 'view ?');
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

    // Junction / endpoint / corner map (Phase 1, plan 2) — debug-only.
    // Enable from the console with `__braDebug.junctions = true`.
    // junction = circle, endpoint = square, corner = triangle.
    const braDebug = (typeof window !== 'undefined' && window.__braDebug) || null;
    if (braDebug && braDebug.junctions && Array.isArray(detection.junctions)) {
      const r = 3.2 * px;
      for (const p of detection.junctions) {
        const jx = image.x + p.x * image.width;
        const jy = image.y + p.y * image.height;
        const alpha = 0.35 + 0.6 * Math.min(1, p.confidence || 0);
        ctx.lineWidth = 1.1 * px;
        if (p.type === 'junction') {
          ctx.strokeStyle = 'rgba(22, 163, 74, ' + alpha.toFixed(2) + ')';
          ctx.fillStyle = 'rgba(22, 163, 74, 0.18)';
          ctx.beginPath();
          ctx.arc(jx, jy, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        } else if (p.type === 'endpoint') {
          ctx.strokeStyle = 'rgba(2, 132, 199, ' + alpha.toFixed(2) + ')';
          ctx.fillStyle = 'rgba(2, 132, 199, 0.18)';
          ctx.beginPath();
          ctx.rect(jx - r, jy - r, r * 2, r * 2);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.strokeStyle = 'rgba(234, 88, 12, ' + alpha.toFixed(2) + ')';
          ctx.fillStyle = 'rgba(234, 88, 12, 0.18)';
          ctx.beginPath();
          ctx.moveTo(jx, jy - r);
          ctx.lineTo(jx + r, jy + r);
          ctx.lineTo(jx - r, jy + r);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
      if (detection.junctionSummary) {
        const s = detection.junctionSummary;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.font = (10 * px).toFixed(1) + 'px system-ui, sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillText(
          'junctions ' + s.junctions + ' • endpoints ' + s.endpoints + ' • corners ' + s.corners,
          bx + 4 * px, by + bh + 4 * px
        );
      }
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
    if (!anchors.length || state.autoMode.anchorsHidden) return;
    const z = Math.max(state.zoom, 0.1);
    const radius = 6 / z;            // 6px screen radius
    const hitRadius = 9 / z;          // matches hitTestAnchors
    const ringWidth = 1.6 / z;
    const labelFont = (10.5 / z).toFixed(2) + 'px system-ui, sans-serif';

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const anchor of anchors) {
      if (isAnchorHidden(anchor.kind)) continue; // US-038: per-anchor hide
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

      // Derived anchors that still follow the cascade get a dashed outer
      // ring so the TD can tell "this one moves by itself" from a normal
      // pin. The ring disappears once the anchor is pinned by a direct drag.
      if (!anchor.derivedPinned
          && typeof anchorDerivationForKind === 'function'
          && anchorDerivationForKind(anchor.kind)) {
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
        ctx.lineWidth = 1 / z;
        ctx.setLineDash([3 / z, 2.5 / z]);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius + 3.5 / z, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

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

  // U1b: magnifier loupe while an anchor is being corrected (mouse drag or
  // keyboard nudge). A circular inset beside the pin shows the sketch at 4×
  // the current view scale with a crosshair on the anchor position, so the
  // TD can aim roughly and confirm in the loupe instead of zooming the
  // whole board. During a drag it also marks where snap-to-ink would land.
  function drawAnchorLoupe() {
    if (state.appMode !== 'auto' || state.autoMode.anchorsHidden) return;
    const dragging = state.interaction && state.interaction.type === 'drag-anchor';
    const anchorId = dragging ? state.interaction.id : activeNudgeAnchorId();
    if (anchorId == null) return;
    const anchor = getAnchorById(anchorId);
    if (!anchor) return;
    const image = getImageById(anchor.sourceImageId);
    if (!image || !image.img || !image.width || !image.height) return;
    const pos = anchorWorldPos(anchor);
    if (!pos) return;

    const z = Math.max(state.zoom, 0.1);
    const r = 60 / z;        // 120 screen-px diameter
    const mag = 4;           // magnification relative to the current view
    const gap = 84 / z;      // pin → loupe-center distance

    // Keep the loupe on-screen: flip left of the pin near the right edge,
    // below the pin near the top edge.
    const screen = worldToScreen(pos.x, pos.y);
    const rect = getViewportRect();
    const margin = 84 + 60;  // gap + radius, in screen px
    const cx = pos.x + (screen.x + margin > rect.width ? -gap : gap);
    const cy = pos.y + (screen.y - margin < 0 ? gap : -gap);

    ctx.save();

    // White backing disc so transparent/overexposed sketch areas stay readable.
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Magnified sketch, clipped to the disc: scale the board about the
    // anchor position and re-center on the loupe.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.translate(cx, cy);
    ctx.scale(mag, mag);
    ctx.translate(-pos.x, -pos.y);
    ctx.drawImage(image.img, image.x, image.y, image.width, image.height);
    ctx.restore();

    // Snap-to-ink preview (drag only — the keyboard nudge never snaps).
    if (dragging) {
      const snapped = snapAnchorToInk(anchor);
      if (snapped) {
        const sx = cx + (snapped.x - anchor.x) * image.width * mag;
        const sy = cy + (snapped.y - anchor.y) * image.height * mag;
        if (Math.hypot(sx - cx, sy - cy) < r - 4 / z) {
          ctx.fillStyle = 'rgba(22, 163, 74, 0.9)';
          ctx.beginPath();
          ctx.arc(sx, sy, 3 / z, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Crosshair marking the anchor's exact position.
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.lineWidth = 1 / z;
    ctx.beginPath();
    ctx.moveTo(cx - 9 / z, cy);
    ctx.lineTo(cx + 9 / z, cy);
    ctx.moveTo(cx, cy - 9 / z);
    ctx.lineTo(cx, cy + 9 / z);
    ctx.stroke();

    // Border ring.
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2 / z;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

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
