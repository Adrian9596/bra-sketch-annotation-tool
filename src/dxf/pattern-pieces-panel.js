// ADR 0070: the Pattern Pieces panel — a floating, non-modal list of every
// templateGroupId group on the board (DXF-imported grading-nest pieces, and
// Template placements, since both share the same field), so the TD can tell
// apart a stack of overlapping same-position sizes and keep only the ones
// they want. Mirrors src/auto/ui/anchor-manager-panel.js's shape (floating panel,
// row-per-item, a Select action, plain DOM row-building), but the per-row
// action here is REMOVE, not hide: ADR 0067's research found no reliable way
// to auto-detect which size is "standard," so this is a manual, decisive
// choice, not a review-only toggle like the POM/anchor hide mechanisms —
// removed pieces are ordinary annotation deletions (undo-able via the normal
// history stack), not a new visibility flag layered onto rendering.
// Source part for app.js. Run `npm run build` after editing.

  // US-135 E2E defect 3: the group list the panel last drew, so a board change
  // that adds, removes or re-counts pieces (Undo/Redo, Delete, paste…) can
  // rebuild the rows — and every other refresh can skip the rebuild, which
  // would otherwise reset focus on each history step. Panel-local, never saved.
  let lastPatternPiecesFingerprint = null;
  // Which piece each row belongs to, kept OFF the DOM: the panel's markup is
  // part of the pre-Phase-C characterization (boundary-golden.json, dxf
  // chrome), and a data attribute per control would change it for nothing.
  const patternPieceRowGroup = new WeakMap();

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
      // US-124 Phase 3/4: what the DXF said about the piece and how it was
      // classified — display only; null for Template placements.
      const meta = (state.templateGroupMeta && state.templateGroupMeta[gid]) || null;
      return { groupId: gid, label, count: g.ids.length, ids: g.ids.slice(), meta };
    });
  }

  // One-line summary under a row's label: the ASTM annotation, then the
  // classification (outline / marks / dropped). Empty string when nothing is
  // known (a Template group).
  function patternPieceSubtitle(meta) {
    if (!meta) return '';
    const parts = [];
    // US-127 / ADR 0102: first, because it explains the whole board.
    if (meta.outOfScale) parts.push('out of scale — excluded from the fit');
    const ann = [meta.pieceName, meta.size, meta.quantity != null ? 'qty ' + meta.quantity : null].filter(Boolean).join(' · ');
    if (ann) parts.push(ann);
    if (meta.kind === 'legacy') {
      parts.push('legacy grouping');
    } else if (meta.classCounts) {
      const c = meta.classCounts;
      const bits = [];
      if (c.boundary) bits.push('outline ' + c.boundary);
      const internal = (c.internal || 0) + (c.sew || 0) + (c.cutout || 0);
      if (internal) bits.push('internal ' + internal);
      if (c.grain) bits.push('grain ' + c.grain);
      if (meta.notchChains) bits.push('notch ' + meta.notchChains);
      const dropped = (meta.dropped ? (meta.dropped.exact || 0) + (meta.dropped.qvTwin || 0) : 0);
      if (dropped) bits.push('−' + dropped + ' dup');
      if (bits.length) parts.push(bits.join(' · '));
    }
    return parts.join('  —  ');
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
    lastPatternPiecesFingerprint = null;
  }

  function patternPiecesFingerprint(groups) {
    return groups.map(g => String(g.groupId) + ':' + g.count + ':' + g.label).join('|');
  }

  // US-135 E2E defect 3: the panel used to rebuild only on open, Apply and
  // Simplify, so after Remove of 2 and Cmd+Z the board had 6 pieces and the
  // panel listed 4. history.js calls this after every committed change and
  // every Undo/Redo. It rebuilds only when the piece list itself changed, keeps
  // the TD's pending unchecks for pieces that still exist (a piece brought back
  // by Undo comes back checked), and puts keyboard focus back on the same
  // piece — or the row now in its place — when focus was in the list.
  function syncPatternPiecesPanelToBoard() {
    if (!isPatternPiecesPanelOpen() || !el.patternPiecesBody) return;
    const groups = patternPieceGroups();
    if (patternPiecesFingerprint(groups) === lastPatternPiecesFingerprint) return;
    const body = el.patternPiecesBody;
    const unchecked = new Set(Array.from(body.querySelectorAll('.pattern-piece-checkbox'))
      .filter(box => !box.checked).map(box => patternPieceRowGroup.get(box.closest('.pattern-piece-row'))));
    const keep = new Set(groups.filter(g => !unchecked.has(g.groupId)).map(g => g.groupId));
    const active = document.activeElement;
    const focusRow = active && body.contains(active) ? active.closest('.pattern-piece-row') : null;
    const focus = focusRow ? {
      groupId: patternPieceRowGroup.get(focusRow),
      column: ['pattern-piece-checkbox', 'pattern-piece-mini-btn'].find(c => active.classList.contains(c)) || 'pattern-piece-label',
      rowIndex: Array.from(body.querySelectorAll('.pattern-piece-row')).indexOf(focusRow),
    } : null;
    renderPatternPiecesPanel(keep);
    if (!focus || !isPatternPiecesPanelOpen()) return;
    const rows = Array.from(body.querySelectorAll('.pattern-piece-row'));
    const row = rows.find(r => patternPieceRowGroup.get(r) === focus.groupId)
      || rows[Math.min(Math.max(focus.rowIndex, 0), rows.length - 1)];
    const target = row && (row.querySelector('.' + focus.column) || row.querySelector('.pattern-piece-label'));
    if (target) target.focus();
  }

  // US-135 E2E defect 1: keys the open panel owns outright, the same contract
  // as an open toolbar menu (BOARD_MENU_OWNED_KEYS). Selecting a piece by its
  // name leaves the whole piece selected, so these keys reaching the board
  // router meant Tab cycled the nudge point instead of moving focus and the
  // arrows moved one point of one of the piece's lines. Tab keeps its native
  // focus order; the arrows walk the list (Up/Down/Home/End within a column,
  // Left/Right across a row's controls). Modifier chords (Cmd+Z…) and Escape
  // still reach their usual listeners; Space and Enter are not stopped here
  // because the board router lets a keyboard-focused button keep them.
  const PATTERN_PIECES_OWNED_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Tab'];

  function onPatternPiecesPanelKeyDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (!PATTERN_PIECES_OWNED_KEYS.includes(event.key)) return;
    event.stopPropagation();
    const target = event.target;
    if (event.key === 'Tab' || !target || target.tagName === 'SELECT') return;
    const row = target.closest('.pattern-piece-row');
    if (!row || !el.patternPiecesBody || !el.patternPiecesBody.contains(row)) return;
    const usable = node => !node.disabled && !node.hidden && node.getClientRects().length > 0;
    let next = null;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const controls = Array.from(row.querySelectorAll('input, button')).filter(usable);
      next = controls[controls.indexOf(target) + (event.key === 'ArrowRight' ? 1 : -1)] || null;
    } else {
      const column = ['pattern-piece-checkbox', 'pattern-piece-mini-btn'].find(c => target.classList.contains(c)) || 'pattern-piece-label';
      const items = Array.from(el.patternPiecesBody.querySelectorAll('.pattern-piece-row'))
        .map(r => r.querySelector('.' + column)).filter(node => node && usable(node));
      const i = items.indexOf(target);
      if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items[items.length - 1];
      else if (event.key === 'ArrowDown') next = items[Math.min(items.length - 1, i + 1)];
      else next = items[Math.max(0, i - 1)];
    }
    event.preventDefault();
    if (next && next !== target) {
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  }

  // Selects the group's annotations on the board so the existing multi-select
  // halo (render-loop.js) highlights exactly this outline among the stack —
  // reuses the click-a-group-member selection behavior already wired for
  // templateGroupId (src/board/input/selection.js), just triggered from the panel
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
    const removedIds = new Set();
    state.annotations = state.annotations.filter((ann) => {
      if (!kill.has(ann.templateGroupId)) return true;
      removedIds.add(ann.id);
      return false;
    });
    // findings-dxf.md Finding 9: a notch placed on a removed piece goes with it.
    removeNotchesOwnedBy(removedIds);
    if (state.templateGroupLabels) {
      for (const gid of kill) delete state.templateGroupLabels[gid];
    }
    if (state.templateGroupMeta) {
      for (const gid of kill) delete state.templateGroupMeta[gid];
    }
    if (state.selection && state.selection.kind === 'annotation'
        && !state.annotations.some(a => a.id === state.selection.id)) {
      state.selection = { kind: null, id: null };
    }
    const remaining = new Set(state.annotations.map(a => a.id));
    state.selectedAnnotationIds = (state.selectedAnnotationIds || []).filter(id => remaining.has(id));
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

  // Rebuilt on open and after Apply, and re-synced (syncPatternPiecesPanelToBoard)
  // after any history step that changes the piece list — not every generic
  // updateUI. Re-syncs pass the current keep set so they cannot reset pending
  // removals.
  // Phase 3 (ADR 0091, owner decision 2): the "keep quality curves" import
  // toggle lives in this panel because this is where a TD looks at what an
  // import produced. It applies to the NEXT import (nothing can be added back
  // to an already-placed pattern), and its label says so.
  function syncPatternPiecesImportOptions() {
    const box = document.getElementById('patternPiecesKeepQvChk');
    if (box) box.checked = !!(state.dxfImportOptions && state.dxfImportOptions.keepQualityCurves);
  }

  function renderPatternPiecesPanel(keptGroupIds) {
    const panel = el.patternPiecesPanel;
    const body = el.patternPiecesBody;
    if (!panel || !body) return;
    syncPatternPiecesImportOptions();
    const groups = patternPieceGroups();
    if (!groups.length) { closePatternPiecesPanel(); return; }
    lastPatternPiecesFingerprint = patternPiecesFingerprint(groups);
    if (el.patternPiecesCount) {
      el.patternPiecesCount.textContent = groups.length + (groups.length === 1 ? ' piece' : ' pieces');
    }
    body.innerHTML = '';
    const keep = new Set(groups.filter(g => !keptGroupIds || keptGroupIds.has(g.groupId)).map(g => g.groupId));
    const updateRemoveAction = () => {
      if (!el.patternPiecesApplyBtn) return;
      const count = groups.filter(g => !keep.has(g.groupId)).length;
      el.patternPiecesApplyBtn.disabled = !count;
      el.patternPiecesApplyBtn.textContent = count ? 'Remove unchecked (' + count + ')' : 'Remove unchecked';
    };
    updateRemoveAction();
    for (const g of groups) {
      const row = document.createElement('div');
      row.className = 'pattern-piece-row';
      patternPieceRowGroup.set(row, g.groupId);

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'pattern-piece-checkbox';
      box.checked = keep.has(g.groupId);
      box.setAttribute('aria-label', 'Keep ' + g.label);
      box.title = 'Uncheck to remove this piece from the board';
      box.addEventListener('change', () => {
        if (box.checked) keep.add(g.groupId); else keep.delete(g.groupId);
        updateRemoveAction();
      });
      row.appendChild(box);

      const labelWrap = document.createElement('div');
      labelWrap.className = 'pattern-piece-label-wrap';
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'pattern-piece-label';
      label.textContent = g.label;
      label.title = g.label + ' — click to select on the board';
      label.addEventListener('click', (e) => { e.stopPropagation(); selectPatternPieceGroup(g.ids); });
      labelWrap.appendChild(label);
      const summaryParts = g.meta
        ? [g.meta.size && 'Size ' + g.meta.size, g.meta.quantity != null && 'Qty ' + g.meta.quantity].filter(Boolean)
        : [];
      if (summaryParts.length) {
        const summary = document.createElement('span');
        summary.className = 'pattern-piece-summary';
        summary.textContent = summaryParts.join(' · ');
        labelWrap.appendChild(summary);
      }
      if (g.meta && g.meta.outOfScale) {
        const warning = document.createElement('span');
        warning.className = 'pattern-piece-summary pattern-piece-warning';
        warning.textContent = 'Out of scale — excluded from the fit';
        labelWrap.appendChild(warning);
      }
      if (g.meta && g.meta.orphan) {
        const badge = document.createElement('span');
        badge.className = 'pattern-piece-badge pattern-piece-badge-orphan';
        badge.textContent = 'orphan';
        badge.title = 'No outline in this block could claim these lines — check them before keeping';
        label.appendChild(badge);
      }
      const advanced = document.createElement('div');
      advanced.className = 'pattern-piece-advanced';
      const subtitle = patternPieceSubtitle(g.meta);
      if (subtitle) {
        const sub = document.createElement('span');
        sub.className = 'pattern-piece-sub';
        sub.textContent = subtitle;
        sub.title = subtitle;
        advanced.appendChild(sub);
      }
      row.appendChild(labelWrap);

      const count = document.createElement('span');
      count.className = 'pattern-piece-count';
      count.textContent = g.count + (g.count === 1 ? ' line' : ' lines');
      advanced.appendChild(count);

      // ADR 0072: merges redundant collinear points within this piece's
      // straight segments — same outline, fewer annotations. Re-renders
      // (not just updates the count span) because the merge changes which
      // annotation ids belong to this row's "Select" button.
      const simplifyBtn = patternPieceMiniBtn('Simplify', 'Merge redundant collinear points in this piece’s straight lines — same outline, fewer segments',
        () => {
          const result = simplifyPieceGroup(g.groupId);
          if (!result.chains) { showToast('Nothing to simplify — no redundant collinear points found.'); return; }
          pushHistoryIfChanged();
          if (typeof updateUI === 'function') updateUI();
          if (typeof requestRender === 'function') requestRender();
          showToast('Simplified ' + result.chains + (result.chains === 1 ? ' run' : ' runs')
            + ', removed ' + result.removed + (result.removed === 1 ? ' point.' : ' points.'));
          // pushHistoryIfChanged above already re-synced the rows (keeping
          // this panel's unchecks and the focused Simplify button); a second,
          // unconditional rebuild here would drop that focus again.
          syncPatternPiecesPanelToBoard();
        });
      advanced.appendChild(simplifyBtn);
      labelWrap.appendChild(advanced);
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
    if (el.patternPiecesPanel) el.patternPiecesPanel.addEventListener('keydown', onPatternPiecesPanelKeyDown);
    const keepQv = document.getElementById('patternPiecesKeepQvChk');
    if (keepQv) {
      keepQv.addEventListener('change', () => {
        if (!state.dxfImportOptions) state.dxfImportOptions = { keepQualityCurves: false };
        state.dxfImportOptions.keepQualityCurves = !!keepQv.checked;
        showToast(keepQv.checked
          ? 'Next DXF import keeps ASTM quality-curve twins (layers 84/85/87).'
          : 'Next DXF import drops ASTM quality-curve twins (default).');
      });
      syncPatternPiecesImportOptions();
    }
    makeDraggablePanel(el.patternPiecesPanel, el.patternPiecesHead, '.anchor-panel-close');
  }
