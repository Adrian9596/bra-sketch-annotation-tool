// Construction working sheets (US-078, ADR 0045) — the leader-line annotation
// engine: panel layout, world/canvas geometry, hit-testing, callout and leader
// placement, drawing, the offscreen sheet renderer, and canvas pointer drag.
// Source part for app.js. Run `npm run build` after editing.
//
// BOM's Material Key carries a deliberate fork of this engine under a bm*
// prefix (ADR 0041): the two are kept as parallel files so drift between them
// is a one-file diff. Do not merge them.
//
// Callout number/area/detail are derived live from the owning row (see
// construction-rows.js); only label and target geometry is edited here.

  let ccDrag = null;
  let ccPanelLayouts = {};
  let ccBoxCache = {};
  // US-090: the fit-to-bounds basis, frozen for the duration of an image drag.
  // Keyed by view; null when no drag is in flight.
  let ccFrozenBounds = null;

  function ccBuildPanelLayout(view, x, y, width, height) {
    const content = { x: x + 12, y: y + 36, width: width - 24, height: height - 48 };
    // US-090. This transform fits the panel to the UNION BBOX of its images and
    // was recomputed from the live bbox on every draw — so moving an image
    // moved the very bounds the transform is derived from. With one image the
    // two cancelled exactly: measured, a 200px drag advanced the stored x by
    // 128.21 world units while the painted pixels did not move at all, and
    // pushHistoryIfChanged saved that invisible offset into the project. With
    // two, the bbox grew and the whole panel rescaled mid-gesture (1.214 ->
    // 0.795 over one drag). Freezing the basis for the duration of the drag
    // makes the gesture a plain translation in a stable space; the panel
    // re-fits once on release.
    const bounds = (ccFrozenBounds && ccFrozenBounds[view]) || ccImageBounds(ccSheet, view);
    const hasImages = ccImages(ccSheet, view).length > 0;
    const scale = hasImages ? Math.min(content.width / bounds.width, content.height / bounds.height, 2) : 1;
    return {
      view, x, y, width, height, content,
      offX: content.x + (content.width - bounds.width * scale) / 2 - bounds.x * scale,
      offY: content.y + (content.height - bounds.height * scale) / 2 - bounds.y * scale,
      scale,
    };
  }

  function ccWorldToCanvas(layout, point) {
    return { x: point.x * layout.scale + layout.offX, y: point.y * layout.scale + layout.offY };
  }

  function ccCanvasToWorld(layout, point) {
    return { x: (point.x - layout.offX) / layout.scale, y: (point.y - layout.offY) / layout.scale };
  }

  function ccWorldOf(image, norm) {
    return { x: image.x + norm.nx * image.width, y: image.y + norm.ny * image.height };
  }

  function ccNormalize(image, point) {
    return {
      nx: clamp((point.x - image.x) / image.width, 0, 1),
      ny: clamp((point.y - image.y) / image.height, 0, 1),
    };
  }

  function ccPanelAt(point) {
    return CC_VIEWS.map(view => ccPanelLayouts[view]).find(layout => layout
      && point.x >= layout.x && point.x <= layout.x + layout.width
      && point.y >= layout.y && point.y <= layout.y + layout.height) || null;
  }

  function ccDistanceToSegment(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function ccHitTest(point) {
    const callouts = ccVisibleCallouts();
    for (let i = callouts.length - 1; i >= 0; i -= 1) {
      const callout = callouts[i];
      const layout = ccPanelLayouts[callout.view];
      const image = ccImageById(callout.imageId, ccSheet, callout.view);
      if (!layout || !image) continue;
      for (let ti = callout.targets.length - 1; ti >= 0; ti -= 1) {
        const pin = ccWorldToCanvas(layout, ccWorldOf(image, callout.targets[ti]));
        if (Math.hypot(point.x - pin.x, point.y - pin.y) <= CC_HIT_RADIUS) {
          return { callout, image, layout, part: 'anchor', anchorIndex: ti };
        }
      }
      const box = ccBoxCache[callout.id];
      if (box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
        return { callout, image, layout, part: 'label', anchorIndex: -1 };
      }
      const label = ccWorldToCanvas(layout, ccWorldOf(image, callout.textPos));
      for (let ti = callout.targets.length - 1; ti >= 0; ti -= 1) {
        const pin = ccWorldToCanvas(layout, ccWorldOf(image, callout.targets[ti]));
        if (ccDistanceToSegment(point, label, pin) <= 6) {
          return { callout, image, layout, part: 'line', anchorIndex: ti };
        }
      }
    }
    return null;
  }

  function ccCreateCalloutAt(layout, worldPoint) {
    const row = ccRowById(ccSelectedRowId) || ccMissingRows()[0];
    if (!row || row.sheet !== ccSheet || ccCalloutForRow(row.id)) {
      ccStartCalloutTool();
      return;
    }
    if (layout.view !== row.view) {
      ccActiveView = row.view;
      ccSyncUi();
      showToast('Row ' + ccRowSeq(row.id) + ' belongs to ' + row.view.toUpperCase() + '; place it in that panel');
      return;
    }
    const image = ccImageAt(row.view, worldPoint);
    if (!image) { showToast('Click a sketch image in the ' + row.view.toUpperCase() + ' panel'); return; }
    const target = ccNormalize(image, worldPoint);
    const callout = {
      id: state.idCounter++, rowId: row.id, sheet: row.sheet, view: row.view, imageId: image.id,
      targets: [target],
      textPos: {
        nx: clamp(target.nx + (target.nx > 0.65 ? -0.30 : 0.08), 0.02, 0.88),
        ny: clamp(target.ny - 0.04, 0.04, 0.94),
      },
      color: CC_CALLOUT_COLOR,
    };
    ensureConstruction().callouts.push(callout);
    const next = ccNextMissingRow(row.id);
    if (next) {
      ccSelectedRowId = next.id;
      ccSelectedCalloutId = null;
      ccActiveView = next.view;
    } else {
      ccSelectedRowId = row.id;
      ccSelectedCalloutId = callout.id;
      ccTool = 'select';
    }
    renderConstruction();
    pushHistoryIfChanged();
    showToast(next ? 'Callout added · next row ' + ccRowSeq(next.id) + ' · ' + next.view.toUpperCase() : 'All Construction rows now have callouts · Select is active');
  }

  function ccAddLeaderAt(layout, worldPoint) {
    const callout = ccSelectedCallout();
    if (!callout) { ccSetTool('select'); return; }
    if (layout.view !== callout.view) { showToast('Add leaders inside the selected callout\'s ' + callout.view.toUpperCase() + ' panel'); return; }
    const image = ccImageById(callout.imageId, ccSheet, callout.view);
    if (!image || ccImageAt(callout.view, worldPoint) !== image) {
      showToast('Add the leader inside the selected callout\'s own image');
      return;
    }
    callout.targets.push(ccNormalize(image, worldPoint));
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccDeleteAnchorAt(point) {
    const hit = ccHitTest(point);
    if (!hit || hit.part !== 'anchor') return;
    if (hit.callout.targets.length <= 1) {
      showToast('A callout needs at least one leader; delete the callout to remove it');
      return;
    }
    hit.callout.targets.splice(hit.anchorIndex, 1);
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccWrapLines(ctx, text, maxWidth) {
    const paragraphs = String(text || '').split('\n');
    const lines = [];
    paragraphs.forEach(paragraph => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); return; }
      let line = '';
      words.forEach(word => {
        const next = line ? line + ' ' + word : word;
        if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
        else line = next;
      });
      lines.push(line);
    });
    return lines.length ? lines : [''];
  }

  function ccEdgeToward(box, target) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = target.x - cx, dy = target.y - cy;
    const tx = dx ? (box.width / 2) / Math.abs(dx) : 1e9;
    const ty = dy ? (box.height / 2) / Math.abs(dy) : 1e9;
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function ccDrawArrow(ctx, from, to, color) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - CC_ARROW_SIZE * Math.cos(angle - Math.PI / 6), to.y - CC_ARROW_SIZE * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - CC_ARROW_SIZE * Math.cos(angle + Math.PI / 6), to.y - CC_ARROW_SIZE * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function ccCalloutText(callout) {
    const row = ccRowById(callout.rowId);
    if (!row) return '? deleted Construction row';
    const detail = String(row.detail || '').trim();
    return ccRowSeq(row.id, row.sheet) + '. ' + CC_AREA_LABELS[row.area].toUpperCase() + (detail ? ' — ' + detail : '');
  }

  function ccDrawCallout(ctx, callout) {
    const row = ccRowById(callout.rowId);
    const layout = ccPanelLayouts[callout.view];
    const image = ccImageById(callout.imageId, callout.sheet, callout.view);
    if (!row || !layout || !image) return;
    const selected = callout.id === ccSelectedCalloutId;
    const color = callout.color || CC_CALLOUT_COLOR;
    const label = ccWorldToCanvas(layout, ccWorldOf(image, callout.textPos));
    ctx.save();
    ctx.font = (selected ? 'bold ' : '') + '12px sans-serif';
    const lines = ccWrapLines(ctx, ccCalloutText(callout), CC_TEXT_WIDTH);
    const widths = lines.map(line => ctx.measureText(line).width);
    const box = { x: label.x - 5, y: label.y - 9, width: Math.max(34, ...widths) + 10, height: Math.max(1, lines.length) * CC_LINE_HEIGHT + 6 };
    ccBoxCache[callout.id] = box;
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    callout.targets.forEach((target, index) => {
      const pin = ccWorldToCanvas(layout, ccWorldOf(image, target));
      const from = ccEdgeToward(box, pin);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      ccDrawArrow(ctx, from, pin, color);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pin.x, pin.y, index === 0 ? CC_PIN_RADIUS : CC_ANCHOR_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      if (index === 0) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ccRowSeq(row.id, row.sheet), pin.x, pin.y + .5);
      }
    });
    if (selected) {
      ctx.strokeStyle = '#3f8ae0';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
    ctx.font = (selected ? 'bold ' : '') + '12px sans-serif';
    ctx.fillStyle = callout.textRed ? '#cc0000' : '#111';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((line, index) => ctx.fillText(line, label.x, label.y + index * CC_LINE_HEIGHT));
    ctx.restore();
  }

  function ccDrawCanvas() {
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    ccDrawCanvasInto(canvas, rect.width, rect.height, dpr);
  }

  // Draw the active sheet's working board (Outer/Inner panels + callouts)
  // into any canvas at a given CSS size and pixel scale. Extracted from
  // ccDrawCanvas so the Preview & Export page can render a chosen sheet
  // offscreen through the exact same drawing code the live board uses
  // (US-079: preview and export share one render path).
  function ccDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale) {
    canvas.width = Math.round(cssWidth * pixelScale);
    canvas.height = Math.round(cssHeight * pixelScale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#eef0f4';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    const gap = 12;
    const panelWidth = (cssWidth - gap * 3) / 2;
    const panelHeight = cssHeight - gap * 2;
    ccPanelLayouts = {
      outer: ccBuildPanelLayout('outer', gap, gap, panelWidth, panelHeight),
      inner: ccBuildPanelLayout('inner', gap * 2 + panelWidth, gap, panelWidth, panelHeight),
    };
    ccBoxCache = {};
    CC_VIEWS.forEach(view => {
      const layout = ccPanelLayouts[view];
      ctx.fillStyle = '#fff';
      ctx.fillRect(layout.x, layout.y, layout.width, layout.height);
      ctx.strokeStyle = view === ccActiveView ? '#1c6dd0' : '#c7ccd4';
      ctx.lineWidth = view === ccActiveView ? 2 : 1;
      ctx.strokeRect(layout.x, layout.y, layout.width, layout.height);
      ctx.fillStyle = view === ccActiveView ? '#eaf2ff' : '#f5f6f8';
      ctx.fillRect(layout.x, layout.y, layout.width, 30);
      ctx.fillStyle = '#111827';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(view.toUpperCase(), layout.x + 10, layout.y + 15);
      const images = ccImages(ccSheet, view);
      if (!images.length) {
        ctx.strokeStyle = '#c8ccd4';
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(layout.content.x, layout.content.y, layout.content.width, layout.content.height);
        ctx.setLineDash([]);
        ctx.fillStyle = '#7a8190';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Paste, drop, or add images to ' + view.toUpperCase(), layout.content.x + layout.content.width / 2, layout.content.y + layout.content.height / 2);
      }
      images.forEach(image => {
        const topLeft = ccWorldToCanvas(layout, { x: image.x, y: image.y });
        const width = image.width * layout.scale, height = image.height * layout.scale;
        const runtime = ccImageRuntime(image.id);
        if (runtime) ctx.drawImage(runtime, topLeft.x, topLeft.y, width, height);
        else {
          ctx.fillStyle = '#f3f4f6';
          ctx.fillRect(topLeft.x, topLeft.y, width, height);
          ctx.fillStyle = '#8b919c';
          ctx.textAlign = 'center';
          ctx.fillText('Image data unavailable', topLeft.x + width / 2, topLeft.y + height / 2);
        }
        if (image.id === ccSelectedImageId) {
          ctx.strokeStyle = '#3f8ae0';
          ctx.lineWidth = 2;
          ctx.strokeRect(topLeft.x - 2, topLeft.y - 2, width + 4, height + 4);
        }
      });
    });
    ccVisibleCallouts().forEach(callout => ccDrawCallout(ctx, callout));
  }

  // Offscreen render of ONE sheet (solid|lace) for the Preview & Export page
  // and the tech-pack Excel export. Swaps the module view state so the shared
  // draw code targets the requested sheet with no selection/active-panel
  // chrome, and restores it in finally so the live board never observes the
  // swap. ccPanelLayouts/ccBoxCache are hit-testing caches keyed to the live
  // canvas — they must be restored or clicks after a render would mis-hit.
  function ccRenderSheetToCanvas(sheet, cssWidth, cssHeight, pixelScale) {
    const saved = {
      sheet: ccSheet, view: ccActiveView, callout: ccSelectedCalloutId,
      image: ccSelectedImageId, layouts: ccPanelLayouts, boxes: ccBoxCache,
    };
    const canvas = document.createElement('canvas');
    try {
      ccSheet = ccSheetKey(sheet);
      ccActiveView = '';
      ccSelectedCalloutId = null;
      ccSelectedImageId = null;
      ccDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale || 1);
    } finally {
      ccSheet = saved.sheet;
      ccActiveView = saved.view;
      ccSelectedCalloutId = saved.callout;
      ccSelectedImageId = saved.image;
      ccPanelLayouts = saved.layouts;
      ccBoxCache = saved.boxes;
    }
    return canvas;
  }

  function ccEventPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function ccOnPointerDown(event) {
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const point = ccEventPoint(event, canvas);
    const layout = ccPanelAt(point);
    if (!layout) return;
    ccActiveView = layout.view;
    const world = ccCanvasToWorld(layout, point);
    if (ccTool === 'callout') { ccCreateCalloutAt(layout, world); return; }
    if (ccTool === 'leader') { ccAddLeaderAt(layout, world); return; }
    const hit = ccHitTest(point);
    if (hit) {
      ccSelectedCalloutId = hit.callout.id;
      ccSelectedRowId = hit.callout.rowId;
      ccSelectedImageId = null;
      if (hit.part !== 'line') ccDrag = { kind: 'callout', hit };
      renderConstruction();
      event.preventDefault();
      return;
    }
    const image = ccImageAt(layout.view, world);
    if (image) {
      ccSelectedImageId = image.id;
      ccSelectedCalloutId = null;
      // A panel holding a single image has no arrangement to make: the
      // fit-to-bounds transform re-centres it whatever its coordinates, so the
      // only thing a drag could achieve is an invisible mutation that gets
      // saved. Select it, do not drag it. With two or more, position is
      // meaningful and the drag runs against a frozen fit basis.
      const draggable = ccImages(ccSheet, layout.view).length > 1;
      if (draggable) {
        ccFrozenBounds = { [layout.view]: ccImageBounds(ccSheet, layout.view) };
        ccDrag = { kind: 'image', image, layout, prev: world };
      }
    } else {
      ccSelectedImageId = null;
      ccSelectedCalloutId = null;
    }
    renderConstruction();
  }

  function ccOnPointerMove(event) {
    if (!ccDrag) return;
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const point = ccEventPoint(event, canvas);
    if (ccDrag.kind === 'callout') {
      const hit = ccDrag.hit;
      const world = ccCanvasToWorld(hit.layout, point);
      const norm = ccNormalize(hit.image, world);
      if (hit.part === 'anchor') hit.callout.targets[hit.anchorIndex] = norm;
      else if (hit.part === 'label') hit.callout.textPos = norm;
    } else if (ccDrag.kind === 'image') {
      const world = ccCanvasToWorld(ccDrag.layout, point);
      ccDrag.image.x += world.x - ccDrag.prev.x;
      ccDrag.image.y += world.y - ccDrag.prev.y;
      ccDrag.prev = world;
    }
    ccDrawCanvas();
  }

  function ccOnPointerUp() {
    if (!ccDrag) return;
    const wasImageDrag = ccDrag.kind === 'image';
    ccDrag = null;
    // Release the frozen fit basis and re-frame the panel around wherever the
    // images ended up, before the history entry is taken.
    if (ccFrozenBounds) {
      ccFrozenBounds = null;
      if (wasImageDrag) ccDrawCanvas();
    }
    pushHistoryIfChanged();
  }
