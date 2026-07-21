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
      } else if (state.annotations.length || state.images.length) {
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

  function renderLibraryList(container, entries, handlers) {
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.padding = '32px 16px';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '13px';
      empty.textContent = 'No projects saved yet. Use Save to archive the current board.';
      container.appendChild(empty);
      return;
    }
    const groups = groupLibraryEntriesByStyle(entries);
    groups.forEach(group => {
      const header = document.createElement('div');
      header.style.padding = '8px 12px';
      header.style.background = '#f1f1f4';
      header.style.borderTop = '1px solid #e6e6ea';
      header.style.borderBottom = '1px solid #e6e6ea';
      header.style.fontSize = '12px';
      header.style.fontWeight = '600';
      header.style.color = 'var(--text)';
      header.textContent = (group.styleId || '(no style code)')
        + '   ·   ' + group.entries.length + ' save' + (group.entries.length === 1 ? '' : 's');
      container.appendChild(header);
      group.entries.forEach(entry => {
        container.appendChild(buildLibraryRow(entry, handlers));
      });
    });
  }

  function groupLibraryEntriesByStyle(entries) {
    const byStyle = new Map();
    entries.forEach(entry => {
      const key = entry.styleId || '';
      if (!byStyle.has(key)) byStyle.set(key, []);
      byStyle.get(key).push(entry);
    });
    const groups = [];
    byStyle.forEach((items, styleId) => {
      items.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
      groups.push({ styleId, entries: items, latestSavedAt: items[0] ? items[0].savedAt : '' });
    });
    groups.sort((a, b) => {
      if (!a.styleId && b.styleId) return 1;
      if (a.styleId && !b.styleId) return -1;
      return (b.latestSavedAt || '').localeCompare(a.latestSavedAt || '');
    });
    return groups;
  }

  function buildLibraryRow(entry, handlers) {
    const row = document.createElement('div');
    row.className = 'library-row';
    row.style.display = 'flex';
    row.style.gap = '12px';
    row.style.alignItems = 'center';
    row.style.padding = '10px 12px';
    row.style.borderBottom = '1px solid #ececf0';
    row.style.background = '#fff';

    const thumb = document.createElement('div');
    thumb.style.width = '64px';
    thumb.style.height = '64px';
    thumb.style.flex = '0 0 64px';
    thumb.style.borderRadius = '6px';
    thumb.style.border = '1px solid #e0e0e6';
    thumb.style.background = '#f5f5f7 center/contain no-repeat';
    thumb.style.overflow = 'hidden';
    if (entry.thumbnailDataURL) {
      thumb.style.backgroundImage = 'url("' + entry.thumbnailDataURL.replace(/"/g, '%22') + '")';
    } else {
      thumb.style.display = 'flex';
      thumb.style.alignItems = 'center';
      thumb.style.justifyContent = 'center';
      thumb.style.color = '#9ca3af';
      thumb.style.fontSize = '11px';
      thumb.textContent = 'no image';
    }
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';

    const title = document.createElement('div');
    title.style.fontSize = '13px';
    title.style.fontWeight = '600';
    title.style.color = 'var(--text)';
    title.textContent = entry.styleId || '(no style code)';
    info.appendChild(title);

    const date = document.createElement('div');
    date.style.fontSize = '12px';
    date.style.color = 'var(--muted)';
    date.textContent = formatLibraryDate(entry.savedAt);
    info.appendChild(date);

    const counts = document.createElement('div');
    counts.style.fontSize = '11.5px';
    counts.style.color = 'var(--muted)';
    counts.style.marginTop = '2px';
    const parts = [];
    parts.push((entry.annotationCount || 0) + ' line' + (entry.annotationCount === 1 ? '' : 's'));
    parts.push((entry.imageCount || 0) + ' image' + (entry.imageCount === 1 ? '' : 's'));
    if (entry.confirmedPomCount) parts.push(entry.confirmedPomCount + ' confirmed POM' + (entry.confirmedPomCount === 1 ? '' : 's'));
    counts.textContent = parts.join('  ·  ');
    info.appendChild(counts);

    row.appendChild(info);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '6px';
    actions.style.flex = '0 0 auto';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'picker-btn primary';
    openBtn.textContent = 'Open';
    openBtn.style.fontSize = '12px';
    openBtn.style.padding = '5px 12px';
    openBtn.addEventListener('click', () => handlers.onOpen(entry));

    const downloadBtn = document.createElement('button');
    downloadBtn.type = 'button';
    downloadBtn.className = 'picker-btn';
    downloadBtn.textContent = 'JSON';
    downloadBtn.title = 'Download this snapshot as a .json file';
    downloadBtn.style.fontSize = '12px';
    downloadBtn.style.padding = '5px 10px';
    downloadBtn.addEventListener('click', () => handlers.onDownload(entry));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'picker-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.fontSize = '12px';
    deleteBtn.style.padding = '5px 10px';
    deleteBtn.style.color = '#b91c1c';
    deleteBtn.addEventListener('click', () => handlers.onDelete(entry));

    actions.appendChild(openBtn);
    actions.appendChild(downloadBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);

    return row;
  }

  function countDistinctStyles(entries) {
    const seen = new Set();
    entries.forEach(e => seen.add(e.styleId || ''));
    return seen.size;
  }

  function renderStyleGridView(container, entries, handlers) {
    container.innerHTML = '';
    if (!entries.length) {
      const empty = document.createElement('div');
      empty.style.padding = '32px 16px';
      empty.style.textAlign = 'center';
      empty.style.color = 'var(--muted)';
      empty.style.fontSize = '13px';
      empty.textContent = 'No styles yet. Save the current board to start building the library.';
      container.appendChild(empty);
      return;
    }
    const groups = groupLibraryEntriesByStyle(entries);
    groups.forEach(group => {
      container.appendChild(buildStyleCard(group, handlers));
    });
  }

  function styleMemoryBadges(styleId) {
    let evidenceCount = 0;
    let meaningCount = 0;
    if (styleId && typeof summarizeStyleEvidence === 'function') {
      try {
        const s = summarizeStyleEvidence(styleId);
        evidenceCount = (s && s.totalRecords) || 0;
      } catch (err) { /* memory store may be uninitialized in test contexts */ }
    }
    if (styleId && typeof listConfirmedMeanings === 'function') {
      try {
        meaningCount = (listConfirmedMeanings(styleId) || []).length;
      } catch (err) { /* same as above */ }
    }
    return { evidenceCount, meaningCount };
  }

  function buildStyleCard(group, handlers) {
    const styleId = group.styleId;
    const latest = group.entries[0] || null;
    const saveCount = group.entries.length;
    const totalLines = group.entries.reduce((sum, e) => sum + (e.annotationCount || 0), 0);
    const totalImages = group.entries.reduce((sum, e) => sum + (e.imageCount || 0), 0);
    const totalConfirmedPoms = group.entries.reduce((sum, e) => sum + (e.confirmedPomCount || 0), 0);
    const { evidenceCount, meaningCount } = styleMemoryBadges(styleId);

    const row = document.createElement('div');
    row.className = 'library-style-card';
    row.style.display = 'flex';
    row.style.gap = '14px';
    row.style.alignItems = 'stretch';
    row.style.padding = '12px 14px';
    row.style.borderBottom = '1px solid #ececf0';
    row.style.background = '#fff';

    const thumb = document.createElement('div');
    thumb.style.width = '88px';
    thumb.style.height = '88px';
    thumb.style.flex = '0 0 88px';
    thumb.style.borderRadius = '8px';
    thumb.style.border = '1px solid #e0e0e6';
    thumb.style.background = '#f5f5f7 center/contain no-repeat';
    thumb.style.overflow = 'hidden';
    const cover = latest && latest.thumbnailDataURL;
    if (cover) {
      thumb.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
    } else {
      thumb.style.display = 'flex';
      thumb.style.alignItems = 'center';
      thumb.style.justifyContent = 'center';
      thumb.style.color = '#9ca3af';
      thumb.style.fontSize = '11px';
      thumb.textContent = 'no image';
    }
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.style.flex = '1';
    info.style.minWidth = '0';
    info.style.display = 'flex';
    info.style.flexDirection = 'column';
    info.style.justifyContent = 'space-between';

    const title = document.createElement('div');
    title.style.fontSize = '14px';
    title.style.fontWeight = '600';
    title.style.color = 'var(--text)';
    title.textContent = styleId || '(no style code)';
    info.appendChild(title);

    const lastSeen = document.createElement('div');
    lastSeen.style.fontSize = '12px';
    lastSeen.style.color = 'var(--muted)';
    lastSeen.textContent = 'Last saved: ' + formatLibraryDate(latest && latest.savedAt);
    info.appendChild(lastSeen);

    const counts = document.createElement('div');
    counts.style.fontSize = '11.5px';
    counts.style.color = 'var(--muted)';
    const countParts = [
      saveCount + ' save' + (saveCount === 1 ? '' : 's'),
      totalLines + ' line' + (totalLines === 1 ? '' : 's'),
      totalImages + ' image' + (totalImages === 1 ? '' : 's'),
    ];
    if (totalConfirmedPoms) countParts.push(totalConfirmedPoms + ' confirmed POM' + (totalConfirmedPoms === 1 ? '' : 's'));
    counts.textContent = countParts.join('  ·  ');
    info.appendChild(counts);

    if (styleId && (evidenceCount > 0 || meaningCount > 0)) {
      const badges = document.createElement('div');
      badges.style.display = 'flex';
      badges.style.gap = '6px';
      badges.style.marginTop = '4px';
      badges.style.flexWrap = 'wrap';
      if (meaningCount > 0) badges.appendChild(buildBadge(meaningCount + ' meaning' + (meaningCount === 1 ? '' : 's'), '#dbeafe', '#1e40af'));
      if (evidenceCount > 0) badges.appendChild(buildBadge(evidenceCount + ' evidence', '#dcfce7', '#166534'));
      info.appendChild(badges);
    }
    row.appendChild(info);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexDirection = 'column';
    actions.style.gap = '6px';
    actions.style.justifyContent = 'center';
    actions.style.flex = '0 0 auto';

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'picker-btn primary';
    openBtn.textContent = 'Open latest';
    openBtn.style.fontSize = '12px';
    openBtn.style.padding = '5px 12px';
    openBtn.disabled = !latest;
    openBtn.addEventListener('click', () => {
      if (latest) handlers.onOpen(latest);
    });

    const viewSavesBtn = document.createElement('button');
    viewSavesBtn.type = 'button';
    viewSavesBtn.className = 'picker-btn';
    viewSavesBtn.textContent = saveCount > 1 ? 'View ' + saveCount + ' saves' : 'View saves';
    viewSavesBtn.style.fontSize = '12px';
    viewSavesBtn.style.padding = '5px 10px';
    viewSavesBtn.addEventListener('click', () => handlers.onViewSaves(styleId));

    actions.appendChild(openBtn);
    actions.appendChild(viewSavesBtn);
    row.appendChild(actions);

    return row;
  }

  function buildBadge(text, bg, fg) {
    const el = document.createElement('span');
    el.textContent = text;
    el.style.fontSize = '11px';
    el.style.fontWeight = '600';
    el.style.padding = '2px 8px';
    el.style.borderRadius = '999px';
    el.style.background = bg;
    el.style.color = fg;
    return el;
  }

  function formatLibraryDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + '  ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
