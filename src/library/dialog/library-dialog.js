// Project Library pane: browse, reopen, and delete saved project snapshots.
// Source part for app.js. Run `npm run build` after editing.
//
// Every writeProjectFile() appends an entry to the IndexedDB-backed library
// in src/project/project-library.js. This pane has two internal sub-tabs:
//   - "By Style" (default): one card per styleId, aggregated counts +
//     evidence/meaning badges, "Open latest" or drill into saves.
//   - "By Save": flat list, every snapshot is its own row.
// Opening a snapshot reuses the existing loadProject() flow, so a re-save
// creates a new entry (append history), matching the user's chosen
// "keep history" behavior.
//
// US-107: this used to be its own openLibraryDialog() modal, reachable from
// File ▾ ▸ "Project Library…". It is now the Projects tab of the unified
// Library dialog (src/ui/dialogs/library-manager-dialog.js) — buildDialog()'s
// shell, wide-panel class, and footer/Close button all belong to that outer
// dialog now, so this function renders only its OWN content into a host
// container the tab switcher supplies, and reports back through callbacks
// instead of owning a `dialog` handle of its own.
//
// This is the stateful pane controller only (tabs, filter, refresh, the async
// open/delete/download handlers). The cross-view grouping/formatting helpers
// live in library-shared.js; the "By Save" flat-list rendering lives in
// library-list-view.js; the "By Style" card-grid rendering lives in
// library-grid-view.js.

  function buildProjectLibraryPane(host, { onOpened, onStatus } = {}) {
    host.innerHTML = '';
    host.className = 'dialog-body library-body';
    host.style.minWidth = '0';

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
    host.appendChild(tabs);

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
    host.appendChild(controls);

    const list = document.createElement('div');
    list.className = 'library-list';
    list.style.maxHeight = '54vh';
    list.style.overflowY = 'auto';
    list.style.border = '1px solid #ececf0';
    list.style.borderRadius = '8px';
    list.style.background = '#fafafa';
    host.appendChild(list);

    let entriesCache = [];
    let loaded = false;

    // Codex audit LIB-04, 2026-08-30: this summary used to repeat "No
    // projects saved yet." right next to the SAME message the grid/list body
    // already shows (renderStyleGridView / renderLibraryList's own empty
    // state, which — unlike this one — names the next action: "Save the
    // current board…"). Two messages saying the same thing left the ONE with
    // useful guidance no more prominent than its redundant neighbor. This
    // summary now stays terse ("0 saves") when empty, so the single message
    // with a next action is the body's.
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
          ? '0 saves'
          : styleCount + ' style' + (styleCount === 1 ? '' : 's')
            + '  ·  ' + filtered.length + ' save' + (filtered.length === 1 ? '' : 's');
      } else {
        renderLibraryList(list, filtered, {
          onOpen: handleOpen,
          onDelete: handleDelete,
          onDownload: handleDownload,
        });
        summary.textContent = entriesCache.length === 0
          ? '0 saves'
          : (filtered.length === entriesCache.length
              ? entriesCache.length + ' entr' + (entriesCache.length === 1 ? 'y' : 'ies')
              : filtered.length + ' of ' + entriesCache.length + ' shown');
      }
      if (typeof onStatus === 'function') onStatus(summary.textContent);
    }

    function handleViewSaves(styleId) {
      filterInput.value = styleId || '';
      setViewMode('save');
    }

    async function refresh() {
      loaded = true;
      summary.textContent = 'Loading…';
      if (typeof onStatus === 'function') onStatus(summary.textContent);
      try {
        entriesCache = await listLibraryEntries();
      } catch (err) {
        console.warn(err);
        entriesCache = [];
        summary.textContent = 'Could not read the library.';
        if (typeof onStatus === 'function') onStatus(summary.textContent);
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
        if (typeof onOpened === 'function') onOpened();
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

    setViewMode('style');
    filterInput.addEventListener('input', applyFilter);

    return {
      // Lazy: an IndexedDB round trip on every dialog open (regardless of
      // which tab a TD actually wants) is wasted work — refresh only the
      // first time this pane is actually shown.
      ensureLoaded() { if (!loaded) refresh(); },
      refresh,
      // Codex audit LIB-04, 2026-08-30: lets a host mirror this pane's own
      // status into a shared readout (the Library dialog's footer) without
      // forcing a fetch — ensureLoaded() is a no-op once loaded, so a host
      // that only called that on re-activation would otherwise show whatever
      // the LAST-active tab left behind.
      currentStatus() { return summary.textContent; },
    };
  }
