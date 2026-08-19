// MAIN PAGE sheet — field table + field suggestion picker (US-068, ADR 0037;
// breakdown sub-cells US-080/ADR 0047).
// Source part for app.js. Run `npm run build` after editing.
//
// Renders the style-metadata rows and owns the one shared suggestion dropdown
// parked on <body>: search, diacritic-folded filtering, remember-a-new-value,
// apply. What a field IS lives in main-page-data.js (MP_FIELD_SPEC and its
// rosters); the colorway rows have their own near-identical but distinct
// picker in main-page-colorways.js; state.mainPage itself is owned by
// main-page.js, which also builds and wires this menu's DOM in initMainPage().

  // Parallel to state.mainPage.fields; null where a row has no spec.
  let mpFieldSpec = [];
  let mpSpecRowCount = -1;
  let mpFldMenu = null;   // the one shared field picker, parked on <body>
  let mpFldOpen = null;   // {i, sp, btn} while a picker is open
  let mpFldFlat = [];     // options currently listed, indexed by data-mp-opt

  function mpResolveSpecs() {
    const f = (state.mainPage && state.mainPage.fields) || [];
    const taken = new Set();
    mpFieldSpec = f.map(() => null);
    MP_FIELD_SPEC.forEach(sp => {
      const i = f.findIndex((row, idx) => !taken.has(idx) && sp.re.test((row && row.label) || ''));
      if (i === -1) return;
      taken.add(i);
      mpFieldSpec[i] = sp;
    });
    mpSpecRowCount = f.length;
  }

  function mpFieldsEl() { return document.getElementById('mp-fields'); }

  function mpRenderFields() {
    const host = mpFieldsEl();
    if (!host) return;
    const fields = (state.mainPage && state.mainPage.fields) || [];
    if (fields.length !== mpSpecRowCount) mpResolveSpecs();
    host.innerHTML = fields.map((f, i) => {
      const isBrand = /^\s*Brand\b/i.test(f.label || '');
      const isDate = /Tech Pack Creation date/i.test(f.label || '');
      const isBreakdown = !!(mpFieldSpec[i] && mpFieldSpec[i].part && f.parts);
      const fixed = isBrand ? 'mp-fixed mp-brand-value' : (isDate ? 'mp-fixed mp-date-value' : '');
      const valueMarkup = isBrand ? '<strong>' + escapeHtml(f.value) + '</strong>' : escapeHtml(f.value);
      /* The sub-headers ride in their own row above the value, exactly as the
         factory layout prints them — they are captions, not data, so they are
         not editable and carry no data-i. */
      const headRow = isBreakdown
        ? '<tr class="mp-bd-headrow"><th class="mp-bd-blank"></th>'
          + '<td class="mp-bdhead">'
          + MP_BREAKDOWN_PARTS.map(p => '<span>' + escapeHtml(p.head) + '</span>').join('')
          + '</td><td class="act mp-screen-only mp-act"></td></tr>'
        : '';
      const valueCell = isBreakdown
        ? '<td class="mp-bdcell">'
          + MP_BREAKDOWN_PARTS.map(p => '<span class="mp-bd-sub" contenteditable spellcheck="false"'
            + ' data-i="' + i + '" data-f="part" data-part="' + p.key + '">'
            + escapeHtml(String(f.parts[p.key] || '')) + '</span>').join('')
          + '</td>'
        : '<td' + (fixed ? ' class="' + fixed + '" aria-readonly="true"' : ' contenteditable spellcheck="false"')
          + ' data-i="' + i + '" data-f="value">' + valueMarkup + '</td>';
      return headRow
        + '<tr><th contenteditable spellcheck="false" data-i="' + i + '" data-f="label">'
        + escapeHtml(f.label) + '</th>'
        + valueCell
        /* The trigger gets its own cell and never goes inside the value td:
           the input listener below stores the value cell's whole textContent,
           so a button living in it would be typed into the field. */
        + '<td class="act mp-screen-only mp-act">'
        + (mpFieldSpec[i]
          ? '<button type="button" class="mp-dd" data-mp-dd="' + i + '" tabindex="-1"'
            + ' title="Suggestions — you can still type straight into the cell"></button>'
          : '')
        + '</td></tr>';
    }).join('');
  }

  /* ---- Field picker ------------------------------------------------------ */

  function mpCurrentValue(i) {
    const f = (state.mainPage && state.mainPage.fields) || [];
    const row = f[i] || {};
    const part = mpFieldSpec[i] && mpFieldSpec[i].part;
    if (part) return String((row.parts || {})[part] || '');
    return String(row.value || '');
  }

  /* Diacritic-folded, so "nguyen thi hong hanh" finds "Nguyễn Thị Hồng Hạnh".
     Every token must appear somewhere, as in mpColorMatches(), so word order
     and the Vietnamese habit of reordering name parts both stop mattering. */
  function mpFold(s) {
    return String(s).toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\u0111/g, 'd');
  }

  function mpOptionsFor(sp) {
    const base = (typeof sp.values === 'function' ? sp.values() : (sp.values || [])).map(String);
    const key = sp.extras || sp.key;
    const seen = new Set(base.map(v => v.toLowerCase()));
    const extra = ((state.mainPage.fieldExtra || {})[key] || [])
      .filter(v => !seen.has(String(v).toLowerCase()));
    return base.concat(extra);
  }

  function mpRememberExtra(sp, v) {
    const key = sp.extras || sp.key;
    const store = state.mainPage.fieldExtra || (state.mainPage.fieldExtra = {});
    const list = store[key] || (store[key] = []);
    if (v && !list.some(x => String(x).toLowerCase() === v.toLowerCase())) list.push(v);
  }

  function mpRenderFldMenu() {
    if (!mpFldOpen || !mpFldMenu) return;
    const box = mpFldMenu.querySelector('.mm-list');
    const foot = mpFldMenu.querySelector('.mm-foot');
    const raw = (mpFldMenu.querySelector('.mm-q').value || '').trim();
    const q = mpFold(raw).split(/\s+/).filter(Boolean);
    const cur = mpCurrentValue(mpFldOpen.i).toLowerCase();
    mpFldFlat = mpOptionsFor(mpFldOpen.sp).filter(v => q.every(t => mpFold(v).includes(t)));
    // Indices only in the attribute; the raw query is read back off .mm-q at
    // click time, never round-tripped through markup.
    let html = mpFldFlat.map((v, n) =>
      '<button type="button" data-mp-opt="' + n + '"' + (cur === v.toLowerCase() ? ' class="mm-on"' : '') + '>'
      + '<span class="mm-name">' + escapeHtml(v) + '</span></button>').join('');
    /* Looser than the colour menu, which only offers the free row when
       nothing matched: these rosters are known-incomplete, so typing "Selly"
       must still be able to mean a NEW Selly instead of being swallowed by
       "Selly Pham". */
    if (raw && !mpFldFlat.some(v => v.toLowerCase() === raw.toLowerCase())) {
      html += '<button type="button" data-mp-free><span class="mm-name">＋ Add “'
        + escapeHtml(raw) + '” (off the list)</span></button>';
    }
    html += '<button type="button" data-mp-clear><span class="mm-name">－ Leave blank</span></button>';
    box.innerHTML = html;
    foot.textContent = raw
      ? mpFldFlat.length + ' match · Enter picks the first'
      : mpFldFlat.length + ' suggestions · type to filter, or type a new value';
  }

  function mpOpenFldMenu(i, btn) {
    const sp = mpFieldSpec[i];
    if (!sp || !mpFldMenu) return;
    // Only one picker at a time: the overlay's click handler returns early on
    // a trigger hit, so it never reaches the close-the-colour-menu branch.
    if (mpColorWrap) mpColorWrap.classList.remove('open');
    mpFldOpen = { i, sp, btn };
    mpFldMenu.querySelector('.mm-q').value = '';
    mpRenderFldMenu();
    const r = btn.getBoundingClientRect();     // fixed positioning — no scroll maths
    const width = 300;
    mpFldMenu.style.left = Math.max(6, Math.min(r.right - width, window.innerWidth - width - 6)) + 'px';
    mpFldMenu.classList.add('open');
    const h = mpFldMenu.offsetHeight;
    const below = window.innerHeight - r.bottom;
    mpFldMenu.style.top = (below > h + 8 || r.top < h + 8 ? r.bottom + 4 : r.top - h - 4) + 'px';
    mpFldMenu.querySelector('.mm-q').focus();
  }

  function mpCloseFldMenu(refocus) {
    if (!mpFldMenu) return;
    mpFldMenu.classList.remove('open');
    const b = mpFldOpen && mpFldOpen.btn;
    mpFldOpen = null;
    if (refocus && b && document.contains(b)) b.focus();
  }

  function mpApplyFld(v) {
    if (!mpFldOpen) return;
    const i = mpFldOpen.i;
    const row = (state.mainPage.fields || [])[i] || {};
    const part = mpFldOpen.sp && mpFldOpen.sp.part;
    const label = (row.label || '') + (part ? ' · ' + part : '');
    if (part) {
      row.parts = row.parts || {};
      row.parts[part] = v;
      mpSyncBreakdown(row);
    } else {
      row.value = v;
    }
    mpRenderFields();
    pushHistoryIfChanged();
    mpCloseFldMenu(true);
    showToast(label + ': ' + (v || '(blank)') + ' · Ctrl/Cmd+Z to undo');
  }
