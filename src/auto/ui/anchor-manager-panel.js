// The Anchor Manager: a floating, non-modal panel over the board for hiding,
// showing and isolating detected anchors while checking Auto Mode's accuracy.
// Extracted from src/ui/spec-panel.js — see the US-038 note below for why it
// is deliberately NOT part of the exported Measurements panel.
// Source part for app.js. Run `npm run build` after editing.

  // ---- US-038: Anchors visibility manager (its OWN floating panel) -------
  // Deliberately NOT part of the Measurements panel: measurements are the
  // exported spec; anchors are a testing / accuracy-checking aid that never
  // exports. The panel floats over the board (non-modal) and is opened from
  // the Auto toolbar "Anchors" button. Offers Hide all / Show all, per-group
  // hide, per-anchor hide, and Isolate ("show only one"); a row click selects
  // the pin on the canvas.

  function anchorGroupLabel(group) {
    const map = {
      axis: 'Center / cradle', band: 'Band', chest: 'Chest', 'inner-cup': 'Cup',
      side: 'Side seam', apex: 'Apex', strap: 'Straps', back: 'Back',
      neckline: 'Neckline (17)', armhole: 'Armhole (18)',
    };
    return map[group] || group;
  }

  function anchorMiniBtn(label, title, onClick, extraCss) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText = 'border:1px solid #cbd5e1;background:#fff;border-radius:5px;'
      + 'cursor:pointer;font-size:11px;line-height:1;padding:2px 6px;color:#334155;'
      + (extraCss || '');
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  function isAnchorManagerOpen() {
    return !!(el.anchorManagerPanel && !el.anchorManagerPanel.hidden);
  }

  // Toolbar entry point: open the floating anchor panel (Auto Mode only).
  function openAnchorManager() {
    if (state.appMode !== 'auto') {
      showToast('Anchor management is available in Auto Mode.');
      return;
    }
    if (!state.autoMode.anchors.length) {
      showToast('Run Detect Sketch first to place anchors.');
      return;
    }
    if (!el.anchorManagerPanel) return;
    el.anchorManagerPanel.hidden = false;
    if (el.autoManageAnchorsBtn) el.autoManageAnchorsBtn.classList.add('active');
    renderAnchorManagerPanel();
  }

  function closeAnchorManager() {
    if (!el.anchorManagerPanel) return;
    el.anchorManagerPanel.hidden = true;
    if (el.autoManageAnchorsBtn) el.autoManageAnchorsBtn.classList.remove('active');
  }

  function toggleAnchorManager() {
    if (isAnchorManagerOpen()) closeAnchorManager();
    else openAnchorManager();
  }

  // Rebuild the floating panel body from the current anchor set + hidden
  // state. Called on open, on every in-panel action, and from updateUI while
  // open (so a fresh Detect / canvas pin selection stays in sync).
  function renderAnchorManagerPanel() {
    const panel = el.anchorManagerPanel;
    const body = el.anchorManagerBody;
    if (!panel || !body) return;
    // Anchors only exist in Auto Mode; auto-close if we left it or lost them.
    if (state.appMode !== 'auto' || !state.autoMode.anchors.length) {
      closeAnchorManager();
      return;
    }
    const anchors = state.autoMode.anchors;
    const nameByKind = Object.create(null);
    const groupByKind = Object.create(null);
    const groupOrder = [];
    for (const schema of ANCHOR_SCHEMA) {
      nameByKind[schema.kind] = schema.name || schema.kind;
      groupByKind[schema.kind] = schema.group || 'other';
      if (groupOrder.indexOf(schema.group) === -1) groupOrder.push(schema.group);
    }
    const hidden = (k) => isAnchorHidden(k);
    const visibleCount = anchors.filter(a => !hidden(a.kind)).length;
    if (el.anchorManagerCount) {
      el.anchorManagerCount.textContent = visibleCount + '/' + anchors.length + ' shown';
    }

    body.innerHTML = '';
    for (const group of groupOrder) {
      const groupAnchors = anchors.filter(a => groupByKind[a.kind] === group);
      if (!groupAnchors.length) continue;
      const groupKinds = groupAnchors.map(a => a.kind);
      const groupAllHidden = groupKinds.every(hidden);

      const gRow = document.createElement('div');
      gRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px;'
        + 'font-size:11.5px;color:#475569;background:#f8fafc;border-top:1px solid #eef2f7;';
      const gName = document.createElement('span');
      gName.style.fontWeight = '600';
      gName.textContent = anchorGroupLabel(group) + ' (' + groupAnchors.length + ')';
      gRow.appendChild(gName);
      const gSpacer = document.createElement('span'); gSpacer.style.flex = '1'; gRow.appendChild(gSpacer);
      gRow.appendChild(anchorMiniBtn(groupAllHidden ? 'Show' : 'Hide',
        groupAllHidden ? 'Show this group' : 'Hide this group',
        () => { toggleAnchorGroup(groupKinds); renderAnchorManagerPanel(); }));
      body.appendChild(gRow);

      for (const anchor of groupAnchors) {
        const isHidden = hidden(anchor.kind);
        const aRow = document.createElement('div');
        aRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 10px 4px 22px;'
          + 'font-size:12px;border-top:1px solid #f4f6fa;'
          + (state.autoMode.anchorSelectedId === anchor.id ? 'background:#eff6ff;' : '')
          + (isHidden ? 'opacity:.5;' : '');
        const dot = document.createElement('span');
        dot.style.cssText = 'width:8px;height:8px;border-radius:50%;flex:0 0 auto;'
          + 'background:' + anchorFillForConfidence(anchor.confidence) + ';'
          + 'border:1px solid rgba(15,23,42,.5);';
        aRow.appendChild(dot);
        const aName = document.createElement('span');
        aName.textContent = nameByKind[anchor.kind] || anchor.kind;
        aName.style.cssText = 'color:#0f172a;cursor:pointer;';
        aName.title = anchor.name + ' — click to select on the sketch';
        aRow.appendChild(aName);
        if (anchor.reviewRequired) {
          const flag = document.createElement('span');
          flag.textContent = 'review';
          flag.style.cssText = 'font-size:10px;color:#b45309;background:#fffbeb;'
            + 'border:1px solid #fde68a;border-radius:4px;padding:0 4px;';
          aRow.appendChild(flag);
        }
        const aSpacer = document.createElement('span'); aSpacer.style.flex = '1'; aRow.appendChild(aSpacer);
        aRow.appendChild(anchorMiniBtn('◎', 'Isolate — show only this anchor',
          () => { isolateAnchor(anchor.kind); renderAnchorManagerPanel(); }));
        aRow.appendChild(anchorMiniBtn(isHidden ? '+' : '×',
          isHidden ? 'Show this anchor' : 'Hide this anchor',
          () => { toggleAnchorHidden(anchor.kind); renderAnchorManagerPanel(); },
          isHidden ? 'color:#2563eb;' : 'color:#b91c1c;'));
        aName.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isHidden) return;
          state.autoMode.anchorSelectedId = anchor.id;
          updateUI();
          requestRender();
          renderAnchorManagerPanel();
        });
        body.appendChild(aRow);
      }
    }
  }
