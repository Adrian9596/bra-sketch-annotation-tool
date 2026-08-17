// MAIN PAGE sheet: style metadata fields + colorways (US-068, ADR 0037).
// Source part for app.js. Run `npm run build` after editing.
//
// Rebuilt on this tool's primitives from the tech pack's mod-main module —
// the Pack.* runtime does not exist here (ADR 0037). The data is carried
// across verbatim: the 13-row field roster, the suggestion rosters mined
// from 52 historical packs, and the 47-entry Color Master List.
//
// Style metadata only: no anchor, no POM, no view, so detection never reads
// it. state.mainPage is seeded lazily by ensureMainPage() so state.js does
// not carry 47 colour rows.

  /* House colour master list — the 47 entries of Color_Master_List.xlsx,
     verbatim (Pantone code + TCX + name + CP suffix exactly as recorded), so
     what prints on the colorway row is the name the factory list already
     uses. */
  const MP_COLOR_MASTER = [
    'Default White', 'Default Black', '11-0110 TCX Buttercream (SonaShape Beige) CP',
    '11-0601 TCX Bright White CP', '11-1408 TCX Light Pink CP', '12-0811 TCX Dawn',
    '12-1007 TCX Pastel Rose Tan (SonaShape Almond)', '12-1110 TCX Nude Pink CP',
    '12-1304 TCX Light Pink CP', '12-4302 TCX Light Blue CP', '13-1010 TCX Light Beige CP',
    '13-1408 TCX Chintz Rose', '13-4200 TCX Omphadoles', '13-4202 TCX Light Blue CP',
    '13-5907 TCX Light Green CP', '14-0217 TCX Sage', '14-1212 TCX Nude Tan CP',
    '14-1712 TCX Dusty Rose', '14-1904 TCX Pink', '14-3206 TCX Light Purple CP',
    '14-3812 TCX Lilac Mist', '14-3926 TCX Lavender CP', '14-4202 TCX Light Blue CP',
    '14-4306 TCX Coral Blue CP', '15-1515 TCX Dusty Pink CP', '15-3207 TCX Mauve Mist',
    '16-3205 TCX Mauve Purple CP', '16-4121 TCX Blissful Blue', '16-5304 TCX Light Teal CP',
    '17-1230 TCX Moccha Mouse', '17-1328 TCX Tanzine', '18-1229 TCX Coffee CP',
    '18-3025 TCX Purple CP', '18-3211 TCX Dusty Purple CP', '18-4016 TCX Dark Gray CP',
    '19-1555 TCX Burgundy', '19-2524 TCX Magenta Purple CP', '19-3832 TCX French Navy',
    '19-3911 TCX Black Beauty CP', '19-4029 TCX Navy Blue CP', 'Moona Purple', 'Nude Beige',
    'Taupe (Zenalift Brown)', 'Zenchic Beige', 'Zenchic Blue', 'Zenchic Pink', 'Zenchic White',
  ];

  /* The master list carries no hex, and a Pantone TCX reference must not be
     guessed, so the chip is only a rough on-screen cue read off the colour
     words in the name. Names with no recognisable shade word (Dawn,
     Omphadoles, Tanzine) get a blank chip rather than an invented one. Never
     treat these as Pantone values. */
  const MP_SHADE_WORDS = [
    ['bright white', '#fdfdfd'], ['black beauty', '#15151a'], ['pastel rose tan', '#e3bfae'],
    ['light pink', '#f2c6cd'], ['nude pink', '#e8c0b4'], ['dusty pink', '#d69ba2'],
    ['dusty rose', '#c08a8c'], ['chintz rose', '#c98b8b'], ['light beige', '#e8dcc6'],
    ['nude beige', '#e0c9ae'], ['nude tan', '#d9b391'], ['light blue', '#bdd4e7'],
    ['coral blue', '#a8c3cf'], ['blissful blue', '#4a6f9c'], ['navy blue', '#1d2b4a'],
    ['french navy', '#22304f'], ['light green', '#c9dcbe'], ['light teal', '#a9cdcb'],
    ['light purple', '#cbb8dc'], ['dusty purple', '#8d7594'], ['mauve purple', '#8c6b81'],
    ['magenta purple', '#7c2f5a'], ['mauve mist', '#b99aa8'], ['lilac mist', '#cbbdd8'],
    ['dark gray', '#4a4a4f'], ['moccha mouse', '#8a7263'], ['buttercream', '#f4e9c8'],
    ['lavender', '#c3b3d9'], ['burgundy', '#6b1f2e'], ['coffee', '#5a4034'],
    ['taupe', '#8f8071'], ['sage', '#9aa887'], ['magenta', '#a02360'], ['purple', '#6a4a8c'],
    ['navy', '#1d2b4a'], ['beige', '#ddc9ab'], ['nude', '#d8ad8a'], ['tan', '#c99b73'],
    ['pink', '#e9b7bd'], ['rose', '#c98b8b'], ['teal', '#3f8f8b'], ['blue', '#3269a8'],
    ['green', '#557c57'], ['gray', '#8c8c8c'], ['grey', '#8c8c8c'], ['white', '#ffffff'],
    ['black', '#111111'], ['brown', '#70483c'], ['red', '#b82025'],
  ];

  // Whole words only — a substring match reads "tan" inside "Tanzine".
  const MP_SHADE_RE = MP_SHADE_WORDS.map(([w, hex]) =>
    [new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'), hex]);

  function mpShadeOf(name) {
    const s = String(name || '').toLowerCase();
    const hit = MP_SHADE_RE.find(([re]) => re.test(s));
    return hit ? hit[1] : '';
  }

  /* Bumped when the master list changes, so a project saved against an older
     library picks the new list up on open instead of keeping a stale one. */
  const MP_COLOR_LIB_ID = 'color-master-list-47';

  /* The shipped field roster, verbatim from the tech pack's own default
     mainpage island. Labels are editable, hence the bind-once-by-regex rule
     below. "Block Reference" is a row here (US-080/ADR 0047) — the layout FD
     works from prints it, so ADR 0037's "strip it like the source module
     does" no longer holds. */
  const MP_DEFAULT_FIELDS = [
    { label: 'Brand - 品牌', value: 'Crossian' },
    { label: 'Fashion Designer', value: 'TBC' },
    { label: 'Tech Pack Designer', value: 'TBC' },
    { label: 'Technical Designer', value: 'TBC' },
    { label: 'Product Type - 品类', value: 'Bra' },
    { label: 'Style No Breakdown - 风格号码分解', value: '' },
    { label: 'Base Size - 基础尺码', value: 'TBC' },
    { label: 'Size Range - 尺寸范围', value: 'TBC' },
    { label: 'Style No - 风格号码', value: 'TBC' },
    { label: 'Garment Description - 文胸分类', value: 'TBC' },
    { label: 'Range Name - 产品名', value: 'TBC' },
    { label: 'Season/Year - 季节/年', value: 'TBC' },
    { label: 'Tech Pack Creation date', value: '' },
    { label: 'Block Reference - 原版品', value: 'TBC' },
  ];

  /* US-080/ADR 0047: the breakdown row is not one value. The factory layout
     splits it under three headers, and `parts` is what a TD types into;
     `value` is kept in sync as the composite so every existing reader (the
     preview sheet, the workbook, anything later) keeps working off `value`
     alone. */
  const MP_BREAKDOWN_PARTS = [
    { key: 'prefix', head: 'style prefix' },
    { key: 'category', head: 'category #:' },
    { key: 'rangeNo', head: 'range no:' },
  ];
  const MP_BREAKDOWN_SEP = ' · ';

  /* Version sketches (US-080/ADR 0047). Two fixed slots per version, in the
     order the factory layout prints them. TD-supplied: the tool never adopts
     a Board photo (those carry POM lines) or a Construction image (annotated)
     on its own. */
  const MP_SKETCH_VARIANTS = ['lace', 'solid'];
  const MP_SKETCH_SLOTS = [
    { key: 'front', label: 'FRONT' },
    { key: 'back', label: 'BACK' },
  ];

  /* Bytes deliberately live outside state.mainPage, like BOM board images:
     history clones state.mainPage on every field edit, and four
     full-resolution flats cloned 120 deep is a different order of memory.
     Every import mints a NEW id and nothing is ever evicted, so undo across a
     replaced slot still finds the previous image's bytes here. */
  const mpSketchDataById = new Map();
  let mpSketchSeq = 0;

  /* ---- Field suggestion rosters -------------------------------------------
     Lists live HERE, in code, not copied into the saved project the way
     colorLibrary is. colorLibrary has to be copied because each entry carries
     a derived hex; these carry nothing, so changing a roster means shipping a
     new build and every project opened in it sees the change at once — with
     no colorLibId-style migration guard and no way for a project to sit on a
     stale list. What a TD types that is NOT on a list is remembered per
     project in state.mainPage.fieldExtra: the rosters were inferred from 52
     historical packs and are known to be incomplete, so a list must never be
     a wall. */
  const MP_RANGE_NAMES = ['SofieLift', 'TrulySofty', 'Airnix', 'AmoraFit', 'CherishShape',
    'FormaLift', 'VeraComfort', 'JuliaLace', 'BiancaBra', 'AuraZip', 'MilaEase',
    'FeliciaBra', 'KiraForm'];
  const MP_ALPHA_SIZES = ['S', 'M', 'M2', 'L', 'L2', 'XL', '2XL', '3XL', '4XL', '5XL', '5XL2'];

  /* The 3 size-column sets found in the "Size Chart & Grading Rule-2026"
     sheet of the historical grading workbook, each tied to a different
     size-chart revision. shortLabel is derived (not hand-typed twice) so it
     can never drift from the sizes array it describes. Picking one here only
     writes the field — it does not reflow this tool's size run, which is
     owned by the Grading dialog (ADR 0037 non-goal). */
  const MP_SIZE_RANGE_PRESETS = [
    { id: 'sc2d-3a',
      sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'M2', 'L2', '2XL2', '3XL2', '4XL2', '5XL2', 'L3', '2XL3', '3XL3', '4XL3'] },
    { id: '22jun2026',
      sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', 'M2', 'L2', 'XL2', '2XL2', '3XL2', '4XL2', '5XL2'] },
    { id: 'sc1b',
      sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', 'M2', 'L2', '2XL2', '3XL2', '4XL2', '5XL2', '6XL2'] },
  ];
  MP_SIZE_RANGE_PRESETS.forEach(p => { p.shortLabel = 'S–' + p.sizes[p.sizes.length - 1]; });

  /* Season and Style No are composed from what the project already knows, so
     the drift the historical scan found (bare year with no season, "1. 0",
     vA/VA, missing V) cannot be reintroduced by hand. */
  function mpSeasonOpts() {
    const y = new Date().getFullYear() % 100;
    return [0, 1, -1].flatMap(d => ['SS', 'AW']
      .map(s => s + String(((y + d) % 100 + 100) % 100).padStart(2, '0')));
  }
  function mpStyleNoOpts() {
    const nm = String(state.styleId || '').trim().replace(/\s+/g, '');
    return nm ? ['VA', 'VB'].map(v => nm + v + '-1.0') : [];
  }

  /* Bound to rows ONCE, by regex, never per render: the labels are
     contenteditable, so re-matching every render would unbind a row the
     moment someone retypes its label. Order matters — 'Style No Breakdown'
     must claim its row before the looser /Style No/.

     Breakdown suggests RANGE NAMES ONLY. In the source, offering the
     composite strings the old packs used ("Airnix · VB · 1.0") pushed that
     whole string into the style name and corrupted every sheet header — the
     roster stays narrow here for the same reason. */
  const MP_FIELD_SPEC = [
    // Writes the `style prefix` sub-cell, never the whole composite.
    { key: 'breakdown', re: /Style No Breakdown/i, part: 'prefix', values: () => MP_RANGE_NAMES },
    { key: 'fashionDes', re: /Fashion Designer/i, values: ['Diep Ngoc Do', 'Linh Tung Nguyen', 'Dung Phuong Vu', 'Linh Phuong Le Trinh', 'Phong Dong Nguyen', 'Tam Thien Duc Nguyen'] },
    { key: 'tpDes', re: /Tech Pack Designer/i, values: ['Linh Khanh Nguyen', 'Khanh Linh Nguyen', 'Nguyễn Thị Hồng Hạnh', 'Phong Dong Nguyen', 'Vy Truc Ngoc Vang'] },
    { key: 'techDes', re: /Technical Designer/i, values: ['Tuyen Van Bui', 'Nishani Kadupitige', 'Selly Pham', 'Nga Hang Thi Hoang'] },
    { key: 'productType', re: /Product Type/i, values: ['Bra'] },
    { key: 'baseSize', re: /Base Size/i, values: MP_ALPHA_SIZES },
    { key: 'sizeRange', re: /Size Range/i, values: () => MP_SIZE_RANGE_PRESETS.map(p => p.shortLabel) },
    { key: 'styleNo', re: /Style No/i, values: mpStyleNoOpts },
    { key: 'garmentDesc', re: /Garment Description/i, values: ['Front Closure Bra', 'Back Closure Bra', '2-in-1 Bra', 'Front Closure Comfort Bra', 'Breathable Side Opening Bra', 'Front Zip Closure Bra'] },
    { key: 'rangeName', re: /Range Name/i, extras: 'breakdown', values: () => MP_RANGE_NAMES },
    { key: 'season', re: /Season/i, values: mpSeasonOpts },
  ];

  // Parallel to state.mainPage.fields; null where a row has no spec.
  let mpFieldSpec = [];
  let mpSpecRowCount = -1;
  let mpColorWrap = null;
  let mpColorMenu = null;
  let mpFldMenu = null;   // the one shared field picker, parked on <body>
  let mpFldOpen = null;   // {i, sp, btn} while a picker is open
  let mpFldFlat = [];     // options currently listed, indexed by data-mp-opt

  function mpIsoToday() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function mpDefaultColorLibrary() {
    return MP_COLOR_MASTER.map(n => ({ name: n, hex: mpShadeOf(n) }));
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
  function mpCwTables() { return Array.from(document.querySelectorAll('table.mp-cwx')); }

  /* ---- Version sketches -------------------------------------------------- */

  function mpSketchVariant(variant) {
    return String(variant || '').toLowerCase() === 'lace' ? 'lace' : 'solid';
  }

  function mpSketchSlot(variant, i) {
    const mp = state.mainPage;
    if (!mp || !mp.sketches) return null;
    const slots = mp.sketches[mpSketchVariant(variant)] || [];
    return slots[i] || null;
  }

  function mpSketchDataURL(variant, i) {
    const slot = mpSketchSlot(variant, i);
    return (slot && mpSketchDataById.get(slot.id)) || '';
  }

  // Injects the bytes back for save; the runtime state stays byte-free.
  function mpSerializeForProject() {
    const out = state.mainPage ? clone(state.mainPage) : null;
    if (!out || !out.sketches) return out;
    MP_SKETCH_VARIANTS.forEach(v => {
      out.sketches[v] = (out.sketches[v] || []).map(slot => (slot && slot.id
        ? { ...slot, dataURL: mpSketchDataById.get(slot.id) || null }
        : null));
    });
    return out;
  }

  // The mirror of the above, on open: bytes into the map, state left clean.
  function mpLoadProjectState(rawMainPage) {
    state.mainPage = rawMainPage && typeof rawMainPage === 'object' ? clone(rawMainPage) : null;
    mpSketchDataById.clear();
    const raw = (rawMainPage && rawMainPage.sketches) || {};
    MP_SKETCH_VARIANTS.forEach(v => {
      (raw[v] || []).forEach(slot => {
        if (slot && slot.id && slot.dataURL) mpSketchDataById.set(String(slot.id), slot.dataURL);
      });
    });
    return ensureMainPage();   // drops the injected dataURLs from state again
  }

  async function mpSetSketch(variant, i, dataURL) {
    const mp = ensureMainPage();
    const key = mpSketchVariant(variant);
    if (!dataURL) {
      mp.sketches[key][i] = null;
    } else {
      /* aspect is measured once here, not at render time: the preview sheet
         and the workbook both need it before an <img> exists. */
      let aspect = 1;
      try {
        const img = await loadImageFromDataURL(dataURL);
        aspect = Math.max(0.01, (img.naturalWidth || 1) / (img.naturalHeight || 1));
      } catch (err) { /* unreadable image still gets a slot, at 1:1 */ }
      const id = 'mp-sk-' + key + '-' + i + '-' + (++mpSketchSeq);
      mpSketchDataById.set(id, dataURL);
      mp.sketches[key][i] = { id, aspect };
    }
    mpCloseSketchMenu();
    mpRenderSketches();
    // The Preview & Export sheet shows the same slots; repaint it if that is
    // the page in view (same rule restoreSnapshot follows).
    if (state.activePage === 'preview' && typeof renderPreviewPage === 'function') renderPreviewPage();
    pushHistoryIfChanged();
  }

  /* One builder for the page and the Preview & Export sheet, so the two can
     never disagree about what a version panel shows (ADR 0046 rule 5).
     `editable` adds the screen-only clear button and the empty-slot prompt. */
  function mpSketchRowHtml(variant, editable) {
    const key = mpSketchVariant(variant);
    return MP_SKETCH_SLOTS.map((slot, i) => {
      const dataURL = mpSketchDataURL(key, i);
      const ref = key + ':' + i;
      const body = dataURL
        ? '<img class="mp-sk-img" src="' + escapeHtml(dataURL) + '" alt="' + slot.label + ' sketch">'
        : '<span class="mp-sk-empty">' + (editable ? '＋ ' : '') + slot.label + '</span>';
      return '<div class="mp-sketch' + (dataURL ? ' mp-sk-filled' : '') + '"'
        + (editable ? ' data-mp-sk="' + ref + '" title="Upload or paste the '
          + slot.label.toLowerCase() + ' technical flat"' : '')
        + '>' + body
        + '<span class="mp-sk-tag">' + slot.label + '</span>'
        + (editable && dataURL
          ? '<button type="button" class="mp-sk-x mp-screen-only" data-mp-sk-clear="' + ref
            + '" title="Remove this sketch">×</button>'
          : '')
        + '</div>';
    }).join('');
  }

  function mpRenderSketches() {
    Array.from(document.querySelectorAll('#mainPageOverlay .mp-sketchrow')).forEach(row => {
      row.innerHTML = mpSketchRowHtml(row.dataset.mpVariant, true);
    });
  }

  function renderMainPage() {
    if (!state.mainPage) return;
    mpRenderFields();
    mpRenderCw();
    mpRenderSketches();
    const prov = document.getElementById('mp-provenance');
    if (prov && prov !== document.activeElement) prov.textContent = state.mainPage.provenance || '';
  }

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

  /* ---- Sketch slot menu (forked from the BOM material-photo trigger) ------
     Upload or paste only: offline, no catalog, no auto-adoption. */

  let mpSketchOpen = null;   // 'lace:0' while a slot menu is open

  function mpSketchMenuEl() {
    let menu = document.getElementById('mpSketchMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'mpSketchMenu';
    menu.className = 'mp-menu mp-sketch-menu';
    menu.hidden = true;
    menu.innerHTML = '<div class="mp-sk-hint">Technical flat for this version — prints on the MAIN PAGE sheet.</div>'
      + '<div class="mp-sk-actions">'
      + '<button type="button" data-mp-sk-upload title="Or Cmd/Ctrl+V to paste a copied image">Upload&hellip; / Paste</button>'
      + '<button type="button" data-mp-sk-remove>Remove</button></div>';
    document.body.appendChild(menu);
    const filePick = document.createElement('input');
    filePick.type = 'file';
    filePick.accept = 'image/*';
    filePick.hidden = true;
    menu.appendChild(filePick);
    const applyFile = (f, ref) => {
      if (!f || !ref || !/^image\//i.test(f.type)) return;
      const [variant, i] = ref.split(':');
      const rd = new FileReader();
      rd.onload = () => mpSetSketch(variant, +i, rd.result);
      rd.readAsDataURL(f);
    };
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      const ref = mpSketchOpen;
      filePick.value = '';
      applyFile(f, ref);
    });
    menu.addEventListener('click', e => {
      if (!mpSketchOpen) return;
      if (e.target.closest('[data-mp-sk-upload]')) { filePick.click(); return; }
      if (e.target.closest('[data-mp-sk-remove]')) {
        const [variant, i] = mpSketchOpen.split(':');
        mpSetSketch(variant, +i, null);
      }
    });
    /* stopPropagation keeps the app's document-level paste router from also
       adopting the image as a Board sketch. */
    menu.addEventListener('paste', e => {
      if (!mpSketchOpen || !e.clipboardData) return;
      const it = Array.from(e.clipboardData.items)
        .find(x => x.kind === 'file' && /^image\//i.test(x.type));
      if (!it) return;
      const f = it.getAsFile();
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      applyFile(f, mpSketchOpen);
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { mpCloseSketchMenu(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
    });
    return menu;
  }

  function mpOpenSketchMenu(ref, box) {
    mpCloseFldMenu();
    if (mpColorWrap) mpColorWrap.classList.remove('open');
    mpSketchOpen = ref;
    const menu = mpSketchMenuEl();
    menu.hidden = false;
    menu.tabIndex = -1;   // focusable, so the paste event targets the menu
    const r = box.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 260)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 110) + 'px';
    menu.focus();
  }

  function mpCloseSketchMenu() {
    const menu = document.getElementById('mpSketchMenu');
    if (menu) menu.hidden = true;
    mpSketchOpen = null;
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
