// ADR 0070: the Pattern Pieces panel — a floating, non-modal list of every
// templateGroupId group on the board (DXF-imported grading-nest pieces, and
// Template placements, since both share the same field), so the TD can tell
// apart a stack of overlapping same-position sizes and keep only the ones
// they want. Mirrors src/ui/anchor-manager-panel.js's shape (floating panel,
// row-per-item, a Select action, plain DOM row-building), but the per-row
// action here is REMOVE, not hide: ADR 0067's research found no reliable way
// to auto-detect which size is "standard," so this is a manual, decisive
// choice, not a review-only toggle like the POM/anchor hide mechanisms —
// removed pieces are ordinary annotation deletions (undo-able via the normal
// history stack), not a new visibility flag layered onto rendering.
// Source part for app.js. Run `npm run build` after editing.

  // One row per distinct templateGroupId currently in state.annotations, in
  // first-seen order. Labeled from state.templateGroupLabels when DXF import
  // recorded a block name for that group; a positional fallback otherwise
  // (an anonymous block, or a non-DXF template group).
  function patternPieceGroups() {
    const order = [];
    const byId = new Map();
    for (const ann of state.annotations) {
      const gid = ann.templateGroupId;
      if (gid == null) continue;
      if (!byId.has(gid)) { byId.set(gid, { groupId: gid, ids: [] }); order.push(gid); }
      byId.get(gid).ids.push(ann.id);
    }
    return order.map((gid, i) => {
      const g = byId.get(gid);
      const label = (state.templateGroupLabels && state.templateGroupLabels[gid]) || ('Piece ' + (i + 1));
      return { groupId: gid, label, count: g.ids.length, ids: g.ids.slice() };
    });
  }

  function isPatternPiecesPanelOpen() {
    return !!(el.patternPiecesPanel && !el.patternPiecesPanel.hidden);
  }

  function openPatternPiecesPanel() {
    if (!el.patternPiecesPanel) return;
    if (!patternPieceGroups().length) {
      showToast('No sketch-element pieces on the board yet.');
      return;
    }
    el.patternPiecesPanel.hidden = false;
    if (el.patternPiecesBtn) el.patternPiecesBtn.classList.add('active');
    renderPatternPiecesPanel();
  }

  function closePatternPiecesPanel() {
    if (!el.patternPiecesPanel) return;
    el.patternPiecesPanel.hidden = true;
    if (el.patternPiecesBtn) el.patternPiecesBtn.classList.remove('active');
  }

  function togglePatternPiecesPanel() {
    if (isPatternPiecesPanelOpen()) closePatternPiecesPanel();
    else openPatternPiecesPanel();
  }

  // Selects the group's annotations on the board so the existing multi-select
  // halo (render-loop.js) highlights exactly this outline among the stack —
  // reuses the click-a-group-member selection behavior already wired for
  // templateGroupId (src/manual/selection.js), just triggered from the panel
  // instead of a canvas click.
  function selectPatternPieceGroup(ids) {
    if (!ids || !ids.length) return;
    state.selection = { kind: 'annotation', id: ids[0] };
    state.selectedAnnotationIds = ids.slice();
    if (typeof updateUI === 'function') updateUI();
    if (typeof requestRender === 'function') requestRender();
  }

  // Deletes every annotation belonging to the given groups. Sketch-element
  // pieces carry no POM identity (ADR 0059/0060 — Templates and DXF geometry
  // never create a POM), so unlike deleteSelected()'s POM-review bookkeeping
  // (deletedPomKeys), a plain filter is the whole operation; the normal
  // history stack (pushHistoryIfChanged) is what makes this undo-able.
  function removePatternPieceGroups(groupIds) {
    const kill = new Set(groupIds);
    if (!kill.size) return;
    state.annotations = state.annotations.filter(ann => !kill.has(ann.templateGroupId));
    if (state.templateGroupLabels) {
      for (const gid of kill) delete state.templateGroupLabels[gid];
    }
    if (state.selection && state.selection.kind === 'annotation'
        && !state.annotations.some(a => a.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }
    state.selectedAnnotationIds = (state.selectedAnnotationIds || [])
      .filter(id => state.annotations.some(a => a.id === id));
    if (kill.has(state.templateGroupEditId)) state.templateGroupEditId = null;
    // findings-dxf.md Finding 7: a removed piece must not stay measurable at
    // its old, now-invisible position.
    if (typeof dxfMeasureInvalidateOnPieceEdit === 'function') dxfMeasureInvalidateOnPieceEdit();
    pushHistoryIfChanged();
    if (typeof updateUI === 'function') updateUI();
    if (typeof requestRender === 'function') requestRender();
  }

  function patternPieceMiniBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pattern-piece-mini-btn';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
    return b;
  }

  // Rebuilt on open and after Apply only (not on every generic updateUI, like
  // Anchor Manager's live-refresh) — a checkbox's unchecked state lives only
  // in this render's own closure until Apply reads it, matching the shape of
  // a one-shot "review this list, then act" tool rather than a live view.
  function renderPatternPiecesPanel() {
    const panel = el.patternPiecesPanel;
    const body = el.patternPiecesBody;
    if (!panel || !body) return;
    const groups = patternPieceGroups();
    if (!groups.length) { closePatternPiecesPanel(); return; }
    if (el.patternPiecesCount) {
      el.patternPiecesCount.textContent = groups.length + (groups.length === 1 ? ' piece' : ' pieces');
    }
    body.innerHTML = '';
    const keep = new Set(groups.map(g => g.groupId)); // every row starts checked ("keep")
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'pattern-piece-row';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pattern-piece-checkbox';
      box.checked = true;
      box.title = 'Uncheck to remove this piece from the board';
      box.addEventListener('change', () => {
        if (box.checked) keep.add(g.groupId); else keep.delete(g.groupId);
      });
      row.appendChild(box);

      const label = document.createElement('span');
      label.className = 'pattern-piece-label';
      label.textContent = g.label;
      label.title = g.label + ' — click to select on the board';
      label.addEventListener('click', (e) => { e.stopPropagation(); selectPatternPieceGroup(g.ids); });
      row.appendChild(label);

      const count = document.createElement('span');
      count.className = 'pattern-piece-count';
      count.textContent = g.count + (g.count === 1 ? ' line' : ' lines');
      row.appendChild(count);

      row.appendChild(patternPieceMiniBtn('Select', 'Highlight this piece on the board',
        () => selectPatternPieceGroup(g.ids)));
      // ADR 0072: merges redundant collinear points within this piece's
      // straight segments — same outline, fewer annotations. Re-renders
      // (not just updates the count span) because the merge changes which
      // annotation ids belong to this row's "Select" button.
      row.appendChild(patternPieceMiniBtn('Simplify', 'Merge redundant collinear points in this piece’s straight lines — same outline, fewer segments',
        () => {
          const result = simplifyPieceGroup(g.groupId);
          if (!result.chains) { showToast('Nothing to simplify — no redundant collinear points found.'); return; }
          pushHistoryIfChanged();
          if (typeof updateUI === 'function') updateUI();
          if (typeof requestRender === 'function') requestRender();
          showToast('Simplified ' + result.chains + (result.chains === 1 ? ' run' : ' runs')
            + ', removed ' + result.removed + (result.removed === 1 ? ' point.' : ' points.'));
          renderPatternPiecesPanel();
        }));
      body.appendChild(row);
    }

    if (el.patternPiecesApplyBtn) {
      el.patternPiecesApplyBtn.onclick = () => {
        const toRemove = groups.filter(g => !keep.has(g.groupId)).map(g => g.groupId);
        if (!toRemove.length) { showToast('Nothing unchecked — every piece stays.'); return; }
        removePatternPieceGroups(toRemove);
        showToast('Removed ' + toRemove.length + (toRemove.length === 1 ? ' piece.' : ' pieces.'));
        renderPatternPiecesPanel();
      };
    }
  }

  function bindPatternPiecesPanel() {
    if (el.patternPiecesBtn) {
      el.patternPiecesBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (typeof closeBoardToolbarMenus === 'function') closeBoardToolbarMenus(null, false);
        openPatternPiecesPanel();
      });
    }
    if (el.patternPiecesCloseBtn) el.patternPiecesCloseBtn.addEventListener('click', closePatternPiecesPanel);
    makeDraggablePanel(el.patternPiecesPanel, el.patternPiecesHead, '.anchor-panel-close');
  }
