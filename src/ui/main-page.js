// MAIN PAGE sheet: state owner + DOM wiring (US-068, ADR 0037).
// Source part for app.js. Run `npm run build` after editing.
//
// Rebuilt on this tool's primitives from the tech pack's mod-main module —
// the Pack.* runtime does not exist here (ADR 0037). This part seeds and
// migrates state.mainPage, renders the sheet, and binds every delegated
// event; the pieces it composes live in the sibling parts loaded before it:
// main-page-data.js (rosters, Color Master List), main-page-sketches.js
// (version sketches), main-page-fields.js (field table + suggestion picker),
// main-page-colorways.js (colorway rows + colour picker).
//
// Style metadata only: no anchor, no POM, no view, so detection never reads
// it. state.mainPage is seeded lazily by ensureMainPage() so state.js does
// not carry 47 colour rows.

  function mpIsoToday() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* Composite kept in sync from the parts, never typed directly. Empty parts
     drop out, so a breakdown with only a prefix reads "LiftyBliss" and not
     "LiftyBliss ·  · ". */
  function mpBreakdownValue(parts) {
    return MP_BREAKDOWN_PARTS
      .map(p => String((parts || {})[p.key] || '').trim())
      .filter(Boolean)
      .join(MP_BREAKDOWN_SEP);
  }

  function mpSyncBreakdown(field) {
    if (!field) return;
    field.value = mpBreakdownValue(field.parts);
  }

  /* A project saved before US-080 has one free-text breakdown value. It
     becomes the prefix — the historical packs put the range name there — and
     the placeholder 'TBC' is dropped rather than carried into a sub-cell. */
  function mpEnsureBreakdown(mp) {
    const i = mp.fields.findIndex(f => /Style No Breakdown/i.test((f && f.label) || ''));
    if (i === -1) return;
    const f = mp.fields[i];
    if (!f.parts || typeof f.parts !== 'object') {
      const legacy = String(f.value || '').trim();
      f.parts = {
        prefix: /^tbc$/i.test(legacy) ? '' : legacy,
        category: '',
        rangeNo: '',
      };
    }
    MP_BREAKDOWN_PARTS.forEach(p => {
      if (typeof f.parts[p.key] !== 'string') f.parts[p.key] = '';
    });
    mpSyncBreakdown(f);
  }

  // Seeds state.mainPage in place and migrates a project saved against an
  // older colour library. Safe to call repeatedly.
  function ensureMainPage() {
    const mp = state.mainPage && typeof state.mainPage === 'object'
      ? state.mainPage
      : (state.mainPage = {});
    if (!Array.isArray(mp.fields) || !mp.fields.length) {
      mp.fields = MP_DEFAULT_FIELDS.map(f => ({ ...f }));
    }
    /* Appended, not inserted by index: labels are editable, so a project can
       carry a reordered or renamed roster and there is no position to trust
       beyond "not present yet". */
    if (!mp.fields.some(f => /^Block Reference\b/i.test(String((f && f.label) || '').trim()))) {
      mp.fields.push({ ...MP_DEFAULT_FIELDS[MP_DEFAULT_FIELDS.length - 1] });
    }
    mpEnsureBreakdown(mp);
    if (!mp.sketches || typeof mp.sketches !== 'object') mp.sketches = {};
    MP_SKETCH_VARIANTS.forEach(v => {
      const slots = Array.isArray(mp.sketches[v]) ? mp.sketches[v] : [];
      mp.sketches[v] = MP_SKETCH_SLOTS.map((_, i) => {
        const s = slots[i];
        return s && typeof s === 'object' && s.id
          ? { id: String(s.id), aspect: Math.max(0.01, Number(s.aspect) || 1) }
          : null;
      });
    });
    const brand = mp.fields.find(f => /^\s*Brand\b/i.test(f.label || ''));
    if (brand) brand.value = 'Crossian';
    const created = mp.fields.find(f => /Tech Pack Creation date/i.test(f.label || ''));
    if (created && !/^\d{4}-\d{2}-\d{2}$/.test(String(created.value || '').trim())) {
      created.value = mpIsoToday();
    }
    if (!mp.fieldExtra || typeof mp.fieldExtra !== 'object') mp.fieldExtra = {};
    if (!Array.isArray(mp.colorways) || !mp.colorways.length) {
      mp.colorways = [
        { col: 'COL 1', value: 'Default White', hex: mpShadeOf('Default White') },
        { col: 'COL 2', value: 'Default Black', hex: mpShadeOf('Default Black') },
      ];
    }
    if (mp.colorLibId !== MP_COLOR_LIB_ID || !Array.isArray(mp.colorLibrary)) {
      mp.colorLibrary = mpDefaultColorLibrary();
      mp.colorLibId = MP_COLOR_LIB_ID;
    }
    if (typeof mp.provenance !== 'string') mp.provenance = '';
    mpResolveSpecs();
    return mp;
  }

  function renderMainPage() {
    if (!state.mainPage) return;
    mpRenderFields();
    mpRenderCw();
    mpRenderSketches();
    const prov = document.getElementById('mp-provenance');
    if (prov && prov !== document.activeElement) prov.textContent = state.mainPage.provenance || '';
  }

  /* ---- Wiring ------------------------------------------------------------ */
  // Sheet open/close now belongs to page-nav.js's setActivePage('mainpage' |
  // 'board') — the MAIN PAGE sheet is a peer page of the Board, not a modal
  // this file owns the visibility of.

  function initMainPage() {
    ensureMainPage();

    const overlay = document.getElementById('mainPageOverlay');
    if (!overlay) return;

    const printBtn = document.getElementById('mainPagePrintBtn');
    if (printBtn) printBtn.addEventListener('click', () => window.print());

    // Colour picker, hung off the "Add colour" button in the sheet bar.
    const addBtn = document.getElementById('mainPageAddColorBtn');
    if (addBtn) {
      mpColorWrap = addBtn.closest('.color-add-wrap');
      mpColorMenu = mpColorWrap && mpColorWrap.querySelector('.color-menu');
      if (mpColorMenu) {
        mpColorMenu.innerHTML = '<input type="search" class="cm-q" spellcheck="false" '
          + 'placeholder="Search colour — name or Pantone code (e.g. 14-38, dusty pink)">'
          + '<div class="cm-list"></div><div class="cm-foot"></div>';
        const q = mpColorMenu.querySelector('.cm-q');
        q.addEventListener('input', mpRenderColorMenu);
        /* The board's global keydown handler treats plain keys as tool
           shortcuts; a search input is not contenteditable, so without this a
           Backspace typed to fix a typo would reach the board. */
        q.addEventListener('keydown', e => {
          if (e.key !== 'Tab') e.stopPropagation();
          if (e.key === 'Escape') { mpColorWrap.classList.remove('open'); addBtn.focus(); return; }
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const first = mpColorMenu.querySelector('.cm-list button');
          if (first) first.click();
        });
      }
      addBtn.addEventListener('click', () => {
        if (!mpColorWrap) return;
        mpCloseFldMenu();
        const open = mpColorWrap.classList.toggle('open');
        if (open && mpColorMenu) {
          const q = mpColorMenu.querySelector('.cm-q');
          q.value = '';
          mpRenderColorMenu();
          q.focus();
        }
      });
    }

    /* Parked on <body>, not inside the sheet, so it is never clipped by the
       scrolling sheet column. */
    mpFldMenu = document.createElement('div');
    mpFldMenu.id = 'mp-menu';
    mpFldMenu.className = 'mp-menu';
    mpFldMenu.setAttribute('role', 'menu');
    mpFldMenu.innerHTML =
      '<input type="search" class="mm-q" spellcheck="false" placeholder="Type to filter — or type a new value and press Enter">'
      + '<div class="mm-list"></div><div class="mm-foot"></div>';
    document.body.appendChild(mpFldMenu);
    mpFldMenu.addEventListener('keydown', e => { if (e.key !== 'Tab') e.stopPropagation(); });
    mpFldMenu.querySelector('.mm-q').addEventListener('input', mpRenderFldMenu);
    mpFldMenu.querySelector('.mm-q').addEventListener('keydown', e => {
      if (e.key === 'Escape') { mpCloseFldMenu(true); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = mpFldMenu.querySelector('.mm-list button');
      if (first) first.click();
    });
    /* mousedown-preventDefault so the click never moves focus off the value
       cell before the option is applied. */
    mpFldMenu.addEventListener('mousedown', e => {
      if (e.target.closest('.mm-list button')) e.preventDefault();
    });
    mpFldMenu.addEventListener('click', e => {
      if (!mpFldOpen) return;
      const opt = e.target.closest('[data-mp-opt]');
      if (opt) { mpApplyFld(mpFldFlat[+opt.dataset.mpOpt]); return; }
      if (e.target.closest('[data-mp-free]')) {
        const raw = mpFldMenu.querySelector('.mm-q').value.trim();
        if (!raw) return;
        mpRememberExtra(mpFldOpen.sp, raw);
        mpApplyFld(raw);
        return;
      }
      if (e.target.closest('[data-mp-clear]')) mpApplyFld('');
    });
    window.addEventListener('resize', () => { if (mpFldOpen) mpCloseFldMenu(); });

    /* Delegated on the overlay, which survives every re-render — a listener
       on a cell or button would die on the next render. */
    overlay.addEventListener('input', e => {
      const cell = e.target.closest('#mp-fields [data-i]');
      if (cell) {
        const row = state.mainPage.fields[+cell.dataset.i];
        if (cell.dataset.f === 'part') {
          row.parts = row.parts || {};
          row.parts[cell.dataset.part] = cell.textContent.trim();
          mpSyncBreakdown(row);   // composite is derived, never typed
        } else {
          row[cell.dataset.f] = cell.textContent.trim();
        }
        return;
      }
      const cw = e.target.closest('table.mp-cwx [data-cw]');
      if (cw) {
        const idx = +cw.dataset.cw;
        state.mainPage.colorways[idx].value = cw.textContent.trim();
        // Both version panels show the same colorway list; mirror the edit
        // into the table the TD is not typing in.
        mpCwTables().forEach(t => {
          if (t.contains(cw)) return;
          const other = t.querySelector('[data-cw="' + idx + '"]');
          if (other) other.textContent = cw.textContent;
        });
        return;
      }
      if (e.target.id === 'mp-provenance') state.mainPage.provenance = e.target.textContent;
    });
    /* One history entry per field, not per keystroke: mutate on input, push
       on blur. pushHistoryIfChanged dedups by fingerprint, so a focus/blur
       with no edit is a no-op. */
    overlay.addEventListener('focusout', e => {
      if (e.target.closest('[contenteditable]')) pushHistoryIfChanged();
    });
    overlay.addEventListener('click', e => {
      const dd = e.target.closest('[data-mp-dd]');
      if (dd) {
        if (mpFldOpen && mpFldOpen.btn === dd) mpCloseFldMenu();
        else mpOpenFldMenu(+dd.dataset.mpDd, dd);
        return;
      }
      const rm = e.target.closest('table.mp-cwx [data-rm]');
      if (rm) { mpRemoveColor(+rm.dataset.rm); return; }
      // The clear button sits inside the slot box, so it has to win first.
      const skClear = e.target.closest('[data-mp-sk-clear]');
      if (skClear) {
        const [variant, i] = skClear.dataset.mpSkClear.split(':');
        mpSetSketch(variant, +i, null);
        return;
      }
      const sk = e.target.closest('[data-mp-sk]');
      if (sk) {
        if (mpSketchOpen === sk.dataset.mpSk) mpCloseSketchMenu();
        else mpOpenSketchMenu(sk.dataset.mpSk, sk);
        return;
      }
      if (mpSketchOpen && !e.target.closest('#mpSketchMenu')) mpCloseSketchMenu();
      const choice = e.target.closest('[data-color-choice]');
      if (choice) { mpAddColor(state.mainPage.colorLibrary[+choice.dataset.colorChoice]); return; }
      if (e.target.closest('[data-color-free]')) {
        const raw = mpColorMenu ? mpColorMenu.querySelector('.cm-q').value.trim() : '';
        if (raw) mpAddColor({ name: raw, hex: mpShadeOf(raw) });
        return;
      }
      if (mpColorWrap && !e.target.closest('.color-add-wrap')) mpColorWrap.classList.remove('open');
      if (mpFldOpen && !e.target.closest('#mp-menu,[data-mp-dd]')) mpCloseFldMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || state.activePage !== 'mainpage') return;
      if (mpSketchOpen) { mpCloseSketchMenu(); return; }
      if (mpFldOpen) { mpCloseFldMenu(true); return; }
      if (mpColorWrap && mpColorWrap.classList.contains('open')) {
        mpColorWrap.classList.remove('open');
        return;
      }
      setActivePage('board');
    }, true);

    renderMainPage();
  }
