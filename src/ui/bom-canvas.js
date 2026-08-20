// BOM page — Material Key leader-line canvas engine: callout lookup,
// geometry, hit-testing, placement/drag, drawing, the offscreen render the
// tech-pack Excel export reuses (bmRenderMatkeyToCanvas), and the canvas
// pointer handlers (US-072, ADR 0041). Source part for app.js. Run
// `npm run build` after editing. Loads after bom-state.js and
// bom-images.js; bom-table.js's renderBom drives it.
//
// This is the deliberate bm*-prefixed fork of construction-canvas.js —
// keeping the two filenames parallel is the point: it makes "diff the two
// forks for drift" a one-file comparison. It is NOT an invitation to merge
// them (see the callout note below).
//
// A callout is { id, rowId, imageId, variant, targets:[{nx,ny}, ...],
// textPos:{nx,ny} } — the "material key" annotation, placed on a BOM-owned
// image for that variant. It deliberately reuses Construction's exact
// multi-anchor/edge-leader-line/arrowhead/double-click-delete geometry,
// forked (not shared) under a bm* prefix, per this codebase's
// duplicate-over-premature-abstraction convention — there is no existing
// shared leader-line module to extract into. A callout's label text is
// derived live from its linked row's current number + description
// (`N. {description}`), never stored, matching how BOM row numbers are
// computed.

  /* ---- Material-key annotation engine (forked from construction.js) ------ */

  function bmVisibleCallouts() {
    const callouts = (state.bom && state.bom.callouts) || [];
    return callouts.filter(c => (c.variant || 'solid') === bmVariant);
  }

  function bmSelectedCallout() {
    return bmVisibleCallouts().find(c => c.id === bmSelectedCalloutId) || null;
  }

  function bmCalloutForRow(rowId, variant) {
    const key = bmVariantKey(variant);
    return (((state.bom && state.bom.callouts) || []).find(c =>
      c.rowId === rowId && bmVariantKey(c.variant) === key)) || null;
  }

  function bmMissingCalloutRows(variant) {
    const key = bmVariantKey(variant);
    return bmNumberedRows(key).map(x => x.row)
      .filter(row => !bmCalloutForRow(row.id, key));
  }

  function bmNextMissingCalloutRow(afterRowId, variant) {
    const key = bmVariantKey(variant);
    const ordered = bmNumberedRows(key).map(x => x.row);
    if (!ordered.length) return null;
    const start = Math.max(-1, ordered.findIndex(row => row.id === afterRowId));
    for (let step = 1; step <= ordered.length; step += 1) {
      const row = ordered[(start + step) % ordered.length];
      if (!bmCalloutForRow(row.id, key)) return row;
    }
    return null;
  }

  function bmWorldOf(imageRec, norm) {
    return { x: imageRec.x + norm.nx * imageRec.width, y: imageRec.y + norm.ny * imageRec.height };
  }

  function bmNormalize(imageRec, pt) {
    return { nx: (pt.x - imageRec.x) / imageRec.width, ny: (pt.y - imageRec.y) / imageRec.height };
  }

  function bmWorldToCanvas(pt) {
    return { x: pt.x * bmCanvasView.scale + bmCanvasView.offX, y: pt.y * bmCanvasView.scale + bmCanvasView.offY };
  }

  function bmCanvasPointFromEvent(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { x: (cx - bmCanvasView.offX) / bmCanvasView.scale, y: (cy - bmCanvasView.offY) / bmCanvasView.scale };
  }

  function bmImageAt(pt) {
    const images = bmVariantImages();
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const im = images[i];
      if (pt.x >= im.x && pt.x <= im.x + im.width && pt.y >= im.y && pt.y <= im.y + im.height) return im;
    }
    return null;
  }

  // Hit-tests every leader-line anchor (not just the first) before falling
  // back to the label box, so a double-click on a secondary arrowhead can
  // remove just that leader line.
  function bmHitTest(pt) {
    const callouts = bmVisibleCallouts();
    const rWorld = BM_HIT_RADIUS / bmCanvasView.scale;
    const halfW = BM_LABEL_HALF_W / bmCanvasView.scale;
    const halfH = BM_LABEL_HALF_H / bmCanvasView.scale;
    for (let i = callouts.length - 1; i >= 0; i -= 1) {
      const c = callouts[i];
      const im = bmImageById(c.imageId);
      if (!im) continue;
      const targets = c.targets || [];
      for (let ti = targets.length - 1; ti >= 0; ti -= 1) {
        const pin = bmWorldOf(im, targets[ti]);
        if (Math.hypot(pt.x - pin.x, pt.y - pin.y) <= rWorld) {
          return { callout: c, part: 'anchor', anchorIndex: ti, imageRec: im };
        }
      }
      const label = bmWorldOf(im, c.textPos);
      if (Math.abs(pt.x - label.x) <= halfW && Math.abs(pt.y - label.y) <= halfH) {
        return { callout: c, part: 'label', imageRec: im };
      }
      for (let ti = targets.length - 1; ti >= 0; ti -= 1) {
        const pin = bmWorldOf(im, targets[ti]);
        if (bmDistanceToSegment(pt, label, pin) <= (6 / bmCanvasView.scale)) {
          return { callout: c, part: 'line', anchorIndex: ti, imageRec: im };
        }
      }
    }
    return null;
  }

  function bmDistanceToSegment(pt, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return Math.hypot(pt.x - a.x, pt.y - a.y);
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
  }

  function bmCreateCalloutAt(pt) {
    const im = bmImageAt(pt);
    if (!im) { showToast('Click on a sketch image to place a material-key callout'); return; }
    const rows = bmMissingCalloutRows(bmVariant);
    if (!rows.length) {
      bmSetTool('select');
      showToast('Every visible BOM row already has a callout');
      return;
    }
    const bom = ensureBom();
    const target = bmNormalize(im, pt);
    const rowId = (bmSelectedRowId && rows.some(r => r.id === bmSelectedRowId)) ? bmSelectedRowId : rows[0].id;
    // Start the label on the roomier side of the target and keep its baseline
    // inside the image. Drawing then connects every leader from the nearest
    // edge of the label box, so TDs rarely need a cleanup drag after placement.
    const textPos = {
      nx: clamp(target.nx + (target.nx > 0.65 ? -0.28 : 0.08), 0.02, 0.90),
      ny: clamp(target.ny - 0.03, 0.04, 0.96),
    };
    const callout = {
      id: state.idCounter++,
      rowId,
      imageId: im.id,
      variant: bmVariant,
      targets: [target],
      textPos,
    };
    bom.callouts.push(callout);
    const next = bmNextMissingCalloutRow(rowId, bmVariant);
    if (next) {
      bmSelectedRowId = next.id;
      bmSelectedCalloutId = null;
    } else {
      bmSelectedRowId = rowId;
      bmSelectedCalloutId = callout.id;
      bmTool = 'select';
    }
    renderBom();
    pushHistoryIfChanged();
    showToast(next
      ? 'Callout added · next row ' + (bmRowSeq(next.id, bmVariant) || '') + '. ' + bmShortLabel(next.cells.description || '(empty)')
      : 'All visible BOM rows now have callouts · Select is active');
  }

  // Add Leaders is a persistent tool: every valid click adds one image-local
  // target to the selected callout until Select or Escape ends the mode.
  function bmAddArrowAt(pt) {
    const c = bmSelectedCallout();
    if (!c) { showToast('Select a callout first'); return; }
    const im = bmImageById(c.imageId);
    if (!im) return;
    if (bmImageAt(pt) !== im) {
      showToast('Add the leader inside the selected callout\'s own image');
      return;
    }
    c.targets.push(bmNormalize(im, pt));
    renderBom();
    pushHistoryIfChanged();
    showToast('Leader ' + c.targets.length + ' added · click again, or Select/Esc to finish');
  }

  // Double-clicking an arrowhead removes just that leader line. A callout
  // must keep at least one — deleting the last one is a no-op (use Delete
  // callout to remove it entirely), matching Construction's convention.
  function bmDeleteAnchorAt(pt) {
    const hit = bmHitTest(pt);
    if (!hit || hit.part !== 'anchor') return;
    if (hit.callout.targets.length <= 1) {
      showToast('A callout needs at least one arrow — use Delete callout to remove it entirely');
      return;
    }
    hit.callout.targets.splice(hit.anchorIndex, 1);
    renderBom();
    pushHistoryIfChanged();
  }

  // Reference ⊕ (data-mk): jump straight to the Material Key armed for THIS
  // row — the next sketch click drops its numbered callout. If the row
  // prints on a single sheet, follow it onto that variant first, so the
  // callout lands on (and stays filtered to) the row's own sheet.
  function bmArmRowCallout(rowId) {
    const row = bmRowById(rowId);
    if (!row) return;
    const scope = row.scope || 'BOTH';
    if (scope !== 'BOTH' && scope.toLowerCase() !== bmVariant) {
      bmVariant = scope.toLowerCase();
      bmSyncVariantTabs();
    }
    bmSelectedRowId = rowId;
    const existing = bmCalloutForRow(rowId, bmVariant);
    if (existing) {
      bmSelectedCalloutId = existing.id;
      bmSelectedImageId = null;
      bmSetTool('select');
    } else {
      bmSelectedCalloutId = null;
      bmSelectedImageId = null;
      bmSetTool('callout');
    }
    renderBom();
    const mkView = document.getElementById('bomMatkeyView');
    if (mkView) mkView.scrollIntoView({ block: 'start' });
    showToast(existing
      ? 'Selected the existing callout for row ' + (bmRowSeq(rowId, bmVariant) || '')
      : 'Click the sketch to place the callout for row ' + (bmRowSeq(rowId, bmVariant) || ''));
  }

  function bmDeleteSelectedCallout() {
    const c = bmSelectedCallout();
    if (!c) return;
    const callouts = state.bom.callouts;
    const idx = callouts.indexOf(c);
    if (idx === -1) return;
    callouts.splice(idx, 1);
    bmSelectedCalloutId = null;
    if (bmTool === 'leader') bmTool = 'select';
    renderBom();
    pushHistoryIfChanged();
    showToast('Deleted callout · Ctrl/Cmd+Z to undo');
  }

  // Reference shortLabel(): first comma-clause of the description, 40 chars.
  function bmShortLabel(d) {
    return String(d || '').split(',')[0].replace(/ -- /g, ' – ').slice(0, 40);
  }

  function bmCalloutLabelText(c) {
    const row = bmRowById(c.rowId);
    if (!row) return '? deleted BOM row';
    const base = bmRowBase(c.rowId, bmVariant);
    return (base || '?') + '. ' + (bmShortLabel(row.cells.description) || '(empty)');
  }

  function bmSetTool(tool) {
    if (tool !== 'select' && tool !== 'callout' && tool !== 'leader') tool = 'select';
    if (tool === 'leader' && !bmSelectedCallout()) {
      showToast('Select a callout before adding leaders');
      tool = 'select';
    }
    bmTool = tool;
    bmSyncToolUi();
  }

  function bmStartCalloutTool(preferredRowId) {
    const missing = bmMissingCalloutRows(bmVariant);
    if (!missing.length) {
      bmSetTool('select');
      showToast('Every visible BOM row already has a callout');
      return;
    }
    const preferred = missing.find(row => row.id === preferredRowId)
      || missing.find(row => row.id === bmSelectedRowId)
      || missing[0];
    bmSelectedRowId = preferred.id;
    bmSelectedCalloutId = null;
    bmSelectedImageId = null;
    bmSetTool('callout');
    renderBom();
    showToast('Add Callouts · place row ' + (bmRowSeq(preferred.id, bmVariant) || '')
      + '. ' + bmShortLabel(preferred.cells.description || '(empty)'));
  }

  function bmSyncToolUi() {
    const tools = {
      select: document.getElementById('bomSelectToolBtn'),
      callout: document.getElementById('bomAddCalloutBtn'),
      leader: document.getElementById('bomAddArrowBtn'),
    };
    Object.keys(tools).forEach(tool => {
      const btn = tools[tool];
      if (!btn) return;
      const active = bmTool === tool;
      btn.classList.toggle('bm-tool-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    if (tools.leader) tools.leader.disabled = !bmSelectedCallout();
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (canvas) {
      canvas.classList.remove('bm-tool-select', 'bm-tool-callout', 'bm-tool-leader');
      canvas.classList.add('bm-tool-' + bmTool);
    }
    const hint = document.getElementById('bomToolHint');
    if (hint) {
      if (bmTool === 'callout') {
        const row = bmSelectedRowId ? bmRowById(bmSelectedRowId) : null;
        hint.textContent = 'Add Callouts: place ' + (row ? (bmRowSeq(row.id, bmVariant) || '') + '. ' + bmShortLabel(row.cells.description || '(empty)') : 'the highlighted row')
          + '; Select/Esc finishes.';
      } else if (bmTool === 'leader') {
        hint.textContent = 'Add Leaders: click multiple targets on the selected callout image; Select/Esc finishes.';
      } else {
        hint.textContent = 'Select a callout label, leader, or target to adjust it.';
      }
    }
  }

  function bmDrawCanvas() {
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    bmDrawCanvasInto(canvas, rect.width, rect.height, dpr);
  }

  // Draw the active variant's Material Key (images + callouts) into any
  // canvas at a given CSS size and pixel scale. Extracted from bmDrawCanvas
  // (US-079) so the tech-pack Excel export can render a chosen variant
  // offscreen through the same drawing code the live Material Key uses.
  function bmDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale) {
    const w = Math.max(1, Math.round(cssWidth * pixelScale));
    const h = Math.max(1, Math.round(cssHeight * pixelScale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const images = bmVariantImages();
    if (!images.length) {
      ctx.fillStyle = '#8a8f9a';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Paste, drop, or add images to this ' + bmVariant.toUpperCase() + ' Material Key.', cssWidth / 2, cssHeight / 2);
      bmCanvasView = { offX: cssWidth / 2, offY: cssHeight / 2, scale: 1 };
      return;
    }

    // US-090, the same defect Construction's ccBuildPanelLayout carries (ADR
    // 0041 keeps the two as a deliberate fork): this view fits the canvas to
    // the UNION BBOX of the Material Key's images and was rebuilt from the live
    // bbox on every draw, while bmOnPointerMove positions the dragged image
    // from an origin captured in the PREVIOUS view's space. The reference moved
    // under the formula, so the image lagged the cursor and the whole key
    // rescaled mid-drag (measured 1.214 -> 0.795 over one 200px drag), while
    // the stored x ran away by an unbounded amount that pushHistoryIfChanged
    // saved into the project. Frozen for the duration of a drag; re-fits on
    // release.
    const bounds = (bmFrozenBounds || bmImageBounds());
    const pad = 40;
    const scale = Math.min(
      (cssWidth - pad * 2) / bounds.width,
      (cssHeight - pad * 2) / bounds.height,
      4
    );
    const offX = (cssWidth - bounds.width * scale) / 2 - bounds.x * scale;
    const offY = (cssHeight - bounds.height * scale) / 2 - bounds.y * scale;
    bmCanvasView = { offX, offY, scale };

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    images.forEach(image => {
      const img = bmImageRuntime(image.id);
      if (img) ctx.drawImage(img, image.x, image.y, image.width, image.height);
      if (image.id === bmSelectedImageId) {
        ctx.strokeStyle = '#356dff';
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(image.x, image.y, image.width, image.height);
      }
    });
    ctx.restore();

    bmVisibleCallouts().forEach(c => bmDrawCallout(ctx, c, c.id === bmSelectedCalloutId));
  }

  // Offscreen render of ONE variant's Material Key for the tech-pack Excel
  // export (US-079). Swaps the module view state so the shared draw code
  // targets the requested variant with no selection chrome, and restores it
  // in finally — bmCanvasView is the live canvas's hit-test mapping and must
  // never be left pointing at the offscreen render.
  function bmRenderMatkeyToCanvas(variant, cssWidth, cssHeight, pixelScale) {
    const saved = {
      variant: bmVariant, callout: bmSelectedCalloutId,
      image: bmSelectedImageId, view: bmCanvasView,
    };
    const canvas = document.createElement('canvas');
    try {
      bmVariant = bmVariantKey(variant);
      bmSelectedCalloutId = null;
      bmSelectedImageId = null;
      bmDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale || 1);
    } finally {
      bmVariant = saved.variant;
      bmSelectedCalloutId = saved.callout;
      bmSelectedImageId = saved.image;
      bmCanvasView = saved.view;
    }
    return canvas;
  }

  function bmLabelBox(ctx, label, text, isSelected) {
    ctx.font = (isSelected ? 'bold ' : '') + '12px sans-serif';
    const w = ctx.measureText(text).width;
    return { x: label.x - 4, y: label.y - 9, width: w + 8, height: 18 };
  }

  function bmEdgeToward(box, ax, ay) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = ax - cx, dy = ay - cy;
    if (Math.abs(dx) < box.width / 2 && Math.abs(dy) < box.height / 2) return null;
    const tx = dx !== 0 ? (box.width / 2) / Math.abs(dx) : 1e9;
    const ty = dy !== 0 ? (box.height / 2) / Math.abs(dy) : 1e9;
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function bmDrawArrowHead(ctx, from, to, color) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - BM_ARROW_SIZE * Math.cos(angle - Math.PI / 6), to.y - BM_ARROW_SIZE * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - BM_ARROW_SIZE * Math.cos(angle + Math.PI / 6), to.y - BM_ARROW_SIZE * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function bmDrawCallout(ctx, c, isSelected) {
    const im = bmImageById(c.imageId);
    if (!im) return;
    const label = bmWorldToCanvas(bmWorldOf(im, c.textPos));
    const orphan = !bmRowById(c.rowId);
    const color = orphan ? BM_ORPHAN_COLOR : BM_CALLOUT_COLOR;
    const text = bmCalloutLabelText(c);
    const box = bmLabelBox(ctx, label, text, isSelected);
    const targets = c.targets || [];
    const seq = bmRowBase(c.rowId, bmVariant);

    ctx.save();
    targets.forEach((t, i) => {
      const pin = bmWorldToCanvas(bmWorldOf(im, t));
      const edge = bmEdgeToward(box, pin.x, pin.y);
      const from = edge || { x: label.x, y: label.y };
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      bmDrawArrowHead(ctx, from, pin, color);
      if (i === 0) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, BM_PIN_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(seq || '?'), pin.x, pin.y + 0.5);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, BM_ANCHOR_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    ctx.font = (isSelected ? 'bold ' : '') + '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (isSelected) {
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = orphan ? BM_ORPHAN_COLOR : '#111';
    ctx.fillText(text, label.x, label.y);
    ctx.restore();
  }

  function bmRenderCalloutSidePanel() {
    const empty = document.getElementById('bomMkSideEmpty');
    const panel = document.getElementById('bomMkSideCallout');
    if (!empty || !panel) return;
    const c = bmSelectedCallout();
    if (!c) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }
    empty.hidden = true;
    panel.hidden = false;
    const seqEl = document.getElementById('bomMkSideSeq');
    if (seqEl) seqEl.textContent = String(bmRowSeq(c.rowId, bmVariant) || '?');
    const rowSelect = document.getElementById('bomMkRowSelect');
    if (rowSelect && rowSelect !== document.activeElement) {
      const rows = bmVisibleRows(bmVariant);
      const orphan = !rows.some(r => r.id === c.rowId);
      rowSelect.innerHTML = (orphan
        ? '<option value="" selected disabled>? deleted BOM row — pick a row to relink</option>'
        : '')
        + rows.map(r => {
          const seq = bmRowSeq(r.id, bmVariant);
          const occupied = bmCalloutForRow(r.id, bmVariant);
          const disabled = occupied && occupied.id !== c.id;
          return '<option value="' + r.id + '"' + (!orphan && r.id === c.rowId ? ' selected' : '')
            + (disabled ? ' disabled' : '') + '>'
            + seq + '. ' + escapeHtml(r.cells.description || '(empty)') + '</option>';
        }).join('');
    }
  }

  function bmOnPointerDown(e) {
    if (!state.bom) return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const pt = bmCanvasPointFromEvent(e, canvas);
    if (bmTool === 'callout') { bmCreateCalloutAt(pt); return; }
    if (bmTool === 'leader') { bmAddArrowAt(pt); return; }
    const hit = bmHitTest(pt);
    if (hit) {
      bmSelectedCalloutId = hit.callout.id;
      bmSelectedRowId = hit.callout.rowId;
      bmSelectedImageId = null;
      bmDrag = hit.part === 'line' ? null
        : { callout: hit.callout, part: hit.part, anchorIndex: hit.anchorIndex, imageRec: hit.imageRec };
      renderBom();
      e.preventDefault();
      return;
    }
    const image = bmImageAt(pt);
    if (image) {
      bmSelectedCalloutId = null;
      bmSelectedImageId = image.id;
      // A Material Key holding a single image has no arrangement to make: the
      // fit-to-bounds view re-centres it whatever its coordinates, so a drag
      // could only produce an invisible mutation that gets saved. Select it,
      // do not drag it. With two or more, position matters and the drag runs
      // against a frozen fit basis.
      if (bmVariantImages().length > 1) {
        bmFrozenBounds = bmImageBounds();
        bmDrag = {
          part: 'image', imageRec: image,
          startX: pt.x, startY: pt.y, originX: image.x, originY: image.y,
        };
      }
      renderBom();
      e.preventDefault();
      return;
    }
    bmSelectedCalloutId = null;
    bmSelectedImageId = null;
    renderBom();
  }

  function bmOnPointerMove(e) {
    if (!bmDrag) return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const pt = bmCanvasPointFromEvent(e, canvas);
    if (bmDrag.part === 'image') {
      if (!bmDrag.imageRec.locked) {
        bmDrag.imageRec.x = bmDrag.originX + pt.x - bmDrag.startX;
        bmDrag.imageRec.y = bmDrag.originY + pt.y - bmDrag.startY;
      }
    } else {
      const norm = bmNormalize(bmDrag.imageRec, pt);
      if (bmDrag.part === 'anchor') bmDrag.callout.targets[bmDrag.anchorIndex] = norm;
      else bmDrag.callout.textPos = norm;
    }
    bmDrawCanvas();
  }

  function bmOnPointerUp() {
    if (!bmDrag) return;
    const wasImageDrag = bmDrag.part === 'image';
    bmDrag = null;
    // Release the frozen fit basis and re-frame the key around wherever the
    // images ended up, before the history entry is taken.
    if (bmFrozenBounds) {
      bmFrozenBounds = null;
      if (wasImageDrag) bmDrawCanvas();
    }
    pushHistoryIfChanged();
  }

  function bmOnDoubleClick(e) {
    if (bmTool !== 'select') return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    bmDeleteAnchorAt(bmCanvasPointFromEvent(e, canvas));
  }
