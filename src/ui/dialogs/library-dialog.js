// Project Library: browse, reopen, and delete saved project snapshots.
// Source part for app.js. Run `npm run build` after editing.
//
// Every writeProjectFile() appends an entry to the IndexedDB-backed library
// in src/project/project-library.js. This dialog has two tabs:
//   - "By Style" (default): one card per styleId, aggregated counts +
//     evidence/meaning badges, "Open latest" or drill into saves.
//   - "By Save": flat list, every snapshot is its own row.
// Opening a snapshot reuses the existing loadProject() flow, so a re-save
// creates a new entry (append history), matching the user's chosen
// "keep history" behavior.
//
// This is the stateful dialog controller only (tabs, filter, refresh, the
// async open/delete/download handlers). The cross-view grouping/formatting
// helpers live in library-shared.js; the "By Save" flat-list rendering lives
// in library-list-view.js; the "By Style" card-grid rendering lives in
// library-grid-view.js.

  function openLibraryDialog() {
    const dialog = buildDialog({
      title: 'Library',
      sub: 'Browse styles you have worked on. Every save is archived per style.',
    });
    // The default .dialog-panel is 560px wide; the library cards need more
    // room or their action buttons clip past the panel edge. ld-wide bumps
    // the shell to min(820px, 100%), and the body then just fills it.
    dialog.panel.classList.add('ld-wide');

    const body = document.createElement('div');
    body.className = 'dialog-body library-body';
    body.style.minWidth = '0';

    let viewMode = 'style';

    const tabs = document.createElement('div');
    tabs.className = 'library-tabs';
    tabs.style.display = 'flex';
    tabs.style.gap = '4px';
    tabs.style.marginBottom = '10px';
    tabs.style.borderBottom = '1px solid #e6e6ea';

    function makeTabBtn(label, onSelect) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.style.padding = '6px 14px';
      btn.style.background = 'transparent';
      btn.style.border = '0';
      btn.style.borderBottom = '2px solid transparent';
      btn.style.fontSize = '13px';
      btn.style.fontWeight = '600';
      btn.style.color = 'var(--muted)';
      btn.style.cursor = 'pointer';
      btn.style.marginBottom = '-1px';
      btn.addEventListener('click', onSelect);
      return btn;
    }
    const styleTabBtn = makeTabBtn('By Style', () => setViewMode('style'));
    const saveTabBtn = makeTabBtn('By Save', () => setViewMode('save'));
    tabs.appendChild(styleTabBtn);
    tabs.appendChild(saveTabBtn);
    body.appendChild(tabs);

    function setViewMode(mode) {
      if (mode !== 'style' && mode !== 'save') return;
      viewMode = mode;
      const active = mode === 'style' ? styleTabBtn : saveTabBtn;
      const inactive = mode === 'style' ? saveTabBtn : styleTabBtn;
      active.style.color = 'var(--text)';
      active.style.borderBottomColor = '#2563eb';
      inactive.style.color = 'var(--muted)';
      inactive.style.borderBottomColor = 'transparent';
      applyFilter();
    }

    const controls = document.createElement('div');
    controls.className = 'library-controls';
    controls.style.display = 'flex';
    controls.style.gap = '10px';
    controls.style.alignItems = 'center';
    controls.style.marginBottom = '8px';

    const filterInput = document.createElement('input');
    filterInput.type = 'search';
    filterInput.placeholder = 'Filter by style code…';
    filterInput.autocomplete = 'off';
    filterInput.spellcheck = false;
    filterInput.style.flex = '1';
    filterInput.style.padding = '6px 10px';
    filterInput.style.border = '1px solid #d4d4d8';
    filterInput.style.borderRadius = '6px';
    filterInput.style.fontSize = '13px';

    const summary = document.createElement('span');
    summary.className = 'library-summary';
    summary.style.fontSize = '12px';
    summary.style.color = 'var(--muted)';
    summary.textContent = 'Loading…';

    controls.appendChild(filterInput);
    controls.appendChild(summary);
    body.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'library-list';
    list.style.maxHeight = '60vh';
    list.style.overflowY = 'auto';
    list.style.border = '1px solid #ececf0';
    list.style.borderRadius = '8px';
    list.style.background = '#fafafa';
    body.appendChild(list);

    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'picker-btn primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', dialog.close);
    footer.appendChild(spacer);
    footer.appendChild(closeBtn);
    dialog.panel.appendChild(footer);

    let entriesCache = [];

    function applyFilter() {
      const q = filterInput.value.trim().toLowerCase();
      const filtered = q
        ? entriesCache.filter(e => (e.styleId || '').toLowerCase().includes(q))
        : entriesCache;
      if (viewMode === 'style') {
        renderStyleGridView(list, filtered, {
          onOpen: handleOpen,
          onViewSaves: handleViewSaves,
        });
        const styleCount = countDistinctStyles(filtered);
        summary.textContent = entriesCache.length === 0
          ? 'No projects saved yet.'
          : styleCount + ' style' + (styleCount === 1 ? '' : 's')
            + '  ·  ' + filtered.length + ' save' + (filtered.length === 1 ? '' : 's');
      } else {
        renderLibraryList(list, filtered, {
          onOpen: handleOpen,
          onDelete: handleDelete,
          onDownload: handleDownload,
        });
        summary.textContent = entriesCache.length === 0
          ? 'No projects saved yet.'
          : (filtered.length === entriesCache.length
              ? entriesCache.length + ' entr' + (entriesCache.length === 1 ? 'y' : 'ies')
              : filtered.length + ' of ' + entriesCache.length + ' shown');
      }
    }

    function handleViewSaves(styleId) {
      filterInput.value = styleId || '';
      setViewMode('save');
    }

    async function refresh() {
      summary.textContent = 'Loading…';
      try {
        entriesCache = await listLibraryEntries();
      } catch (err) {
        console.warn(err);
        entriesCache = [];
        summary.textContent = 'Could not read the library.';
        list.innerHTML = '';
        const error = document.createElement('div');
        error.style.padding = '16px';
        error.style.color = '#b91c1c';
        error.style.fontSize = '13px';
        error.textContent = String(err && err.message || err) || 'Library unavailable.';
        list.appendChild(error);
        return;
      }
      applyFilter();
    }

    async function handleOpen(entry) {
      const drafts = state.autoMode ? state.autoMode.draftAnnotations : null;
      if (state.appMode === 'auto' && drafts && drafts.length > 0) {
        const approvedCount = drafts.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
        const choice = await openAutoModeExitDialog({
          approvedCount,
          totalCount: drafts.length,
          reason: 'Opening a library entry will replace the board and clear the Auto Mode draft layer. Choose what to do with the drafts first:',
        });
        if (choice === 'apply') {
          const applied = applyApprovedDraftsAtomically();
          if (!applied) return;
          if (state.autoMode.draftAnnotations.length > 0) {
            showToast('Some drafts remain. Resolve them before opening another project.');
            return;
          }
        } else if (choice === 'discard') {
          discardAutoDrafts(true);
        } else {
          return;
        }
      } else if (typeof hasUnsavedWork === 'function'
        ? hasUnsavedWork()
        : (state.annotations.length || state.images.length)) {
        // US-092: ask hasUnsavedWork() rather than re-deriving "is there work
        // here" from two collections. This gate had drifted behind the one in
        // onProjectFileChosen (project-load.js) and silently replaced a board
        // holding only notes — or only BOM/Construction work — with no prompt.
        const ok = window.confirm('Open this project? Your current board will be replaced. Save it first if you want to keep it.');
        if (!ok) return;
      }
      let full;
      try {
        full = await getLibraryEntry(entry.id);
      } catch (err) {
        console.warn(err);
        showToast('Could not read that entry.', 4200);
        return;
      }
      if (!full || !full.snapshot) {
        showToast('That entry has no snapshot to open.', 4200);
        return;
      }
      try {
        await loadProject(full.snapshot);
        showToast('Project opened from library.');
        dialog.close();
      } catch (err) {
        console.error(err);
        showToast('Could not open that entry — saved with an older format.', 4200);
      }
    }

    async function handleDelete(entry) {
      const label = entry.styleId ? 'style "' + entry.styleId + '"' : 'this entry';
      if (!window.confirm('Delete the library entry for ' + label + ' (saved ' + formatLibraryDate(entry.savedAt) + ')?\nThis cannot be undone.')) return;
      try {
        await deleteLibraryEntry(entry.id);
      } catch (err) {
        console.warn(err);
        showToast('Could not delete that entry.', 4200);
        return;
      }
      showToast('Entry removed from library.');
      await refresh();
    }

    async function handleDownload(entry) {
      let full;
      try {
        full = await getLibraryEntry(entry.id);
      } catch (err) {
        console.warn(err);
        showToast('Could not read that entry.', 4200);
        return;
      }
      if (!full || !full.snapshot) {
        showToast('That entry has no snapshot to download.', 4200);
        return;
      }
      const blob = new Blob([JSON.stringify(full.snapshot)], { type: 'application/json' });
      const baseName = (full.styleId || 'project').replace(/[^A-Za-z0-9._-]+/g, '-') || 'project';
      const stamp = (full.savedAt || '').replace(/[^0-9]/g, '').slice(0, 14) || 'snapshot';
      downloadBlob(blob, 'bra-sketch-' + baseName + '-' + stamp + '.json');
    }

    dialog.open();
    setViewMode('style');
    filterInput.addEventListener('input', applyFilter);
    refresh();
  }
