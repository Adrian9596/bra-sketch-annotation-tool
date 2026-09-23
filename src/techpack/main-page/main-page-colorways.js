// MAIN PAGE sheet — colorway rows + the Color Master List picker (US-068,
// ADR 0037; BOM columns US-072/ADR 0041).
// Source part for app.js. Run `npm run build` after editing.
//
// Adds, removes and renders state.mainPage.colorways, and owns the searchable
// colour menu hung off the sheet bar's "Add colour" button. The master list
// and the shade→chip inference are in main-page-data.js; the field rows have
// their own separate picker in main-page-fields.js; state.mainPage is seeded
// by ensureMainPage() in main-page.js, which also wires the menu's input.
//
// Read mpRemoveColor's comment before touching the `col` labels: BOM keys its
// per-row cwOverride by them.

  let mpColorWrap = null;
  let mpColorMenu = null;

  function mpCwTables() { return Array.from(document.querySelectorAll('table.mp-cwx')); }

  function mpRenderCw() {
    const rows = (state.mainPage && state.mainPage.colorways) || [];
    mpCwTables().forEach(t => {
      t.innerHTML = rows.map((c, i) =>
        '<tr><th>' + escapeHtml(c.col || ('COL ' + (i + 1))) + '</th>'
        + '<td contenteditable spellcheck="false" data-cw="' + i + '">' + escapeHtml(c.value) + '</td>'
        + '<td class="act mp-screen-only"><button type="button" data-rm="' + i + '" title="Remove this colorway">×</button></td></tr>').join('');
    });
    mpRenderColorMenu();   // keeps the "already used" marks in the picker honest
  }

  /* Every token of the query has to appear somewhere in the entry, so
     "14-38 lilac" and "lilac 14-38" both find 14-3812 TCX Lilac Mist. */
  function mpColorMatches(name, query) {
    const s = String(name).toLowerCase();
    return query.every(t => s.includes(t));
  }

  function mpRenderColorMenu() {
    if (!mpColorMenu) return;
    const box = mpColorMenu.querySelector('.cm-list');
    const foot = mpColorMenu.querySelector('.cm-foot');
    const raw = (mpColorMenu.querySelector('.cm-q').value || '').trim();
    const query = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const lib = (state.mainPage && state.mainPage.colorLibrary) || [];
    const used = new Set(((state.mainPage && state.mainPage.colorways) || [])
      .map(c => String(c.value || '').toLowerCase()));
    const hits = lib.map((c, i) => ({ c, i })).filter(h => mpColorMatches(h.c.name, query));
    box.innerHTML = hits.map(({ c, i }) =>
      '<button type="button" data-color-choice="' + i + '"'
      + (used.has(String(c.name).toLowerCase()) ? ' class="cm-on" title="Already in the colorway list"' : '') + '>'
      + '<span class="mp-chip" style="--chip:' + escapeHtml(c.hex || 'transparent') + '"></span>'
      + '<span class="cm-name">' + escapeHtml(c.name || 'TBC') + '</span></button>').join('')
      // anything not on the house list can still be added by hand
      || (raw
        ? '<button type="button" class="cm-new" data-color-free>'
          + '<span class="mp-chip" style="--chip:transparent"></span>'
          + '<span class="cm-name">＋ Add “' + escapeHtml(raw) + '” (off the master list)</span></button>'
        : '<div class="cm-empty">No colour matches</div>');
    foot.textContent = raw
      ? hits.length + '/' + lib.length + ' colours match · Enter picks the first'
      : lib.length + ' colours in the Color Master List · type to search';
  }

  function mpAddColor(choice) {
    const mp = ensureMainPage();
    const picked = choice || { name: 'TBC', hex: '' };
    mp.colorways.push({
      col: 'COL ' + (mp.colorways.length + 1),
      value: picked.name || 'TBC',
      hex: picked.hex || '',
    });
    if (mpColorWrap) mpColorWrap.classList.remove('open');
    if (mpColorMenu) mpColorMenu.querySelector('.cm-q').value = '';
    mpRenderCw();
    pushHistoryIfChanged();
    showToast('Added ' + mp.colorways[mp.colorways.length - 1].col + ': ' + (picked.name || 'TBC'));
  }

  /* US-072/ADR 0041: BOM table columns now read state.mainPage.colorways
     directly (col/value), so removing a colorway does change what BOM
     shows — but col labels are renumbered below, and a BOM row's
     cwOverride is keyed by col label, not by a stable colorway id, so an
     override keyed 'COL 2' stays orphaned under the old label if a
     colorway ahead of it is removed. Accepted limitation: no remap pass
     exists, same as this function never remapped anything before BOM
     existed. */
  function mpRemoveColor(i) {
    const mp = ensureMainPage();
    if (!mp.colorways[i]) return;
    mp.colorways.splice(i, 1);
    mp.colorways.forEach((c, j) => { c.col = 'COL ' + (j + 1); });
    mpRenderCw();
    pushHistoryIfChanged();
  }
