// US-106 + US-107: the unified Library dialog — one searchable, categorized
// place for everything a TD would call "the library": Templates (multi-path
// saved sketch geometry), Line Treatments (named looks and layered stitch
// recipes, src/manual/line-presets.js), and Projects (saved whole boards,
// IndexedDB-backed, src/project/project-library.js). Three tabs, one dialog,
// one toolbar entry point (#libraryBtn) — replacing the three separate,
// scattered entry points US-106 review found (Tools ▾ ▸ Templates, the
// Stitches ▸ Line Library section, and File ▾ ▸ "Project Library…").
//
// Every mutation still goes through the three owning model files — this file
// is presentation only, same split as src/ui/shape-stamp-panel.js and
// src/ui/line-preset-panel.js, which remain the board-selection-dependent
// quick actions (Save selection as Template…, Save as new treatment…,
// Customize selected…) that need a live board selection and so stay in the
// toolbar rather than move into this "browse what I've already saved" modal.
// ADR 0059 is unchanged: Templates and Line Treatments remain distinct domain
// objects sharing one browsing UI, not one merged concept.
// Source part for app.js. Run `npm run build` after editing.

  // A bigger, gallery-scaled rendering of the same idea as
  // shapeStampPreviewSvg (src/ui/shape-stamp-panel.js) — a separate function
  // rather than a shared one with a size parameter, because the two contexts
  // want different aspect ratios (a slim menu row vs a near-square card) and
  // forcing one function to serve both would smuggle a magic number through
  // an unrelated caller.
  function libraryCardPreviewSvg(stamp) {
    const w = 160, h = 108, pad = 10;
    const at = (p) => ({ x: pad + p.x * (w - pad * 2), y: pad + p.y * (h - pad * 2) });
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
    return '<svg class="lm-card-preview" viewBox="0 0 ' + w + ' ' + h + '" fill="none" '
      + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
      + 'stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }

  function libraryManagerFormatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
  }

  // ---- Shared: one floating "..." menu for the whole dialog -----------------
  //
  // Appended to document.body and positioned in JS from the trigger button's
  // own viewport rect (position:fixed) rather than living as an absolutely-
  // positioned child of a card — a card near the top of an independently
  // scrolling grid has no room to open a menu ABOVE it without the grid's own
  // overflow clipping it; anchoring to the viewport avoids that clip entirely
  // and lets the menu flip above/below based on real available space. One
  // instance serves every menu trigger in the dialog (card menus in both
  // library tabs, and each tab's top-row "Import / Export" menu) since only
  // one such menu can ever be open at a time regardless of which tab is
  // active.
  function createLibraryFloatingMenu(dialog) {
    let floatingMenu = null;
    let activeAnchor = null;

    function close() {
      if (!floatingMenu) return;
      floatingMenu.remove();
      floatingMenu = null;
      if (activeAnchor) activeAnchor.setAttribute('aria-expanded', 'false');
      activeAnchor = null;
    }

    function open(anchorBtn, actions, onAction) {
      close();
      const menu = document.createElement('div');
      menu.className = 'lm-card-menu';
      menu.innerHTML = actions
        .map(([action, label]) => '<button type="button" data-menu-action="' + action + '">' + escapeHtml(label) + '</button>')
        .join('');
      document.body.appendChild(menu);
      const anchorRect = anchorBtn.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const openUpward = window.innerHeight - anchorRect.bottom < menuRect.height + 8 && anchorRect.top > menuRect.height + 8;
      menu.style.left = Math.max(8, Math.min(anchorRect.right - menuRect.width, window.innerWidth - menuRect.width - 8)) + 'px';
      menu.style.top = (openUpward ? anchorRect.top - menuRect.height - 4 : anchorRect.bottom + 4) + 'px';
      menu.addEventListener('click', (event) => {
        const btn = event.target.closest('[data-menu-action]');
        if (!btn) return;
        const action = btn.dataset.menuAction;
        close();
        onAction(action);
      });
      floatingMenu = menu;
      activeAnchor = anchorBtn;
      anchorBtn.setAttribute('aria-expanded', 'true');
    }

    function isOpenForAnchor(anchorBtn) {
      return !!floatingMenu && activeAnchor === anchorBtn;
    }

    document.addEventListener('click', function onOutsideClick(event) {
      if (!dialog.overlay.isConnected) { document.removeEventListener('click', onOutsideClick); return; }
      if (!floatingMenu) return;
      if (event.target.closest('.lm-card-menu')) return;
      if (activeAnchor && activeAnchor.contains(event.target)) return;
      close();
    });

    return { open, close, isOpenForAnchor };
  }

  // ---- Templates tab ---------------------------------------------------------

  function libraryManagerMatchesQuery(stamp, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    if (stamp.name.toLowerCase().includes(q)) return true;
    if (libraryCategoryLabel(stamp.category).toLowerCase().includes(q)) return true;
    if ((stamp.notes || '').toLowerCase().includes(q)) return true;
    return (stamp.tags || []).some(tag => tag.includes(q));
  }

  const LIBRARY_RAIL_RECENT_MAX = 12;

  function libraryManagerFilteredEntries(all, rail, query) {
    let list = all;
    if (rail === 'favorites') list = list.filter(s => s.favorite);
    else if (rail === 'recent') {
      list = list.filter(s => s.usage && s.usage.lastUsedAt)
        .slice()
        .sort((a, b) => (b.usage.lastUsedAt || '').localeCompare(a.usage.lastUsedAt || ''))
        .slice(0, LIBRARY_RAIL_RECENT_MAX);
    } else if (rail !== 'all') {
      list = list.filter(s => s.category === rail);
    }
    return list.filter(stamp => libraryManagerMatchesQuery(stamp, query));
  }

  function libraryManagerRailCounts(all) {
    const counts = { all: all.length, favorites: 0, recent: 0 };
    for (const c of libraryCategories()) counts[c.id] = 0;
    for (const stamp of all) {
      if (stamp.favorite) counts.favorites += 1;
      if (stamp.usage && stamp.usage.lastUsedAt) counts.recent += 1;
      if (Object.prototype.hasOwnProperty.call(counts, stamp.category)) counts[stamp.category] += 1;
    }
    counts.recent = Math.min(counts.recent, LIBRARY_RAIL_RECENT_MAX);
    return counts;
  }

  // ---- Edit-details sub-dialog (category / tags / notes) -----------------

  function openTemplateDetailsDialog(stamp, onSaved) {
    const dialog = buildDialog({ title: 'Edit Template details', sub: stamp.name });
    const body = document.createElement('div');
    body.className = 'scale-body lm-details-body';

    const categoryField = document.createElement('div');
    categoryField.className = 'scale-field';
    const categoryLabel = document.createElement('label');
    categoryLabel.textContent = 'Category';
    const categorySelect = document.createElement('select');
    categorySelect.setAttribute('aria-label', 'Category');
    for (const c of libraryCategories()) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.label;
      if (c.id === stamp.category) opt.selected = true;
      categorySelect.appendChild(opt);
    }
    categoryField.appendChild(categoryLabel);
    categoryField.appendChild(categorySelect);

    const tagsField = document.createElement('div');
    tagsField.className = 'scale-field';
    const tagsLabel = document.createElement('label');
    tagsLabel.textContent = 'Tags (comma-separated)';
    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.maxLength = 200;
    tagsInput.value = (stamp.tags || []).join(', ');
    tagsInput.setAttribute('aria-label', 'Tags');
    tagsField.appendChild(tagsLabel);
    tagsField.appendChild(tagsInput);

    const notesField = document.createElement('div');
    notesField.className = 'scale-field';
    const notesLabel = document.createElement('label');
    notesLabel.textContent = 'Notes';
    const notesInput = document.createElement('textarea');
    notesInput.maxLength = 240;
    notesInput.rows = 3;
    notesInput.value = stamp.notes || '';
    notesInput.setAttribute('aria-label', 'Notes');
    notesField.appendChild(notesLabel);
    notesField.appendChild(notesInput);

    body.appendChild(categoryField);
    body.appendChild(tagsField);
    body.appendChild(notesField);
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'picker-btn primary';
    saveBtn.textContent = 'Save';
    footer.appendChild(spacer);
    footer.appendChild(cancelBtn);
    footer.appendChild(saveBtn);
    dialog.panel.appendChild(footer);

    cancelBtn.addEventListener('click', dialog.close);
    saveBtn.addEventListener('click', () => {
      setShapeStampCategory(stamp.id, categorySelect.value);
      setShapeStampTags(stamp.id, tagsInput.value.split(','));
      setShapeStampNotes(stamp.id, notesInput.value);
      dialog.close();
      onSaved();
    });
    dialog.open();
    categorySelect.focus();
  }

  function buildTemplatesTab(panel, outerDialog, floatingMenu, setCount, registerCleanup) {
    const topRow = document.createElement('div');
    topRow.className = 'lm-top-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search name, tag, or note…';
    searchInput.className = 'lm-search';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'picker-btn';
    saveBtn.textContent = 'Save selection as Template…';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'picker-btn';
    moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.textContent = 'Import / Export ▾';
    topRow.appendChild(searchInput);
    topRow.appendChild(saveBtn);
    topRow.appendChild(moreBtn);
    panel.appendChild(topRow);

    const content = document.createElement('div');
    content.className = 'lm-content';
    const rail = document.createElement('div');
    rail.className = 'lm-rail';
    // Codex audit LIB-01, 2026-08-30: this rail is a FILTER (All/Favorites/
    // Recent/category), not a set of tabs each owning its own tabpanel — it
    // used to claim role="tab"/aria-selected, which promised keyboard/AT
    // behavior (arrow-key roving, a tab->tabpanel relationship) it never had.
    // A pressed-button group is the honest semantics for "one of several
    // toggles that narrows the same grid".
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Filter Templates by category');
    const grid = document.createElement('div');
    grid.className = 'picker-grid lm-grid';
    content.appendChild(rail);
    content.appendChild(grid);
    panel.appendChild(content);

    let activeRail = 'all';

    function railItems() {
      return [
        { id: 'all', label: 'All' },
        { id: 'favorites', label: '★ Favorites' },
        { id: 'recent', label: 'Recent' },
        ...libraryCategories(),
      ];
    }

    function renderRail() {
      const all = getShapeStamps();
      const counts = libraryManagerRailCounts(all);
      rail.innerHTML = railItems().map(item => {
        const active = item.id === activeRail ? ' lm-rail-active' : '';
        return '<button type="button" class="lm-rail-btn' + active + '" data-rail="' + escapeHtml(item.id) + '" '
          + 'aria-pressed="' + (item.id === activeRail) + '">'
          + escapeHtml(item.label) + ' <span class="lm-rail-count">' + (counts[item.id] || 0) + '</span></button>';
      }).join('');
    }

    // Codex audit LIB-02, 2026-08-30: this CTA used to stay enabled with
    // nothing to save, so clicking it only ever produced a rejection toast
    // ("Select one or more lines…"). Disabling it — with the SAME reason
    // exposed as both a hover tooltip and an accessible name — tells the TD
    // up front instead of after a click, and the reason string here is the
    // exact one canSaveShapeStampReason() would otherwise hand to showToast.
    function updateSaveButtonState() {
      const reason = canSaveShapeStampReason();
      const ok = reason === true;
      saveBtn.disabled = !ok;
      saveBtn.title = ok ? '' : reason;
      if (ok) saveBtn.removeAttribute('aria-label');
      else saveBtn.setAttribute('aria-label', 'Save selection as Template… — ' + reason);
    }

    function renderGrid() {
      const all = getShapeStamps();
      const filtered = libraryManagerFilteredEntries(all, activeRail, searchInput.value.trim());
      setCount(all.length === 0
        ? 'No Templates yet.'
        : (filtered.length === all.length
          ? all.length + ' Template' + (all.length === 1 ? '' : 's')
          : filtered.length + ' of ' + all.length + ' shown'));
      if (!filtered.length) {
        grid.innerHTML = '<div class="lm-empty">'
          + (all.length === 0
            ? 'No Templates saved yet. Select one or more paths on the Board, then '
              + '"Save selection as Template…" above.'
            : 'Nothing matches this filter.')
          + '</div>';
        return;
      }
      grid.innerHTML = filtered.map(stamp => {
        const tagChips = (stamp.tags || []).map(t => '<span class="lm-tag">' + escapeHtml(t) + '</span>').join('');
        const memberCount = Array.isArray(stamp.members) ? stamp.members.length : 1;
        const usageNote = stamp.usage && stamp.usage.count
          ? ('Used ' + stamp.usage.count + '×' + (stamp.usage.lastUsedAt ? ' · last ' + libraryManagerFormatDate(stamp.usage.lastUsedAt) : ''))
          : 'Not placed yet';
        return '<div class="picker-cell lm-card" data-stamp-id="' + escapeHtml(stamp.id) + '">'
          + '<button type="button" class="lm-fav' + (stamp.favorite ? ' lm-fav-on' : '') + '" '
          + 'data-card-action="favorite" aria-pressed="' + !!stamp.favorite + '" '
          + 'aria-label="' + (stamp.favorite ? 'Remove from favorites' : 'Add to favorites') + '" title="Favorite">'
          + (stamp.favorite ? '★' : '☆') + '</button>'
          + '<button type="button" class="lm-place-hit" data-card-action="place" '
          + 'title="' + escapeHtml('Place "' + stamp.name + '" — ' + memberCount + ' path' + (memberCount === 1 ? '' : 's') + ', ' + usageNote) + '">'
          + '<div class="picker-thumb lm-thumb">' + libraryCardPreviewSvg(stamp) + '</div>'
          + '<div class="picker-cap">' + escapeHtml(stamp.name) + '</div>'
          + '</button>'
          + '<div class="lm-card-meta">'
          + '<span class="lm-category-chip">' + escapeHtml(libraryCategoryLabel(stamp.category)) + '</span>'
          + tagChips
          + '</div>'
          + '<button type="button" class="lm-more" data-card-action="menu" aria-haspopup="true" '
          + 'aria-expanded="false" aria-label="More actions for ' + escapeHtml(stamp.name) + '">⋯</button>'
          + '</div>';
      }).join('');
    }

    function refresh() {
      floatingMenu.close();
      renderRail();
      renderGrid();
      updateSaveButtonState();
    }

    rail.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-rail]');
      if (!btn) return;
      activeRail = btn.dataset.rail;
      refresh();
    });

    searchInput.addEventListener('input', () => { floatingMenu.close(); renderGrid(); });

    // The disabled state above already keeps a no-selection click from firing
    // in the real UI; this guard stays as a defensive no-op (a disabled
    // button does not dispatch click in any real browser) rather than a live
    // path, so a stray programmatic .click() still cannot save nothing.
    saveBtn.addEventListener('click', () => {
      const reason = canSaveShapeStampReason();
      if (reason !== true) { showToast(reason); return; }
      const targets = shapeStampSaveTargets();
      const kind = targets.length > 1 ? `${targets.length} selected paths` : (targets[0].type === 'curved' ? 'Curve' : 'Straight line');
      openLinePresetNameDialog({
        title: 'Save Template',
        sub: `${kind}, including Scratch Area paths outside the sketch. Set category and tags afterward from the Library.`,
        value: '',
        confirmLabel: 'Save Template',
        onConfirm: (name) => {
          const stamp = addShapeStampFromSelection(name, activeRail !== 'all' && activeRail !== 'favorites' && activeRail !== 'recent'
            ? { category: activeRail } : null);
          if (!stamp) { showToast('Could not save that Template.'); return; }
          refresh();
          showToast(shapeStampsPersisted()
            ? `Saved "${stamp.name}".`
            : `Saved "${stamp.name}" (this session only — the browser refused to store it).`);
        },
      });
    });

    function moreMenuActions() {
      const actions = [['export-all', 'Export all as JSON'], ['import', 'Import JSON…']];
      const pending = getPendingProjectShapeStamps().length;
      if (pending > 0) actions.push(['import-project', `Import ${pending} shape${pending > 1 ? 's' : ''} from project`]);
      return actions;
    }

    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (floatingMenu.isOpenForAnchor(moreBtn)) { floatingMenu.close(); return; }
      floatingMenu.open(moreBtn, moreMenuActions(), (action) => {
        if (action === 'export-all') { exportShapeStampsFile(); return; }
        if (action === 'import') { el.shapeStampFileInput.click(); return; }
        if (action === 'import-project') {
          const added = importPendingProjectShapeStamps();
          refresh();
          if (!added) { showToast('Nothing to import.'); return; }
          showToast(`Imported ${added} shape${added > 1 ? 's' : ''} from the project.`);
        }
      });
    });

    function onFileInputChange(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const added = importShapeStampsFromJson(String(reader.result || ''));
        refresh();
        if (!added) { showToast('That file held no Templates.'); return; }
        showToast(shapeStampsPersisted()
          ? `Imported ${added} Template${added > 1 ? 's' : ''}.`
          : `Imported ${added} Template${added > 1 ? 's' : ''} (this session only — the browser refused to store it).`);
      };
      reader.onerror = () => showToast('Could not read that file.');
      reader.readAsText(file);
    }
    if (el.shapeStampFileInput) {
      el.shapeStampFileInput.addEventListener('change', onFileInputChange);
      registerCleanup(() => el.shapeStampFileInput.removeEventListener('change', onFileInputChange));
    }

    function handleCardAction(id, act) {
      const stamp = getShapeStampById(id);
      if (!stamp) return;
      if (act === 'favorite') {
        toggleShapeStampFavorite(id);
        refresh();
        return;
      }
      if (act === 'place' || act === 'place-mirrored') {
        floatingMenu.close();
        armShapeStampForPlacement(id, { mirrored: act === 'place-mirrored' });
        closeBoardToolbarMenus(null, false);
        outerDialog.close();
        showToast(`Drag to place${act === 'place-mirrored' ? ' (mirrored)' : ''} Template "${stamp.name}". Shift keeps its proportions; a plain click places it at its saved size.`);
        return;
      }
      if (act === 'rename') {
        floatingMenu.close();
        openLinePresetNameDialog({
          title: 'Rename Template', sub: stamp.name, value: stamp.name, confirmLabel: 'Rename',
          onConfirm: (name) => { renameShapeStamp(id, name); refresh(); },
        });
        return;
      }
      if (act === 'details') {
        floatingMenu.close();
        openTemplateDetailsDialog(stamp, refresh);
        return;
      }
      if (act === 'duplicate') {
        const copy = duplicateShapeStamp(id);
        refresh();
        if (copy) showToast(`Duplicated as "${copy.name}".`);
        return;
      }
      if (act === 'export') {
        exportOneShapeStampFile(id);
        refresh();
        return;
      }
      if (act === 'delete') {
        floatingMenu.close();
        if (window.confirm(`Delete Template "${stamp.name}"? This cannot be undone.`)) {
          deleteShapeStamp(id);
        }
        refresh();
        return;
      }
    }

    const CARD_MENU_ACTIONS = [
      ['place-mirrored', 'Place mirrored'],
      ['rename', 'Rename…'],
      ['details', 'Edit category / tags / notes…'],
      ['duplicate', 'Duplicate'],
      ['export', 'Export this Template…'],
      ['delete', 'Delete…'],
    ];

    grid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-stamp-id]');
      if (!card) return;
      const menuBtn = event.target.closest('[data-card-action="menu"]');
      if (menuBtn) {
        event.stopPropagation();
        if (floatingMenu.isOpenForAnchor(menuBtn)) { floatingMenu.close(); return; }
        floatingMenu.open(menuBtn, CARD_MENU_ACTIONS, (action) => handleCardAction(card.dataset.stampId, action));
        return;
      }
      const action = event.target.closest('[data-card-action]');
      if (!action) return;
      event.stopPropagation();
      handleCardAction(card.dataset.stampId, action.dataset.cardAction);
    });

    // A scroll inside the grid invalidates the menu's viewport-anchored
    // position (it does not move with the card it points at) — treat it the
    // same as an outside click rather than let it visibly drift.
    grid.addEventListener('scroll', () => floatingMenu.close());

    return {
      activate() { refresh(); searchInput.focus(); },
    };
  }

  // ---- Treatments tab ---------------------------------------------------

  function treatmentRailItems() {
    return [
      { id: 'all', label: 'All' },
      { id: 'treatment', label: 'Treatments' },
      { id: 'look', label: 'Looks' },
    ];
  }

  function treatmentRailCounts(all) {
    const counts = { all: all.length, treatment: 0, look: 0 };
    for (const preset of all) counts[preset.kind === 'treatment' ? 'treatment' : 'look'] += 1;
    return counts;
  }

  function treatmentManagerFilteredEntries(all, rail, query) {
    let list = all;
    if (rail === 'treatment' || rail === 'look') list = list.filter(preset => (preset.kind === 'treatment' ? 'treatment' : 'look') === rail);
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(preset => preset.name.toLowerCase().includes(q));
    }
    return list;
  }

  function buildTreatmentsTab(panel, outerDialog, floatingMenu, setCount, registerCleanup) {
    const topRow = document.createElement('div');
    topRow.className = 'lm-top-row';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search name…';
    searchInput.className = 'lm-search';
    searchInput.autocomplete = 'off';
    searchInput.spellcheck = false;
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'picker-btn';
    saveBtn.textContent = 'Save selection as Treatment…';
    const moreBtn = document.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'picker-btn';
    moreBtn.setAttribute('aria-haspopup', 'true');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.textContent = 'Import / Export ▾';
    topRow.appendChild(searchInput);
    topRow.appendChild(saveBtn);
    topRow.appendChild(moreBtn);
    panel.appendChild(topRow);

    const content = document.createElement('div');
    content.className = 'lm-content';
    const rail = document.createElement('div');
    rail.className = 'lm-rail';
    // Codex audit LIB-01, 2026-08-30: see the matching comment in
    // buildTemplatesTab — this is a filter, not an independent tabpanel.
    rail.setAttribute('role', 'group');
    rail.setAttribute('aria-label', 'Filter Treatments by kind');
    const grid = document.createElement('div');
    grid.className = 'picker-grid lm-grid';
    content.appendChild(rail);
    content.appendChild(grid);
    panel.appendChild(content);

    let activeRail = 'all';

    function renderRail() {
      const all = getLinePresets();
      const counts = treatmentRailCounts(all);
      rail.innerHTML = treatmentRailItems().map(item => {
        const active = item.id === activeRail ? ' lm-rail-active' : '';
        return '<button type="button" class="lm-rail-btn' + active + '" data-rail="' + escapeHtml(item.id) + '" '
          + 'aria-pressed="' + (item.id === activeRail) + '">'
          + escapeHtml(item.label) + ' <span class="lm-rail-count">' + (counts[item.id] || 0) + '</span></button>';
      }).join('');
    }

    // Codex audit LIB-02, 2026-08-30: saveSelectedTreatmentToLibrary() has
    // always branched — a selected path saves a Treatment, nothing selected
    // saves a Look (the backward-compatible escape hatch) — but the button
    // kept one static "Save selection as Treatment…" label regardless, so
    // the no-selection branch told the TD one thing and did another. The
    // label now says which branch is about to run.
    function updateSaveButtonLabel() {
      const hasSelection = typeof getSelectedAnnotation === 'function' && !!getSelectedAnnotation();
      saveBtn.textContent = hasSelection ? 'Save selected path as Treatment…' : 'Save current Line Look…';
    }

    function renderGrid() {
      const all = getLinePresets();
      const filtered = treatmentManagerFilteredEntries(all, activeRail, searchInput.value.trim());
      setCount(all.length === 0
        ? 'No Treatments yet.'
        : (filtered.length === all.length
          ? all.length + (all.length === 1 ? ' entry' : ' entries')
          : filtered.length + ' of ' + all.length + ' shown'));
      if (!filtered.length) {
        grid.innerHTML = '<div class="lm-empty">'
          + (all.length === 0
            ? 'No Treatments saved yet.'
            : 'Nothing matches this filter.')
          + '</div>';
        return;
      }
      grid.innerHTML = filtered.map(preset => {
        const kindLabel = preset.kind === 'treatment' ? 'Treatment' : 'Look';
        return '<div class="picker-cell lm-card" data-preset-id="' + escapeHtml(preset.id) + '">'
          + '<button type="button" class="lm-place-hit" data-card-action="apply" '
          + 'title="' + escapeHtml(linePresetRowTitle(preset)) + '">'
          + '<div class="picker-thumb lm-thumb">' + lineTreatmentPreviewSvg(preset) + '</div>'
          + '<div class="picker-cap">' + escapeHtml(preset.name) + '</div>'
          + '</button>'
          + '<div class="lm-card-meta">'
          + '<span class="lm-category-chip">' + kindLabel + '</span>'
          + (preset.builtin ? '<span class="lm-tag">Built-in</span>' : '')
          + '</div>'
          + '<button type="button" class="lm-more" data-card-action="menu" aria-haspopup="true" '
          + 'aria-expanded="false" aria-label="More actions for ' + escapeHtml(preset.name) + '">⋯</button>'
          + '</div>';
      }).join('');
    }

    function refresh() {
      floatingMenu.close();
      renderRail();
      renderGrid();
      updateSaveButtonLabel();
    }

    rail.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-rail]');
      if (!btn) return;
      activeRail = btn.dataset.rail;
      refresh();
    });

    searchInput.addEventListener('input', () => { floatingMenu.close(); renderGrid(); });

    saveBtn.addEventListener('click', () => {
      saveSelectedTreatmentToLibrary();
      refresh();
    });

    function moreMenuActions() {
      const actions = [['export-all', 'Export all as JSON'], ['import', 'Import JSON…']];
      const pending = getPendingProjectLinePresets().length;
      if (pending > 0) actions.push(['import-project', `Import ${pending} preset${pending > 1 ? 's' : ''} from project`]);
      actions.push(['reset', 'Reset to built-in set']);
      return actions;
    }

    moreBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (floatingMenu.isOpenForAnchor(moreBtn)) { floatingMenu.close(); return; }
      floatingMenu.open(moreBtn, moreMenuActions(), (action) => {
        if (action === 'export-all') { exportLinePresetsFile(); return; }
        if (action === 'import') { el.linePresetFileInput.click(); return; }
        if (action === 'import-project') {
          const added = importPendingProjectLinePresets();
          refresh();
          if (!added) { showToast('Nothing to import.'); return; }
          linePresetToast(`Imported ${added} preset${added > 1 ? 's' : ''} from the project.`);
          return;
        }
        if (action === 'reset') {
          resetLinePresetsToBuiltins();
          refresh();
          linePresetToast('Line Treatments reset to the built-in set.');
        }
      });
    });

    function onFileInputChange(event) {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const added = importLinePresetsFromJson(String(reader.result || ''));
        refresh();
        if (!added) { showToast('That file held no line presets.'); return; }
        linePresetToast(`Imported ${added} preset${added > 1 ? 's' : ''}.`);
      };
      reader.onerror = () => showToast('Could not read that file.');
      reader.readAsText(file);
    }
    if (el.linePresetFileInput) {
      el.linePresetFileInput.addEventListener('change', onFileInputChange);
      registerCleanup(() => el.linePresetFileInput.removeEventListener('change', onFileInputChange));
    }

    function handleCardAction(id, act) {
      const preset = getLinePresetById(id);
      if (!preset) return;
      if (act === 'apply') {
        floatingMenu.close();
        const applied = applyLinePreset(id);
        if (applied) outerDialog.close();
        return;
      }
      if (act === 'rename') {
        floatingMenu.close();
        openLinePresetNameDialog({
          title: 'Rename', sub: preset.name, value: preset.name, confirmLabel: 'Rename',
          onConfirm: (name) => { renameLinePreset(id, name); refresh(); },
        });
        return;
      }
      if (act === 'edit' && preset.treatment) {
        floatingMenu.close();
        openLineTreatmentEditor({
          title: 'Update Library Treatment', name: preset.name, recipe: preset.treatment,
          confirmLabel: 'Update treatment',
          onConfirm: next => {
            updateLineTreatment(id, next, next.name);
            refresh();
            showToast(`Updated "${next.name}". Existing drawings were not changed.`);
          },
        });
        return;
      }
      if (act === 'duplicate') {
        const copy = duplicateLinePreset(id);
        refresh();
        if (copy) linePresetToast(`Duplicated as "${copy.name}".`);
        return;
      }
      if (act === 'export') {
        exportOneLinePreset(id);
        refresh();
        return;
      }
      if (act === 'delete') {
        floatingMenu.close();
        if (window.confirm(`Delete "${preset.name}"? This cannot be undone.`)) {
          deleteLinePreset(id);
          linePresetToast(`Deleted "${preset.name}".`);
        }
        refresh();
        return;
      }
    }

    function cardMenuActionsFor(preset) {
      const actions = [['rename', 'Rename…']];
      if (preset.kind === 'treatment') actions.push(['edit', 'Edit layers…']);
      actions.push(['duplicate', 'Duplicate'], ['export', 'Export this…'], ['delete', 'Delete…']);
      return actions;
    }

    grid.addEventListener('click', (event) => {
      const card = event.target.closest('[data-preset-id]');
      if (!card) return;
      const menuBtn = event.target.closest('[data-card-action="menu"]');
      if (menuBtn) {
        event.stopPropagation();
        if (floatingMenu.isOpenForAnchor(menuBtn)) { floatingMenu.close(); return; }
        const preset = getLinePresetById(card.dataset.presetId);
        if (!preset) return;
        floatingMenu.open(menuBtn, cardMenuActionsFor(preset), (action) => handleCardAction(card.dataset.presetId, action));
        return;
      }
      const action = event.target.closest('[data-card-action]');
      if (!action) return;
      event.stopPropagation();
      handleCardAction(card.dataset.presetId, action.dataset.cardAction);
    });

    grid.addEventListener('scroll', () => floatingMenu.close());

    return {
      activate() { refresh(); searchInput.focus(); },
    };
  }

  // ---- The unified dialog ------------------------------------------------

  function openLibraryManagerDialog(opts) {
    const dialog = buildDialog({
      title: 'Library',
      sub: 'Templates, Line Treatments, and saved Projects — search, organize, and reuse your work.',
    });
    dialog.panel.classList.add('lm-wide');

    const body = document.createElement('div');
    body.className = 'dialog-body lm-body';

    const tabStrip = document.createElement('div');
    tabStrip.className = 'lm-tabs';
    tabStrip.setAttribute('role', 'tablist');
    body.appendChild(tabStrip);

    const panels = document.createElement('div');
    panels.className = 'lm-panels';
    body.appendChild(panels);
    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const count = document.createElement('span');
    count.className = 'picker-count';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'picker-btn primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', dialog.close);
    footer.appendChild(count);
    footer.appendChild(spacer);
    footer.appendChild(closeBtn);
    dialog.panel.appendChild(footer);

    const cleanupFns = [];
    function registerCleanup(fn) { cleanupFns.push(fn); }
    new MutationObserver((mutations, observer) => {
      if (dialog.overlay.isConnected) return;
      for (const fn of cleanupFns) { try { fn(); } catch (_) { /* best-effort */ } }
      observer.disconnect();
    }).observe(document.body, { childList: true });

    const floatingMenu = createLibraryFloatingMenu(dialog);
    // The floating menu's own outside-click listener only notices the dialog
    // is gone on the NEXT click anywhere on the page — closing the dialog via
    // Escape, the X button, or a card action that calls outerDialog.close()
    // does not dispatch one, so without this the menu is left orphaned on
    // screen until some unrelated later click happens to clean it up.
    registerCleanup(() => floatingMenu.close());

    // Codex audit LIB-01, 2026-08-30: each panel now carries the id/role/
    // aria-labelledby half of the tab<->tabpanel relationship the tab strip
    // below points at via aria-controls — previously only the tab buttons
    // declared role="tab" and nothing on the panel side backed that up.
    function makePanel(id) {
      const panel = document.createElement('div');
      panel.className = 'lm-content-body';
      panel.id = 'lm-panel-' + id;
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', 'lm-tab-' + id);
      panels.appendChild(panel);
      return panel;
    }
    const templatesPanel = makePanel('templates');
    const treatmentsPanel = makePanel('treatments');
    const projectsPanel = makePanel('projects');

    const templatesTab = buildTemplatesTab(templatesPanel, dialog, floatingMenu, (text) => { count.textContent = text; }, registerCleanup);
    const treatmentsTab = buildTreatmentsTab(treatmentsPanel, dialog, floatingMenu, (text) => { count.textContent = text; }, registerCleanup);
    // Codex audit LIB-04, 2026-08-30: Templates/Treatments both drive this
    // shared footer as their one status readout; the Projects tab used to
    // blank it instead of following the same mental model. onStatus mirrors
    // the pane's own near-filter summary into it whenever that summary
    // changes (including the interim "Loading…"), and currentStatus() lets
    // `activate` restore whatever it last said WITHOUT forcing a re-fetch —
    // ensureLoaded() below is a no-op after the first activation, so without
    // this a second visit to Projects would leave the footer showing
    // whichever tab was open just before it.
    const projectsPane = buildProjectLibraryPane(projectsPanel, {
      onOpened: dialog.close,
      onStatus: (text) => { count.textContent = text; },
    });

    const TABS = [
      { id: 'templates', label: 'Templates', panel: templatesPanel, activate: templatesTab.activate },
      { id: 'treatments', label: 'Treatments', panel: treatmentsPanel, activate: treatmentsTab.activate },
      { id: 'projects', label: 'Projects', panel: projectsPanel, activate: () => {
        count.textContent = projectsPane.currentStatus();
        projectsPane.ensureLoaded();
      } },
    ];

    let activeTabId = (opts && TABS.some(t => t.id === opts.initialTab)) ? opts.initialTab : 'templates';

    // Codex audit LIB-01, 2026-08-30: a full tab pattern needs id/aria-
    // controls on each tab (not just aria-selected) and a roving tabindex —
    // only the active tab is a Tab stop; the rest are reachable by arrow key
    // only. buildDialog()'s own focus trap already filters its focusable set
    // through :not([tabindex="-1"]), so this alone is what makes Tab jump
    // over the inactive tabs and into panel content instead of visiting each
    // one — no change needed there.
    function renderTabStrip() {
      tabStrip.innerHTML = TABS.map(t => {
        const active = t.id === activeTabId;
        return '<button type="button" role="tab" id="lm-tab-' + t.id + '" '
          + 'class="lm-tab-btn' + (active ? ' lm-tab-active' : '') + '" '
          + 'data-tab="' + t.id + '" aria-selected="' + active + '" '
          + 'aria-controls="lm-panel-' + t.id + '" tabindex="' + (active ? '0' : '-1') + '">'
          + escapeHtml(t.label) + '</button>';
      }).join('');
    }

    function showTab(id) {
      const tab = TABS.find(t => t.id === id);
      if (!tab) return;
      floatingMenu.close();
      activeTabId = id;
      renderTabStrip();
      for (const t of TABS) t.panel.hidden = t.id !== id;
      tab.activate();
    }

    // Deliberately does NOT move focus — each tab's own activate() ends by
    // focusing that tab's search input (a TD who clicks a tab expects to be
    // able to start typing immediately), and a click already left native
    // focus on the button the TD clicked. Only the keyboard path below
    // needs to explicitly land focus back on a tab button, because arrow-
    // key tablist navigation is expected to keep focus IN the tablist.
    tabStrip.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-tab]');
      if (!btn) return;
      showTab(btn.dataset.tab);
    });

    tabStrip.addEventListener('keydown', (event) => {
      const key = event.key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
      if (!event.target.closest('[data-tab]')) return;
      // Not strictly needed for correctness (onKeyDown in
      // keyboard-shortcuts.js already bails out whenever any .picker-overlay
      // is open, before it would reach the arrow-nudge-selected-line logic),
      // but stopping propagation here is cheap and keeps this tablist's
      // arrow keys from ever being read by anything else on the page.
      event.preventDefault();
      event.stopPropagation();
      const idx = TABS.findIndex(t => t.id === activeTabId);
      let nextIdx = idx;
      if (key === 'ArrowRight') nextIdx = (idx + 1) % TABS.length;
      else if (key === 'ArrowLeft') nextIdx = (idx - 1 + TABS.length) % TABS.length;
      else if (key === 'Home') nextIdx = 0;
      else if (key === 'End') nextIdx = TABS.length - 1;
      const nextId = TABS[nextIdx].id;
      showTab(nextId);
      const nextBtn = tabStrip.querySelector('[data-tab="' + nextId + '"]');
      if (nextBtn) nextBtn.focus();
    });

    dialog.open();
    showTab(activeTabId);
  }
