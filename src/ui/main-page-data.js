// MAIN PAGE sheet — static rosters and pure helpers (US-068, ADR 0037).
// Source part for app.js. Run `npm run build` after editing.
//
// The data carried across verbatim from the tech pack's mod-main module: the
// field roster, the suggestion rosters mined from 52 historical packs, and the
// 47-entry Color Master List. No DOM, no state.mainPage mutation — the sheet
// state owner is main-page.js, the version sketches are in
// main-page-sketches.js, the field picker is in main-page-fields.js and the
// colorway picker is in main-page-colorways.js.
//
// MP_SHADE_RE and MP_FIELD_SPEC are built at top level, at load time, so this
// part must precede the rest of the main-page-* parts in
// scripts/source-parts.mjs.

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

  function mpDefaultColorLibrary() {
    return MP_COLOR_MASTER.map(n => ({ name: n, hex: mpShadeOf(n) }));
  }

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
