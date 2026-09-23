// Auto Mode draft line rendering + its dedicated label pass + hit-testing,
// and the draggable anchor pins (what a TD actually drags to correct
// detection). Source part for app.js. Run `npm run build` after editing.
//
// drawAutoDraftAnnotation renders a Auto Mode draft with a halo + reduced
// alpha so the TD can distinguish it from committed work. drawAnchors
// draws the per-anchor pins; anchorLabelOffsetX/Y bias the pin label so
// labels don't pile on top of the anchor or sketch features. The read-only
// detection diagnostic overlay (bbox/axis/band/cradle/etc.) lives in the
// sibling detection-overlay.js.
//
// hitTestAutoDraftAnnotations is called from src/manual/interactions.js,
// so this file must still load before that interaction file.

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
