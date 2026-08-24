// US-097 + US-098 / ADR 0059: the Template section of the Tools menu.
//
// Presentation only, mirroring src/ui/line-preset-panel.js exactly: every
// mutation goes through src/manual/shape-stamps.js, which owns the model, the
// storage and the placement semantics.
// Source part for app.js. Run `npm run build` after editing.

  // The preview is the stamp's OWN geometry, sampled into an SVG path and
  // fitted to the swatch — not a generic curve icon. Two saved cup curves that
  // differ only in their bow have to be distinguishable in the list, which is
  // the whole reason a TD saved both.
  function shapeStampPreviewSvg(stamp) {
    const w = 36, h = 14, pad = 2;
    const at = (p) => ({
      x: pad + (p.x * (w - pad * 2)),
      y: pad + (p.y * (h - pad * 2)),
    });
    const members = Array.isArray(stamp.members) && stamp.members.length ? stamp.members : [stamp];
    const paths = members.map(member => {
      const s0 = at(member.start);
      let d = 'M' + s0.x.toFixed(2) + ' ' + s0.y.toFixed(2);
      if (member.type === 'curved' && member.control1 && member.control2) {
        let c1 = at(member.control1);
        for (const pt of member.points) {
        const hIn = at(pt.handleIn);
        const p = at(pt.point);
        d += ' C' + c1.x.toFixed(2) + ' ' + c1.y.toFixed(2)
          + ',' + hIn.x.toFixed(2) + ' ' + hIn.y.toFixed(2)
          + ',' + p.x.toFixed(2) + ' ' + p.y.toFixed(2);
        c1 = at(pt.handleOut);
      }
      const c2 = at(member.control2);
      const e = at(member.end);
      d += ' C' + c1.x.toFixed(2) + ' ' + c1.y.toFixed(2)
        + ',' + c2.x.toFixed(2) + ' ' + c2.y.toFixed(2)
        + ',' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
    } else {
      const e = at(member.end);
      d += ' L' + e.x.toFixed(2) + ' ' + e.y.toFixed(2);
    }
      const color = LINE_COLORS[member.color] || LINE_COLOR;
      return '<path d="' + d + '" stroke="' + color + '"/>';
    }).join('');
    return '<svg class="style-preview" viewBox="0 0 ' + w + ' ' + h + '" fill="none" '
      + 'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function shapeStampRowTitle(stamp) {
    const shape = stamp.type === 'curved'
      ? `curve, ${stamp.points.length + 1} segment${stamp.points.length ? 's' : ''}`
      : 'straight';
    const ratio = stamp.aspect > 0
      ? `${stamp.aspect.toFixed(2)}:1 tall (Shift while dragging locks it)`
      : 'no fixed proportion';
    const count = Array.isArray(stamp.members) ? stamp.members.length : 1;
    return `${stamp.name} — ${count} editable path${count === 1 ? '' : 's'}, ${shape}, ${ratio}. Places a grouped Sketch Element, never an automatic POM.`;
  }

  function renderShapeStampList() {
    if (!el.shapeStampList) return;
    if (el.shapeStampImportProjectBtn) {
      const pending = getPendingProjectShapeStamps().length;
      el.shapeStampImportProjectBtn.hidden = pending === 0;
      el.shapeStampImportProjectBtn.textContent = pending
        ? `Import ${pending} shape${pending > 1 ? 's' : ''} from project`
        : 'Import from project';
    }
    const stamps = getShapeStamps();
    const swatch = (color) => LINE_COLORS[color] || LINE_COLOR;
    el.shapeStampList.innerHTML = stamps.map((stamp, index) => {
      const first = index === 0 ? ' disabled' : '';
      const last = index === stamps.length - 1 ? ' disabled' : '';
      const active = state.activeStampId === stamp.id ? ' active' : '';
      return '<div class="preset-row" data-stamp-id="' + escapeHtml(stamp.id) + '">'
        + '<button type="button" role="menuitem" class="preset-apply' + active + '" data-stamp-action="use"'
        + ' style="color:' + escapeHtml(swatch(stamp.color)) + '"'
        + ' title="' + escapeHtml(shapeStampRowTitle(stamp)) + '">'
        + shapeStampPreviewSvg(stamp)
        + '<span>' + escapeHtml(stamp.name) + '</span>'
        + '</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-stamp-action="up" aria-label="Move up" title="Move up"' + first + '>&#9650;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-stamp-action="down" aria-label="Move down" title="Move down"' + last + '>&#9660;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-stamp-action="rename" aria-label="Rename" title="Rename">&#9998;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-stamp-action="delete" aria-label="Delete" title="Delete">&times;</button>'
        + '</div>';
    }).join('');
  }

  // One truthful toast per action, worded for that action — the US-096 lesson:
  // showToast queues rather than replaces, so a message fired from inside the
  // storage layer is buried by the caller's own.
  function shapeStampToast(message) {
    showToast(shapeStampsPersisted()
      ? message
      : message + ' (this session only — the browser refused to store it)');
  }

  function saveSelectedLineAsShape() {
    const reason = canSaveShapeStampReason();
    if (reason !== true) { showToast(reason); return; }
    const targets = shapeStampSaveTargets();
    const kind = targets.length > 1 ? `${targets.length} selected paths` : (targets[0].type === 'curved' ? 'Curve' : 'Straight line');
    openLinePresetNameDialog({
      title: 'Save Template',
      sub: `${kind}. Geometry, styles and Treatments are kept; POM identity and measurements are excluded.`,
      value: '',
      confirmLabel: 'Save Template',
      onConfirm: (name) => {
        const stamp = addShapeStampFromSelection(name);
        if (!stamp) { showToast('Could not save that Template.'); return; }
        renderShapeStampList();
        shapeStampToast(`Saved "${stamp.name}" — pick it from Templates to place it.`);
      },
    });
  }

  function onShapeStampListClick(event) {
    const button = event.target.closest('[data-stamp-action]');
    if (!button || button.disabled) return;
    const row = button.closest('[data-stamp-id]');
    if (!row) return;
    event.stopPropagation();
    const id = row.dataset.stampId;
    const action = button.dataset.stampAction;
    const stamp = getShapeStampById(id);
    if (!stamp) return;

    if (action === 'use') {
      // Order matters: setTool('stamp') would disarm anything already chosen,
      // so arm AFTER switching.
      setTool('stamp');
      setActiveShapeStamp(id);
      closeBoardToolbarMenus(null, false);
      updateUI();
      showToast(`Drag to place Template "${stamp.name}". Shift keeps its proportions.`);
      return;
    }
    if (action === 'up' || action === 'down') {
      moveShapeStamp(id, action === 'up' ? -1 : 1);
      renderShapeStampList();
      // The re-render replaced the button that was just pressed; put focus
      // back on it, or arrow-key menu navigation dies and a repeated reorder
      // needs the mouse.
      refocusLibraryRowControl('shapeStampList', id, { kind: 'stamp', name: action });
      return;
    }
    if (action === 'rename') {
      openLinePresetNameDialog({
        title: 'Rename Template',
        sub: stamp.name,
        value: stamp.name,
        confirmLabel: 'Rename',
        onConfirm: (name) => {
          renameShapeStamp(id, name);
          renderShapeStampList();
          refocusLibraryRowControl('shapeStampList', id, { kind: 'stamp', name: 'rename' });
        },
      });
      return;
    }
    if (action === 'delete') {
      // The deleted row is gone, so there is nothing to refocus INSIDE it —
      // move to the same control on whichever row took its place, or the one
      // before it. Without this, focus falls to <body> and arrow navigation of
      // the whole menu dies, the same failure the reorder fix names.
      const order = getShapeStamps().map(s => s.id);
      const index = order.indexOf(id);
      deleteShapeStamp(id);
      renderShapeStampList();
      const after = getShapeStamps();
      const neighbour = after[Math.min(index, after.length - 1)];
      if (neighbour) refocusLibraryRowControl('shapeStampList', neighbour.id, { kind: 'stamp', name: 'delete' });
      shapeStampToast(`Deleted Template "${stamp.name}".`);
    }
  }

  function onShapeStampImportFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const added = importShapeStampsFromJson(String(reader.result || ''));
      renderShapeStampList();
      if (!added) { showToast('That file held no Templates.'); return; }
      shapeStampToast(`Imported ${added} Template${added > 1 ? 's' : ''}.`);
    };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
  }

  function bindShapeStampPanel() {
    if (!el.shapeStampList) return;
    el.shapeStampList.addEventListener('click', onShapeStampListClick);
    el.shapeStampSaveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeBoardToolbarMenus(null, false);
      saveSelectedLineAsShape();
    });
    el.shapeStampExportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      exportShapeStampsFile();
      closeBoardToolbarMenus(null, false);
    });
    el.shapeStampImportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      el.shapeStampFileInput.click();
    });
    el.shapeStampFileInput.addEventListener('change', onShapeStampImportFile);
    el.shapeStampImportProjectBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const added = importPendingProjectShapeStamps();
      el.shapeStampImportProjectBtn.hidden = true;
      renderShapeStampList();
      if (!added) { showToast('Nothing to import.'); return; }
      shapeStampToast(`Imported ${added} shape${added > 1 ? 's' : ''} from the project.`);
    });
  }
