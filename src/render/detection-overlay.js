// Auto Mode detection overlay: the read-only diagnostic layer showing the
// detector's bbox, axis, band, chest, cradle, side seams, apex points,
// strap/back-center markers, corner labels, an optional junction/endpoint
// debug layer, and the quality badge. Source part for app.js. Run
// `npm run build` after editing.
//
// drawDetectionOverlay draws all of it in one pass, anchored to its source
// image via normalized [0,1] detection coordinates so it survives pans,
// zooms, and image resizes. Draft-line rendering and the draggable anchor
// pins (what a TD actually drags) live in the sibling anchor-pins.js.

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
