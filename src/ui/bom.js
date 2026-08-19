// BOM page: editable material table + material-key canvas annotation
// (US-072, ADR 0041). Source part for app.js. Run `npm run build` after
// editing.
//
// Rebuilt on this tool's primitives from the sibling tech-pack project's
// mod-bom module — that project has its own globals/closures with no shared
// module, so this is a fork, not a link (same pattern as MAIN PAGE/
// Construction, ADR 0037/0039). Static suggestion data is carried across
// verbatim in bom-material-data.js (BOM_MATERIAL_LIBRARY, 27 entries mined
// from 1,748 historical BOM records) — that file must load before this one
// (see scripts/source-parts.mjs).
//
// A row is { id, section:'FABRIC'|'TRIM', scope:'BOTH'|'SOLID'|'LACE',
// cells:{description, areaOfUse, supplier, article, width, size,
// composition}, cwOverride:{}, groupId?, photo?:{dataURL} } — groupId marks
// a size-split pair (x.1/x.2 numbering), photo is the MATERIAL IMAGES cell.
// state.bom is { rows, images:{solid:[],lace:[]}, callouts, seedId,
// schemaVersion } — seedId records that the
// reference seed (BM_SEED_ROWS, US-074) already ran for this project.
// One shared row list, scope-filtered per
// Solid/Lace sheet at render time via this page's `[data-bom-variant]` tabs
// — same convention as Construction's `[data-cc-variant]` (ADR 0040). `#` is
// computed live from render order (FABRIC rows then TRIM rows), never
// stored — same non-goal as Construction's seq.
//
// A callout is { id, rowId, imageId, variant, targets:[{nx,ny}, ...],
// textPos:{nx,ny} } — the "material key" annotation, placed on a BOM-owned
// image for that variant. It deliberately reuses Construction's exact
// multi-anchor/edge-leader-line/arrowhead/double-click-delete geometry,
// forked (not shared) under a bm* prefix, per this codebase's
// duplicate-over-premature-abstraction convention — there is no existing
// shared leader-line module to extract into. A callout's label text is
// derived live from its linked row's current number + description
// (`N. {description}`), never stored, matching how BOM row numbers are
// computed.
//
// Colorway columns finally consume state.mainPage.colorways — ADR 0037
// named this "knowingly inert" pending exactly this feature.
//
// The material-suggestion picker is a side-panel searchable list (mirroring
// Construction's phrase quick-list, ADR 0039), not the reference tool's
// per-cell floating popover. Picking a material always sets the selected
// row's description, and pre-fills areaOfUse/supplier/article/width/size
// only into cells the TD has not yet typed into — never overwrites.
//
// Dropped by ADR 0041: AI translation, bilingual cells, per-row reference
// photo + asset-management catalog matching, auto-draft-from-Construction,
// floating per-cell SuggMenu popover. Split-row (size-run pairing) was
// dropped here too but reintroduced by the US-072 follow-up — see
// bmSplitRow below.

  const BM_SCHEMA_VERSION = 2;
  const BM_SECTIONS = ['FABRIC', 'TRIM'];
  // Section bands + column contract mirror the reference factory sheet
  // (Tech pack Output/TechPack output.html mod-bom) exactly — order AND
  // bilingual header strings are copied verbatim from its D.bom.columns
  // (US-073): description, composition, supplier, article, width, size,
  // area_of_use. Header 中文 is static parity text; cell-CONTENT translation
  // stays dropped per ADR 0041 (offline, no API).
  const BM_SECTION_BANDS = { FABRIC: 'MAIN BODY FABRICS', TRIM: 'TRIMS / COMPONENTS' };
  const BM_CELL_FIELDS = ['description', 'composition', 'supplier', 'article', 'width', 'size', 'areaOfUse'];
  const BM_CELL_LABELS = {
    description: 'DESCRIPTION',
    composition: 'TYPE / COMPOSITION',
    supplier: 'SUPPLIER NAME',
    article: 'ARTICLE #',
    width: 'WIDTH',
    size: 'SIZE',
    areaOfUse: 'AREA OF USE',
  };
  const BM_CELL_LABELS_CN = {
    description: '描述',
    composition: '材质 / 成分',
    supplier: '供应商名称',
    article: '款号',
    width: '宽度',
    size: '尺码',
    areaOfUse: '使用部位',
  };
  const BM_PHOTO_LABEL = 'MATERIAL IMAGES';
  const BM_PHOTO_LABEL_CN = '材料图片';
  // The six columns the reference sheet marks SUGGESTABLE_COLS — each gets a
  // ▾ button in the cell. Composition has no library vocabulary.
  const BM_SUGGESTABLE_FIELDS = ['description', 'areaOfUse', 'supplier', 'article', 'width', 'size'];

  // US-074: a fresh BOM starts as the reference factory sheet's exact 12-row
  // BOM (Tech pack Output/TechPack output.html, #pack-data bom.rows, style
  // RSL vDraft 1.0) instead of empty. Every cell string is verbatim from that
  // JSON (area_of_use → areaOfUse only renames the key). `group` marks the
  // reference's two size-split pairs (group_id "strap-elastic" /
  // "nylon-coated-slider") and becomes one shared numeric groupId per pair at
  // seed time, so bmNumberedRows renders them 8.1/8.2 and 9.1/9.2 on the
  // SOLID sheet exactly like the reference. bom.seedId records that seeding
  // already happened: unlike MAIN PAGE fields, BOM rows are deletable on
  // purpose, so a TD who empties the table must NOT get the seed back on the
  // next load.
  const BM_SEED_ID = 'rsl-vdraft-1.0';
  const BM_SEED_ROWS = [
    { section: 'FABRIC', scope: 'BOTH', cells: {
      description: 'Shell fabric', composition: '', supplier: 'TBD',
      article: 'AF-SF-01', width: '58"', size: 'ALL',
      areaOfUse: 'Outer cup, outer cradle, outer UB, back panel' } },
    { section: 'TRIM', scope: 'BOTH', cells: {
      description: 'Two-piece molded foam cup', composition: '', supplier: '',
      article: 'need to source', width: '', size: 'To be size-wise graded',
      areaOfUse: 'Inner cup' } },
    { section: 'FABRIC', scope: 'BOTH', cells: {
      description: 'Power mesh -- front neckline yoke', composition: '', supplier: 'LiFeng',
      article: 'BR-ME-KT-NL-L-200-LF-338', width: '', size: 'ALL',
      areaOfUse: 'Front neckline yoke (outer + inner, both variants)' } },
    { section: 'FABRIC', scope: 'BOTH', cells: {
      description: 'Power mesh -- back panel (body fabric)', composition: '', supplier: '',
      article: '', width: '', size: 'ALL',
      areaOfUse: 'Back panel, full body from underarm to underband (outer, both variants)' } },
    { section: 'FABRIC', scope: 'LACE', cells: {
      description: 'Allover lace', composition: '', supplier: 'Yiyuan',
      article: 'N/A', width: '120cm', size: 'ALL',
      areaOfUse: 'Outer front cup (overlaid on shell layer)' } },
    { section: 'TRIM', scope: 'BOTH', cells: {
      description: 'Oval ring', composition: '', supplier: '',
      article: '', width: '3 cm (inner width)', size: 'ALL',
      areaOfUse: 'Strap hardware' } },
    { section: 'TRIM', scope: 'BOTH', cells: {
      description: 'Hook and eye', composition: '', supplier: 'Factory source',
      article: '', width: '5 rows (observed on sketch); column count TBC', size: 'ALL',
      areaOfUse: 'CB closure' } },
    { section: 'TRIM', scope: 'BOTH', cells: {
      description: 'Insert (encased) elastic- UB', composition: '', supplier: 'Mingshipai',
      article: 'D2008', width: '3 cm', size: 'ALL',
      areaOfUse: 'UB' } },
    { section: 'TRIM', scope: 'BOTH', group: 'strap-elastic', cells: {
      description: 'Strap elastic', composition: '', supplier: '',
      article: '', width: '', size: 'S, M, L, XL, M2',
      areaOfUse: 'Adjustable strap' } },
    { section: 'TRIM', scope: 'BOTH', group: 'strap-elastic', cells: {
      description: 'Strap elastic', composition: '', supplier: '',
      article: '', width: '', size: '2XL, 3XL, 4XL, 5XL, L2, XL2, 2XL2, 3XL2, 4XL2, 5XL2',
      areaOfUse: 'Adjustable strap' } },
    { section: 'TRIM', scope: 'BOTH', group: 'nylon-coated-slider', cells: {
      description: 'Nylon coated slider', composition: '', supplier: '',
      article: '', width: '', size: 'S, M, L, XL, M2',
      areaOfUse: 'Strap hardware, both attach ends (front + back)' } },
    { section: 'TRIM', scope: 'BOTH', group: 'nylon-coated-slider', cells: {
      description: 'Nylon coated slider', composition: '', supplier: '',
      article: '', width: '', size: '2XL, 3XL, 4XL, 5XL, L2, XL2, 2XL2, 3XL2, 4XL2, 5XL2',
      areaOfUse: 'Strap hardware, both attach ends (front + back)' } },
  ];

  const BM_PIN_RADIUS = 9;       // screen px at scale 1
  const BM_ANCHOR_RADIUS = 4;    // screen px, secondary leader-line dots (index > 0)
  const BM_HIT_RADIUS = 11;      // screen px, generous vs. the drawn pin/dot
  const BM_LABEL_HALF_W = 70;    // screen px hit-box half-width for the label
  const BM_LABEL_HALF_H = 12;    // screen px hit-box half-height for the label
  const BM_ARROW_SIZE = 7;       // screen px, leader-line arrowhead
  // #cc0066 is the reference sheet's material-key accent (its MK constant) —
  // distinct on purpose from Construction's blue and the leader-arrow red.
  const BM_CALLOUT_COLOR = '#cc0066';
  const BM_ORPHAN_COLOR = '#b3261e';

  // Session-only UI state — never persisted, same pattern as construction.js's
  // ccArmed/ccVariant module-level lets.
  let bmVariant = 'solid';       // 'solid' | 'lace' — shared by the table AND the material key
  let bmSelectedRowId = null;    // selected editable BOM row
  let bmSearchText = '';
  let bmMaterialHits = [];
  let bmTool = 'select';         // 'select' | 'callout' | 'leader'
  let bmSelectedCalloutId = null;
  let bmSelectedImageId = null;
  let bmDrag = null;             // callout anchor/label or BOM image drag
  let bmCanvasView = { offX: 0, offY: 0, scale: 1 };

  // Bitmap bytes deliberately live outside state.bom. History snapshots clone
  // state.bom frequently; embedding base64 there would duplicate every BOM
  // image for every cell edit. Project save injects the bytes, project load
  // extracts them again (the same split used by Board images/imageDataById).
  const bmImageDataById = new Map();
  const bmImageElementById = new Map();

  function bmVariantKey(variant) {
    return String(variant || bmVariant).toLowerCase() === 'lace' ? 'lace' : 'solid';
  }

  function bmVariantImages(variant) {
    const bom = ensureBom();
    const key = bmVariantKey(variant);
    return bom.images[key];
  }

  function bmImageRuntime(id) {
    return bmImageElementById.get(id) || null;
  }

  function bmStripImageForState(image) {
    return {
      id: image.id,
      x: Number(image.x) || 0,
      y: Number(image.y) || 0,
      width: Math.max(1, Number(image.width) || 1),
      height: Math.max(1, Number(image.height) || 1),
      aspect: Math.max(0.01, Number(image.aspect) || ((Number(image.width) || 1) / (Number(image.height) || 1))),
      locked: !!image.locked,
    };
  }

  function bmSerializeForProject() {
    const out = state.bom ? clone(state.bom) : null;
    if (!out || !out.images) return out;
    ['solid', 'lace'].forEach(variant => {
      out.images[variant] = (out.images[variant] || []).map(image => ({
        ...bmStripImageForState(image),
        dataURL: bmImageDataById.get(image.id) || null,
      }));
    });
    return out;
  }

  async function bmLoadProjectState(rawBom) {
    state.bom = rawBom && typeof rawBom === 'object' ? clone(rawBom) : null;
    bmImageDataById.clear();
    bmImageElementById.clear();
    const bom = ensureBom();
    const loads = [];
    ['solid', 'lace'].forEach(variant => {
      bom.images[variant] = (bom.images[variant] || []).map(image => {
        const meta = bmStripImageForState(image);
        if (image.dataURL) {
          bmImageDataById.set(meta.id, image.dataURL);
          loads.push(loadImageFromDataURL(image.dataURL)
            .then(img => bmImageElementById.set(meta.id, img))
            .catch(() => {}));
        }
        return meta;
      });
    });
    await Promise.all(loads);
    return bom;
  }

  function bmSeedComparableRows(rows) {
    const groupNames = new Map();
    return (rows || []).map(row => {
      let group = null;
      if (row.groupId != null) {
        if (!groupNames.has(row.groupId)) groupNames.set(row.groupId, 'g' + (groupNames.size + 1));
        group = groupNames.get(row.groupId);
      }
      return {
        section: row.section,
        scope: row.scope || 'BOTH',
        group,
        cells: BM_CELL_FIELDS.reduce((out, key) => {
          out[key] = String((row.cells && row.cells[key]) || '');
          return out;
        }, {}),
      };
    });
  }

  function bmExpectedSeedRows() {
    const groups = new Map();
    return BM_SEED_ROWS.map(seed => {
      let group = null;
      if (seed.group) {
        if (!groups.has(seed.group)) groups.set(seed.group, 'g' + (groups.size + 1));
        group = groups.get(seed.group);
      }
      return { section: seed.section, scope: seed.scope, group, cells: Object.assign({}, seed.cells) };
    });
  }

  function hasMeaningfulBomWork() {
    const bom = state && state.bom;
    if (!bom) return false;
    if ((bom.callouts || []).length) return true;
    if (bom.images && ((bom.images.solid || []).length || (bom.images.lace || []).length)) return true;
    if ((bom.rows || []).some(row => row.photo && row.photo.dataURL)) return true;
    if ((bom.rows || []).some(row => row.cwOverride && Object.keys(row.cwOverride).length)) return true;
    return JSON.stringify(bmSeedComparableRows(bom.rows)) !== JSON.stringify(bmExpectedSeedRows());
  }

  // Seeds state.bom in place. Safe to call repeatedly. Both callers that
  // matter for undo run before seedHistory() (state.js boot init and
  // project-io's loadProject), so the seeded rows are part of the history
  // baseline, never an undoable step.
  function ensureBom() {
    const bom = state.bom && typeof state.bom === 'object'
      ? state.bom
      : (state.bom = {});
    if (!Array.isArray(bom.rows)) bom.rows = [];
    if (!Array.isArray(bom.callouts)) bom.callouts = [];
    if (!bom.images || typeof bom.images !== 'object') bom.images = {};
    if (!Array.isArray(bom.images.solid)) bom.images.solid = [];
    if (!Array.isArray(bom.images.lace)) bom.images.lace = [];
    // First materialization of a project's BOM: fill the reference rows.
    // A bom that carries any seedId is stamped only — a TD-emptied table
    // stays empty, and a pre-seed project that already has rows keeps them.
    if (!bom.seedId) {
      if (!bom.rows.length && !bom.callouts.length) {
        const groupIds = {};
        BM_SEED_ROWS.forEach(seed => {
          const row = {
            id: state.idCounter++,
            section: seed.section,
            scope: seed.scope,
            cells: Object.assign({}, seed.cells),
            cwOverride: {},
          };
          if (seed.group) {
            if (groupIds[seed.group] == null) groupIds[seed.group] = state.idCounter++;
            row.groupId = groupIds[seed.group];
          }
          bom.rows.push(row);
        });
      }
      bom.seedId = BM_SEED_ID;
    }
    // Pre-0043 callouts pointed at Board images. Copy only the referenced
    // image metadata/bytes into the callout's variant so old projects reopen
    // without losing their Material Key. The two models are independent after
    // this one-time migration.
    if ((Number(bom.schemaVersion) || 0) < BM_SCHEMA_VERSION) {
      bom.callouts.forEach(callout => {
        const variant = bmVariantKey(callout.variant);
        if (bom.images[variant].some(image => image.id === callout.imageId)) return;
        const boardImage = (state.images || []).find(image => image.id === callout.imageId);
        if (!boardImage) return;
        bom.images[variant].push(bmStripImageForState(boardImage));
        const dataURL = imageDataById.get(boardImage.id) || boardImage.dataURL;
        if (dataURL) bmImageDataById.set(boardImage.id, dataURL);
        if (boardImage.img) bmImageElementById.set(boardImage.id, boardImage.img);
      });
      bom.schemaVersion = BM_SCHEMA_VERSION;
    }
    return bom;
  }

  function bmVisibleRows(variant) {
    const rows = (state.bom && state.bom.rows) || [];
    const v = String(variant || bmVariant).toUpperCase();
    return rows.filter(r => (r.scope || 'BOTH') === 'BOTH' || r.scope === v);
  }

  // FABRIC rows then TRIM rows, in list order — the only numbering BOM ever
  // computes; nothing stores it (mirrors Construction's per-sheet seq).
  // Consecutive rows sharing a groupId (size-split pairs, US-072 follow-up)
  // number as one base with .1/.2 children — same numbering the reference
  // sheet's numberRows() produces.
  function bmNumberedRows(variant) {
    const visible = bmVisibleRows(variant);
    const out = [];
    let base = 0;
    BM_SECTIONS.forEach(section => {
      const part = visible.filter(r => r.section === section);
      const groups = [];
      let cur = null, key = null;
      part.forEach(r => {
        const k = r.groupId != null ? 'g:' + r.groupId : 'id:' + r.id;
        if (cur && k === key) cur.push(r);
        else { if (cur) groups.push(cur); cur = [r]; key = k; }
      });
      if (cur) groups.push(cur);
      groups.forEach(g => {
        base += 1;
        if (g.length === 1) out.push({ row: g[0], seq: String(base), base: String(base) });
        else g.forEach((r, i) => out.push({ row: r, seq: base + '.' + (i + 1), base: String(base) }));
      });
    });
    return out;
  }

  function bmRowSeq(rowId, variant) {
    const hit = bmNumberedRows(variant).find(x => x.row.id === rowId);
    return hit ? hit.seq : null;
  }

  // The plain group number ("3" for a "3.1"/"3.2" split pair) — what the
  // material-key pin and label prefix show, mirroring the reference sheet's
  // dedup-by-base behaviour in its material key.
  function bmRowBase(rowId, variant) {
    const hit = bmNumberedRows(variant).find(x => x.row.id === rowId);
    return hit ? hit.base : null;
  }

  function bmRowById(id) {
    return ((state.bom && state.bom.rows) || []).find(r => r.id === id) || null;
  }

  function bmAddRow(section) {
    if (BM_SECTIONS.indexOf(section) === -1) return;
    const bom = ensureBom();
    const row = {
      id: state.idCounter++,
      section,
      scope: 'BOTH',
      cells: { description: '', composition: '', supplier: '', article: '', width: '', size: '', areaOfUse: '' },
      cwOverride: {},
    };
    bom.rows.push(row);
    bmSelectedRowId = row.id;
    renderBom();
    pushHistoryIfChanged();
  }

  // ADR 0044: the BOM row owns its Material Callouts. Remove the row and every
  // linked variant callout in one history transaction so table and Material
  // Key can never diverge; Undo restores both from the same snapshot.
  function bmRemoveRow(id) {
    const bom = ensureBom();
    const idx = bom.rows.findIndex(r => r.id === id);
    if (idx === -1) return;
    const removed = bom.callouts.filter(c => c.rowId === id);
    const removedIds = new Set(removed.map(c => c.id));
    bom.rows.splice(idx, 1);
    if (removed.length) bom.callouts = bom.callouts.filter(c => c.rowId !== id);
    if (bmSelectedRowId === id) bmSelectedRowId = null;
    if (removedIds.has(bmSelectedCalloutId)) bmSelectedCalloutId = null;
    if (bmTool === 'leader' && !bmSelectedCallout()) bmTool = 'select';
    renderBom();
    pushHistoryIfChanged();
    showToast('BOM row removed' + (removed.length ? ' with ' + removed.length + ' linked callout(s)' : '')
      + ' · Ctrl/Cmd+Z to undo');
  }

  // Size-split (reference ⎘): clones the row right below itself and marks
  // the pair with one shared groupId, so bmNumberedRows() renders them as
  // x.1/x.2 — the "same material, small-size run vs 2XL+ run" convention the
  // historical BOM corpus uses. Width/size are cleared on the clone (they
  // are exactly what differs between the two halves of a split).
  function bmSplitRow(id) {
    const bom = ensureBom();
    const idx = bom.rows.findIndex(r => r.id === id);
    if (idx === -1) return;
    const src = bom.rows[idx];
    if (src.groupId == null) src.groupId = state.idCounter++;
    const clone = {
      id: state.idCounter++,
      section: src.section,
      scope: src.scope || 'BOTH',
      groupId: src.groupId,
      cells: Object.assign({}, src.cells, { width: '', size: '' }),
      cwOverride: Object.assign({}, src.cwOverride),
    };
    bom.rows.splice(idx + 1, 0, clone);
    bmSelectedRowId = clone.id;
    renderBom();
    pushHistoryIfChanged();
    showToast('Row split into a size pair (.1/.2) · fill WIDTH/SIZE per run');
  }

  // A cwOverride key is only "set" if present at all — an explicit empty
  // string (TD cleared it on purpose) must still win over the colorway's
  // default name, so this checks key presence, not truthiness.
  function bmCwValue(row, cw) {
    const key = cw.col;
    if (row.cwOverride && Object.prototype.hasOwnProperty.call(row.cwOverride, key)) {
      return row.cwOverride[key];
    }
    return cw.value || '';
  }

  function bmMaterialMatches(m, tokens) {
    const s = m.name.toLowerCase();
    return tokens.every(t => s.includes(t));
  }

  // Fills the selected row's description (the point of picking a material)
  // and pre-fills the remaining suggestion fields only into cells the TD
  // has not already typed into — never overwrites a TD's own entry.
  function bmApplyMaterial(rowId, material) {
    const row = bmRowById(rowId);
    if (!row || !material) return;
    row.cells.description = material.name;
    if (!row.cells.areaOfUse && material.areaOptions && material.areaOptions.length) {
      row.cells.areaOfUse = material.areaOptions[0];
    }
    if (!row.cells.supplier && material.supplierOptions && material.supplierOptions.length) {
      row.cells.supplier = material.supplierOptions[0];
    }
    if (!row.cells.article && material.articleOptions && material.articleOptions.length) {
      row.cells.article = material.articleOptions[0];
    }
    if (!row.cells.width && material.width) row.cells.width = material.width;
    if (!row.cells.size && material.size) row.cells.size = material.size;
    renderBom();
    pushHistoryIfChanged();
  }

  function bmApplyMaterialByIndex(i) {
    const m = bmMaterialHits[i];
    if (m && bmSelectedRowId) bmApplyMaterial(bmSelectedRowId, m);
  }

  /* ---- In-cell suggestion menu (reference bom-dd / SuggMenu, simplified) --- */

  let bmDdOpenFor = null;   // 'rowId|field' the menu is open for, or null
  let bmDdItems = [];

  function bmMaterialInfoFor(description) {
    const key = String(description || '').trim().toLowerCase();
    if (!key) return null;
    return BOM_MATERIAL_LIBRARY.find(m => m.name.toLowerCase() === key) || null;
  }

  // Suggestions are offered, never auto-inserted — same "chọn tay, KHÔNG tự
  // điền" rule as the reference sheet. Non-description columns resolve from
  // the row's OWN material when its description matches a library entry.
  function bmSuggestItems(row, field) {
    const out = [];
    const add = (value, tag) => {
      if (value && !out.some(x => x.value === value)) out.push({ value, tag: tag || '' });
    };
    if (field === 'description') {
      BOM_MATERIAL_LIBRARY.forEach(m => add(m.name, m.section));
      return out;
    }
    const info = bmMaterialInfoFor(row.cells.description);
    if (field === 'areaOfUse') {
      if (info) (info.areaOptions || []).forEach(v => add(v));
      if (!out.length) {
        BOM_MATERIAL_LIBRARY.forEach(m => (m.areaOptions || []).forEach(v => add(v, m.name)));
      }
    } else if (field === 'supplier') {
      if (info) (info.supplierOptions || []).forEach(v => add(v));
    } else if (field === 'article') {
      if (info) (info.articleOptions || []).forEach(v => add(v));
    } else if (field === 'width') {
      if (info) add(info.width);
    } else if (field === 'size') {
      if (info) add(info.size);
      add('ALL', 'default');
    }
    return out;
  }

  function bmDdMenuEl() {
    let menu = document.getElementById('bomDdMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'bomDdMenu';
    menu.className = 'bm-dd-menu';
    menu.hidden = true;
    menu.innerHTML = '<input type="search" class="bm-dd-q" spellcheck="false" placeholder="Type to filter&hellip;">'
      + '<div class="bm-dd-list"></div>';
    document.body.appendChild(menu);
    menu.querySelector('.bm-dd-q').addEventListener('input', e => bmDdRenderList(e.target.value));
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { bmCloseDd(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        const first = menu.querySelector('.bm-dd-list [data-bm-pick]');
        if (first) bmDdPick(+first.dataset.bmPick);
      }
    });
    menu.addEventListener('click', e => {
      const pick = e.target.closest('[data-bm-pick]');
      if (pick) bmDdPick(+pick.dataset.bmPick);
    });
    return menu;
  }

  function bmDdRenderList(query) {
    const menu = bmDdMenuEl();
    const list = menu.querySelector('.bm-dd-list');
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length
      ? bmDdItems.filter(it => tokens.every(t => it.value.toLowerCase().includes(t)))
      : bmDdItems;
    list.innerHTML = hits.slice(0, 60).map(it =>
      '<button type="button" data-bm-pick="' + bmDdItems.indexOf(it) + '">'
      + escapeHtml(it.value)
      + (it.tag ? '<span class="bm-dd-tag">' + escapeHtml(it.tag) + '</span>' : '')
      + '</button>').join('')
      || '<div class="bm-dd-empty">Library has nothing for this cell yet — type your own value</div>';
  }

  function bmOpenDd(btn) {
    const [rowIdStr, field] = String(btn.dataset.bomDd).split('|');
    const row = bmRowById(+rowIdStr);
    if (!row) return;
    bmDdOpenFor = btn.dataset.bomDd;
    bmDdItems = bmSuggestItems(row, field);
    const menu = bmDdMenuEl();
    menu.hidden = false;
    const q = menu.querySelector('.bm-dd-q');
    q.value = '';
    bmDdRenderList('');
    const r = btn.getBoundingClientRect();
    const w = 300;
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 80) + 'px';
    q.focus();
  }

  function bmCloseDd() {
    const menu = document.getElementById('bomDdMenu');
    if (menu) menu.hidden = true;
    bmDdOpenFor = null;
  }

  function bmDdPick(index) {
    const it = bmDdItems[index];
    if (!it || !bmDdOpenFor) return;
    const [rowIdStr, field] = bmDdOpenFor.split('|');
    const row = bmRowById(+rowIdStr);
    bmCloseDd();
    if (!row) return;
    if (field === 'description') {
      // Route through the same fill-empty rule as the side-panel pick: sets
      // the description, pre-fills only cells the TD has not typed into.
      const material = bmMaterialInfoFor(it.value);
      if (material) { bmApplyMaterial(row.id, material); return; }
    }
    row.cells[field] = it.value;
    renderBom();
    pushHistoryIfChanged();
  }

  /* ---- Material photo cell (reference photo-trigger, offline-only) --------
     A row's photo is { dataURL } in row.photo — uploaded or pasted by the
     TD, stored in the project like board images. No catalog matching (the
     reference's exact-article/same-material badges need its photo catalog,
     which this offline tool does not carry). */

  let bmPhotoOpenRow = null;

  function bmSetRowPhoto(rowId, dataURL) {
    const row = bmRowById(rowId);
    if (!row) return;
    if (dataURL) row.photo = { dataURL };
    else delete row.photo;
    bmClosePhotoMenu();
    renderBom();
    pushHistoryIfChanged();
  }

  function bmPhotoMenuEl() {
    let menu = document.getElementById('bomPhotoMenu');
    if (menu) return menu;
    menu = document.createElement('div');
    menu.id = 'bomPhotoMenu';
    menu.className = 'bm-dd-menu bm-photo-menu';
    menu.hidden = true;
    menu.innerHTML = '<div class="bm-photo-hint">Material photo for this row — prints on the BOM sheet.</div>'
      + '<div class="bm-photo-actions">'
      + '<button type="button" data-bm-photo-upload title="Or Cmd/Ctrl+V to paste a copied image">Upload&hellip; / Paste</button>'
      + '<button type="button" data-bm-photo-clear>Remove</button></div>';
    document.body.appendChild(menu);
    const filePick = document.createElement('input');
    filePick.type = 'file';
    filePick.accept = 'image/*';
    filePick.hidden = true;
    menu.appendChild(filePick);
    filePick.addEventListener('change', () => {
      const f = filePick.files && filePick.files[0];
      const rowId = bmPhotoOpenRow;
      filePick.value = '';
      if (!f || rowId == null || !/^image\//i.test(f.type)) return;
      const rd = new FileReader();
      rd.onload = () => bmSetRowPhoto(rowId, rd.result);
      rd.readAsDataURL(f);
    });
    menu.addEventListener('click', e => {
      if (bmPhotoOpenRow == null) return;
      if (e.target.closest('[data-bm-photo-upload]')) { filePick.click(); return; }
      if (e.target.closest('[data-bm-photo-clear]')) bmSetRowPhoto(bmPhotoOpenRow, null);
    });
    // Paste lands here (not on the board): stopPropagation keeps the app's
    // document-level paste router from also adopting the image as a sketch.
    menu.addEventListener('paste', e => {
      if (bmPhotoOpenRow == null || !e.clipboardData) return;
      const it = Array.from(e.clipboardData.items)
        .find(x => x.kind === 'file' && /^image\//i.test(x.type));
      if (!it) return;
      const f = it.getAsFile();
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      const rowId = bmPhotoOpenRow;
      const rd = new FileReader();
      rd.onload = () => bmSetRowPhoto(rowId, rd.result);
      rd.readAsDataURL(f);
    });
    menu.addEventListener('keydown', e => {
      if (e.key === 'Escape') { bmClosePhotoMenu(); return; }
      if (e.key !== 'Tab') e.stopPropagation();
    });
    return menu;
  }

  function bmOpenPhotoMenu(btn) {
    bmCloseDd();
    bmPhotoOpenRow = +btn.dataset.bomPhoto;
    const menu = bmPhotoMenuEl();
    menu.hidden = false;
    // tabindex makes the menu focusable so the paste event targets it.
    menu.tabIndex = -1;
    const r = btn.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 240)) + 'px';
    menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 90) + 'px';
    menu.focus();
  }

  function bmClosePhotoMenu() {
    const menu = document.getElementById('bomPhotoMenu');
    if (menu) menu.hidden = true;
    bmPhotoOpenRow = null;
  }

  /* ---- Material-key annotation engine (forked from construction.js) ------ */

  function bmImageById(id, variant) {
    return bmVariantImages(variant).find(im => im.id === id) || null;
  }

  function bmImageBounds(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return { x: 0, y: 0, width: 1, height: 1 };
    const minX = Math.min(...images.map(im => im.x));
    const minY = Math.min(...images.map(im => im.y));
    const maxX = Math.max(...images.map(im => im.x + im.width));
    const maxY = Math.max(...images.map(im => im.y + im.height));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  function bmReflowImages(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return;
    const commonHeight = 300;
    const gap = 30;
    let x = 0;
    images.forEach(image => {
      image.height = commonHeight;
      image.width = commonHeight * (image.aspect || 1);
      image.x = x;
      image.y = 0;
      x += image.width + gap;
    });
  }

  async function bmAddImagesFromDataURLs(dataURLs, variant) {
    const key = bmVariantKey(variant);
    const images = bmVariantImages(key);
    let added = 0;
    for (const dataURL of dataURLs || []) {
      if (!dataURL) continue;
      const img = await loadImageFromDataURL(dataURL);
      const id = state.idCounter++;
      const aspect = img.height > 0 ? img.width / img.height : 1;
      images.push({ id, x: 0, y: 0, width: 300 * aspect, height: 300, aspect, locked: false });
      bmImageDataById.set(id, dataURL);
      bmImageElementById.set(id, img);
      added += 1;
    }
    if (!added) return 0;
    bmReflowImages(key);
    bmSelectedImageId = null;
    bmSelectedCalloutId = null;
    if (bmTool === 'leader') bmTool = 'select';
    renderBom();
    pushHistoryIfChanged();
    showToast(added === 1
      ? '1 image added to the ' + key.toUpperCase() + ' Material Key.'
      : added + ' images added to the ' + key.toUpperCase() + ' Material Key.');
    return added;
  }

  async function bmAddImageFiles(files, variant) {
    const imageFiles = Array.from(files || []).filter(file => file && /^image\//i.test(file.type || ''));
    if (!imageFiles.length) {
      showToast('Add PNG, JPEG, or WebP images to the Material Key.');
      return 0;
    }
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    return bmAddImagesFromDataURLs(dataURLs, variant);
  }

  function bmDeleteSelectedImage() {
    const image = bmImageById(bmSelectedImageId);
    if (!image) { showToast('Select a Material Key image first.'); return; }
    const linked = bmVisibleCallouts().filter(callout => callout.imageId === image.id);
    if (linked.length && !window.confirm(
      'Delete this image and its ' + linked.length + ' linked material callout(s)?\n\nUndo restores both.'
    )) return;
    const images = bmVariantImages();
    images.splice(images.indexOf(image), 1);
    if (linked.length) {
      const ids = new Set(linked.map(callout => callout.id));
      state.bom.callouts = state.bom.callouts.filter(callout => !ids.has(callout.id));
    }
    bmSelectedImageId = null;
    bmSelectedCalloutId = null;
    bmReflowImages();
    renderBom();
    pushHistoryIfChanged();
  }

  function bmZoomSelectedImage(factor) {
    const image = bmImageById(bmSelectedImageId);
    if (!image) { showToast('Select a Material Key image first.'); return; }
    const nextWidth = clamp(image.width * factor, 60, 1800);
    const nextHeight = nextWidth / (image.aspect || (image.width / image.height) || 1);
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    image.width = nextWidth;
    image.height = nextHeight;
    image.x = cx - nextWidth / 2;
    image.y = cy - nextHeight / 2;
    renderBom();
    pushHistoryIfChanged();
  }

  function bmVisibleCallouts() {
    const callouts = (state.bom && state.bom.callouts) || [];
    return callouts.filter(c => (c.variant || 'solid') === bmVariant);
  }

  function bmSelectedCallout() {
    return bmVisibleCallouts().find(c => c.id === bmSelectedCalloutId) || null;
  }

  function bmCalloutForRow(rowId, variant) {
    const key = bmVariantKey(variant);
    return (((state.bom && state.bom.callouts) || []).find(c =>
      c.rowId === rowId && bmVariantKey(c.variant) === key)) || null;
  }

  function bmMissingCalloutRows(variant) {
    const key = bmVariantKey(variant);
    return bmNumberedRows(key).map(x => x.row)
      .filter(row => !bmCalloutForRow(row.id, key));
  }

  function bmNextMissingCalloutRow(afterRowId, variant) {
    const key = bmVariantKey(variant);
    const ordered = bmNumberedRows(key).map(x => x.row);
    if (!ordered.length) return null;
    const start = Math.max(-1, ordered.findIndex(row => row.id === afterRowId));
    for (let step = 1; step <= ordered.length; step += 1) {
      const row = ordered[(start + step) % ordered.length];
      if (!bmCalloutForRow(row.id, key)) return row;
    }
    return null;
  }

  function bmWorldOf(imageRec, norm) {
    return { x: imageRec.x + norm.nx * imageRec.width, y: imageRec.y + norm.ny * imageRec.height };
  }

  function bmNormalize(imageRec, pt) {
    return { nx: (pt.x - imageRec.x) / imageRec.width, ny: (pt.y - imageRec.y) / imageRec.height };
  }

  function bmWorldToCanvas(pt) {
    return { x: pt.x * bmCanvasView.scale + bmCanvasView.offX, y: pt.y * bmCanvasView.scale + bmCanvasView.offY };
  }

  function bmCanvasPointFromEvent(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    return { x: (cx - bmCanvasView.offX) / bmCanvasView.scale, y: (cy - bmCanvasView.offY) / bmCanvasView.scale };
  }

  function bmImageAt(pt) {
    const images = bmVariantImages();
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const im = images[i];
      if (pt.x >= im.x && pt.x <= im.x + im.width && pt.y >= im.y && pt.y <= im.y + im.height) return im;
    }
    return null;
  }

  // Hit-tests every leader-line anchor (not just the first) before falling
  // back to the label box, so a double-click on a secondary arrowhead can
  // remove just that leader line.
  function bmHitTest(pt) {
    const callouts = bmVisibleCallouts();
    const rWorld = BM_HIT_RADIUS / bmCanvasView.scale;
    const halfW = BM_LABEL_HALF_W / bmCanvasView.scale;
    const halfH = BM_LABEL_HALF_H / bmCanvasView.scale;
    for (let i = callouts.length - 1; i >= 0; i -= 1) {
      const c = callouts[i];
      const im = bmImageById(c.imageId);
      if (!im) continue;
      const targets = c.targets || [];
      for (let ti = targets.length - 1; ti >= 0; ti -= 1) {
        const pin = bmWorldOf(im, targets[ti]);
        if (Math.hypot(pt.x - pin.x, pt.y - pin.y) <= rWorld) {
          return { callout: c, part: 'anchor', anchorIndex: ti, imageRec: im };
        }
      }
      const label = bmWorldOf(im, c.textPos);
      if (Math.abs(pt.x - label.x) <= halfW && Math.abs(pt.y - label.y) <= halfH) {
        return { callout: c, part: 'label', imageRec: im };
      }
      for (let ti = targets.length - 1; ti >= 0; ti -= 1) {
        const pin = bmWorldOf(im, targets[ti]);
        if (bmDistanceToSegment(pt, label, pin) <= (6 / bmCanvasView.scale)) {
          return { callout: c, part: 'line', anchorIndex: ti, imageRec: im };
        }
      }
    }
    return null;
  }

  function bmDistanceToSegment(pt, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return Math.hypot(pt.x - a.x, pt.y - a.y);
    const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(pt.x - (a.x + t * dx), pt.y - (a.y + t * dy));
  }

  function bmCreateCalloutAt(pt) {
    const im = bmImageAt(pt);
    if (!im) { showToast('Click on a sketch image to place a material-key callout'); return; }
    const rows = bmMissingCalloutRows(bmVariant);
    if (!rows.length) {
      bmSetTool('select');
      showToast('Every visible BOM row already has a callout');
      return;
    }
    const bom = ensureBom();
    const target = bmNormalize(im, pt);
    const rowId = (bmSelectedRowId && rows.some(r => r.id === bmSelectedRowId)) ? bmSelectedRowId : rows[0].id;
    // Start the label on the roomier side of the target and keep its baseline
    // inside the image. Drawing then connects every leader from the nearest
    // edge of the label box, so TDs rarely need a cleanup drag after placement.
    const textPos = {
      nx: clamp(target.nx + (target.nx > 0.65 ? -0.28 : 0.08), 0.02, 0.90),
      ny: clamp(target.ny - 0.03, 0.04, 0.96),
    };
    const callout = {
      id: state.idCounter++,
      rowId,
      imageId: im.id,
      variant: bmVariant,
      targets: [target],
      textPos,
    };
    bom.callouts.push(callout);
    const next = bmNextMissingCalloutRow(rowId, bmVariant);
    if (next) {
      bmSelectedRowId = next.id;
      bmSelectedCalloutId = null;
    } else {
      bmSelectedRowId = rowId;
      bmSelectedCalloutId = callout.id;
      bmTool = 'select';
    }
    renderBom();
    pushHistoryIfChanged();
    showToast(next
      ? 'Callout added · next row ' + (bmRowSeq(next.id, bmVariant) || '') + '. ' + bmShortLabel(next.cells.description || '(empty)')
      : 'All visible BOM rows now have callouts · Select is active');
  }

  // Add Leaders is a persistent tool: every valid click adds one image-local
  // target to the selected callout until Select or Escape ends the mode.
  function bmAddArrowAt(pt) {
    const c = bmSelectedCallout();
    if (!c) { showToast('Select a callout first'); return; }
    const im = bmImageById(c.imageId);
    if (!im) return;
    if (bmImageAt(pt) !== im) {
      showToast('Add the leader inside the selected callout\'s own image');
      return;
    }
    c.targets.push(bmNormalize(im, pt));
    renderBom();
    pushHistoryIfChanged();
    showToast('Leader ' + c.targets.length + ' added · click again, or Select/Esc to finish');
  }

  // Double-clicking an arrowhead removes just that leader line. A callout
  // must keep at least one — deleting the last one is a no-op (use Delete
  // callout to remove it entirely), matching Construction's convention.
  function bmDeleteAnchorAt(pt) {
    const hit = bmHitTest(pt);
    if (!hit || hit.part !== 'anchor') return;
    if (hit.callout.targets.length <= 1) {
      showToast('A callout needs at least one arrow — use Delete callout to remove it entirely');
      return;
    }
    hit.callout.targets.splice(hit.anchorIndex, 1);
    renderBom();
    pushHistoryIfChanged();
  }

  // Reference ⊕ (data-mk): jump straight to the Material Key armed for THIS
  // row — the next sketch click drops its numbered callout. If the row
  // prints on a single sheet, follow it onto that variant first, so the
  // callout lands on (and stays filtered to) the row's own sheet.
  function bmArmRowCallout(rowId) {
    const row = bmRowById(rowId);
    if (!row) return;
    const scope = row.scope || 'BOTH';
    if (scope !== 'BOTH' && scope.toLowerCase() !== bmVariant) {
      bmVariant = scope.toLowerCase();
      bmSyncVariantTabs();
    }
    bmSelectedRowId = rowId;
    const existing = bmCalloutForRow(rowId, bmVariant);
    if (existing) {
      bmSelectedCalloutId = existing.id;
      bmSelectedImageId = null;
      bmSetTool('select');
    } else {
      bmSelectedCalloutId = null;
      bmSelectedImageId = null;
      bmSetTool('callout');
    }
    renderBom();
    const mkView = document.getElementById('bomMatkeyView');
    if (mkView) mkView.scrollIntoView({ block: 'start' });
    showToast(existing
      ? 'Selected the existing callout for row ' + (bmRowSeq(rowId, bmVariant) || '')
      : 'Click the sketch to place the callout for row ' + (bmRowSeq(rowId, bmVariant) || ''));
  }

  function bmDeleteSelectedCallout() {
    const c = bmSelectedCallout();
    if (!c) return;
    const callouts = state.bom.callouts;
    const idx = callouts.indexOf(c);
    if (idx === -1) return;
    callouts.splice(idx, 1);
    bmSelectedCalloutId = null;
    if (bmTool === 'leader') bmTool = 'select';
    renderBom();
    pushHistoryIfChanged();
    showToast('Deleted callout · Ctrl/Cmd+Z to undo');
  }

  // Reference shortLabel(): first comma-clause of the description, 40 chars.
  function bmShortLabel(d) {
    return String(d || '').split(',')[0].replace(/ -- /g, ' – ').slice(0, 40);
  }

  function bmCalloutLabelText(c) {
    const row = bmRowById(c.rowId);
    if (!row) return '? deleted BOM row';
    const base = bmRowBase(c.rowId, bmVariant);
    return (base || '?') + '. ' + (bmShortLabel(row.cells.description) || '(empty)');
  }

  function bmSetTool(tool) {
    if (tool !== 'select' && tool !== 'callout' && tool !== 'leader') tool = 'select';
    if (tool === 'leader' && !bmSelectedCallout()) {
      showToast('Select a callout before adding leaders');
      tool = 'select';
    }
    bmTool = tool;
    bmSyncToolUi();
  }

  function bmStartCalloutTool(preferredRowId) {
    const missing = bmMissingCalloutRows(bmVariant);
    if (!missing.length) {
      bmSetTool('select');
      showToast('Every visible BOM row already has a callout');
      return;
    }
    const preferred = missing.find(row => row.id === preferredRowId)
      || missing.find(row => row.id === bmSelectedRowId)
      || missing[0];
    bmSelectedRowId = preferred.id;
    bmSelectedCalloutId = null;
    bmSelectedImageId = null;
    bmSetTool('callout');
    renderBom();
    showToast('Add Callouts · place row ' + (bmRowSeq(preferred.id, bmVariant) || '')
      + '. ' + bmShortLabel(preferred.cells.description || '(empty)'));
  }

  function bmSyncToolUi() {
    const tools = {
      select: document.getElementById('bomSelectToolBtn'),
      callout: document.getElementById('bomAddCalloutBtn'),
      leader: document.getElementById('bomAddArrowBtn'),
    };
    Object.keys(tools).forEach(tool => {
      const btn = tools[tool];
      if (!btn) return;
      const active = bmTool === tool;
      btn.classList.toggle('bm-tool-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    if (tools.leader) tools.leader.disabled = !bmSelectedCallout();
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (canvas) {
      canvas.classList.remove('bm-tool-select', 'bm-tool-callout', 'bm-tool-leader');
      canvas.classList.add('bm-tool-' + bmTool);
    }
    const hint = document.getElementById('bomToolHint');
    if (hint) {
      if (bmTool === 'callout') {
        const row = bmSelectedRowId ? bmRowById(bmSelectedRowId) : null;
        hint.textContent = 'Add Callouts: place ' + (row ? (bmRowSeq(row.id, bmVariant) || '') + '. ' + bmShortLabel(row.cells.description || '(empty)') : 'the highlighted row')
          + '; Select/Esc finishes.';
      } else if (bmTool === 'leader') {
        hint.textContent = 'Add Leaders: click multiple targets on the selected callout image; Select/Esc finishes.';
      } else {
        hint.textContent = 'Select a callout label, leader, or target to adjust it.';
      }
    }
  }

  function bmSyncVariantTabs() {
    document.querySelectorAll('[data-bom-variant]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.bomVariant === bmVariant));
    });
  }

  function bmSyncSelectedRowClass() {
    document.querySelectorAll('#bomSections tr[data-bom-row]').forEach(tr => {
      tr.classList.toggle('bm-row-selected', String(bmSelectedRowId) === tr.dataset.bomRow);
    });
  }

  /* ---- Rendering ----------------------------------------------------------- */

  function renderBom() {
    if (!state.bom) return;
    if (bmTool === 'leader' && !bmSelectedCallout()) bmTool = 'select';
    bmRenderTable();
    bmDrawCanvas();
    bmRenderCalloutSidePanel();
    bmSyncToolUi();
  }

  // One factory-style table per sheet — section band rows (MAIN BODY
  // FABRICS / TRIMS / COMPONENTS) with the header row repeated under each
  // band and an add-row line per section, matching the reference sheet's
  // renderTable() structure. Numbering runs continuously across sections.
  // Bilingual header row shared by the screen table and the print sheets —
  // EN label + the reference's verbatim 中文 string in a .bm-cn span (a
  // sibling of the text, mirroring the reference's <span class='cn'>).
  function bmHeaderRowHtml(colorways, withActCol) {
    return '<tr class="bm-hdr"><th class="bm-num">#</th>'
      + BM_CELL_FIELDS.map(f => '<th>' + escapeHtml(BM_CELL_LABELS[f])
        + '<span class="bm-cn">' + BM_CELL_LABELS_CN[f] + '</span></th>').join('')
      + '<th>' + BM_PHOTO_LABEL + '<span class="bm-cn">' + BM_PHOTO_LABEL_CN + '</span></th>'
      + colorways.map(c => '<th>' + escapeHtml(c.col) + '</th>').join('')
      + (withActCol ? '<th class="act">&middot;</th>' : '')
      + '</tr>';
  }

  function bmColgroupHtml(colorways, withActCol) {
    return '<colgroup>'
      + '<col class="bm-col-num">'
      + '<col class="bm-col-description"><col class="bm-col-composition">'
      + '<col class="bm-col-supplier"><col class="bm-col-article">'
      + '<col class="bm-col-width"><col class="bm-col-size">'
      + '<col class="bm-col-area"><col class="bm-col-photo">'
      + colorways.map(() => '<col class="bm-col-colorway">').join('')
      + (withActCol ? '<col class="bm-col-actions">' : '')
      + '</colgroup>';
  }

  // Reference .sheethead: a style meta line (.shl) + the sheet name (.shm),
  // composed live from MAIN PAGE fields — Range Name, Style No, tech-pack
  // creation date — skipping blanks and TBC placeholders.
  // The style meta line as plain text — shared by the HTML sheet head and
  // the tech-pack Excel meta row (US-079), so both always agree.
  function bmSheetMetaText() {
    const fields = (state.mainPage && state.mainPage.fields) || [];
    const val = re => {
      const hit = fields.find(f => re.test(String((f && f.label) || '')));
      const v = hit ? String(hit.value || '').trim() : '';
      return /^TBC$/i.test(v) ? '' : v;
    };
    const styleNo = val(/^Style No\s*-/i);
    return [
      val(/^Range Name\b/i),
      styleNo ? 'Style # ' + styleNo : '',
      val(/Tech Pack Creation date/i),
    ].filter(Boolean).join(' · ');
  }

  function bmSheetHeadHtml(variant) {
    return '<div class="bm-sheet-head"><div class="bm-shl">'
      + escapeHtml(bmSheetMetaText()) + '</div><div class="bm-shm">BOM-'
      + String(variant).toUpperCase() + '</div></div>';
  }

  function bmRenderTable() {
    const host = document.getElementById('bomSections');
    if (!host) return;
    const sheetHead = document.getElementById('bomSheetHead');
    if (sheetHead) sheetHead.innerHTML = bmSheetHeadHtml(bmVariant);
    const colorways = (state.mainPage && state.mainPage.colorways) || [];
    const span = 1 + BM_CELL_FIELDS.length + 1 + colorways.length + 1;
    const hdr = bmHeaderRowHtml(colorways, true);
    const numbered = bmNumberedRows(bmVariant);
    let html = '';
    BM_SECTIONS.forEach(section => {
      html += '<tr><td class="bm-secband" colspan="' + span + '">'
        + escapeHtml(BM_SECTION_BANDS[section]) + '</td></tr>' + hdr;
      html += numbered.filter(x => x.row.section === section)
        .map(x => bmRenderRow(x.row, x.seq, colorways)).join('');
      html += '<tr class="bm-addrow-tr"><td colspan="' + span + '">'
        + '<button type="button" class="bm-addrow" data-bom-add="' + section + '">&#65291; Dòng '
        + escapeHtml(section) + '</button></td></tr>';
    });
    host.innerHTML = '<div class="bm-band">Bill of Materials Sheet</div>'
      + '<table class="bm-table">' + bmColgroupHtml(colorways, true)
      + '<tbody>' + html + '</tbody></table>';
    bmRenderPrintSheets();
  }

  // Print parity (US-073): the reference prints BOM-SOLID then BOM-LACE as
  // two factory sheets regardless of which tab is open on screen. Rendered
  // into a print-only container (#bomPrintSheets, shown by the @media print
  // rules) so the interactive screen table — and every #bomSections-scoped
  // selector bom-check relies on — stays untouched. No editor affordances
  // here: no ▾, no action column, no add-row line, plain text cells.
  function bmRenderPrintSheets() {
    const host = document.getElementById('bomPrintSheets');
    if (!host) return;
    host.innerHTML = ['solid', 'lace'].map(variant =>
      '<section class="bm-print-sheet">' + bmPrintSheetHtml(variant) + '</section>').join('');
  }

  // One variant's full factory sheet (head + material key + table) as plain
  // non-interactive HTML. Extracted from bmRenderPrintSheets (US-079) so the
  // Preview & Export page shows the exact same sheet the print path produces.
  function bmPrintSheetHtml(variant) {
    const colorways = (state.mainPage && state.mainPage.colorways) || [];
    const span = 1 + BM_CELL_FIELDS.length + 1 + colorways.length;
    const hdr = bmHeaderRowHtml(colorways, false);
    const numbered = bmNumberedRows(variant);
    let html = '';
    BM_SECTIONS.forEach(section => {
      html += '<tr><td class="bm-secband" colspan="' + span + '">'
        + escapeHtml(BM_SECTION_BANDS[section]) + '</td></tr>' + hdr;
      html += numbered.filter(x => x.row.section === section)
        .map(x => bmRenderPrintRow(x.row, x.seq, colorways)).join('');
    });
    return '<div class="bm-sheet">' + bmSheetHeadHtml(variant)
      + '<div class="bm-band bm-band-big">Fabric and Trim Requirement</div>'
      + bmPrintMaterialKeyHtml(variant)
      + '<div class="bm-band">Bill of Materials Sheet</div>'
      + '<table class="bm-table">' + bmColgroupHtml(colorways, false)
      + '<tbody>' + html + '</tbody></table></div>';
  }

  function bmPrintMaterialKeyHtml(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return '<div class="bm-print-matkey bm-print-matkey-empty"></div>';
    const W = 1900, H = 820, pad = 55;
    const bounds = bmImageBounds(variant);
    const scale = Math.min((W - pad * 2) / bounds.width, (H - pad * 2) / bounds.height);
    const offX = (W - bounds.width * scale) / 2 - bounds.x * scale;
    const offY = (H - bounds.height * scale) / 2 - bounds.y * scale;
    const project = pt => ({ x: pt.x * scale + offX, y: pt.y * scale + offY });
    const imageHtml = images.map(image => {
      const dataURL = bmImageDataById.get(image.id);
      if (!dataURL) return '';
      const p = project({ x: image.x, y: image.y });
      return '<img src="' + dataURL + '" alt="" style="left:' + (p.x / W * 100)
        + '%;top:' + (p.y / H * 100) + '%;width:' + (image.width * scale / W * 100)
        + '%;height:' + (image.height * scale / H * 100) + '%">';
    }).join('');
    let svg = '';
    let labels = '';
    const callouts = ((state.bom && state.bom.callouts) || [])
      .filter(callout => bmVariantKey(callout.variant) === bmVariantKey(variant));
    callouts.forEach(callout => {
      const image = bmImageById(callout.imageId, variant);
      if (!image) return;
      const label = project(bmWorldOf(image, callout.textPos));
      const text = bmCalloutLabelTextForVariant(callout, variant);
      const labelBox = { x: label.x - 4, y: label.y - 9, width: Math.max(20, text.length * 6.5 + 8), height: 18 };
      (callout.targets || []).forEach(target => {
        const pin = project(bmWorldOf(image, target));
        const edge = bmEdgeToward(labelBox, pin.x, pin.y) || label;
        svg += '<line x1="' + edge.x + '" y1="' + edge.y + '" x2="' + pin.x + '" y2="' + pin.y + '"></line>'
          + '<circle cx="' + pin.x + '" cy="' + pin.y + '" r="7"></circle>';
      });
      labels += '<div class="bm-print-label" style="left:' + (label.x / W * 100)
        + '%;top:' + (label.y / H * 100) + '%">' + escapeHtml(text) + '</div>';
    });
    return '<div class="bm-print-matkey">' + imageHtml
      + '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + svg + '</svg>'
      + labels + '</div>';
  }

  function bmCalloutLabelTextForVariant(callout, variant) {
    const row = bmRowById(callout.rowId);
    if (!row) return '? deleted BOM row';
    const base = bmRowBase(callout.rowId, variant);
    return (base || '?') + '. ' + (bmShortLabel(row.cells.description) || '(empty)');
  }

  function bmRenderPrintRow(row, seq, colorways) {
    const cells = BM_CELL_FIELDS.map(f => '<td>' + escapeHtml(row.cells[f] || '') + '</td>').join('');
    const photo = '<td class="bm-photo-cell">'
      + (row.photo && row.photo.dataURL ? '<img src="' + row.photo.dataURL + '" alt="">' : '')
      + '</td>';
    const cw = colorways.map(c => '<td>' + escapeHtml(bmCwValue(row, c)) + '</td>').join('');
    return '<tr><td class="bm-num">' + seq + '</td>' + cells + photo + cw + '</tr>';
  }

  function bmRenderRow(row, seq, colorways) {
    // Editable content lives in an inner span (reference structure): the ▾
    // suggestion button is a plain sibling of the span, so it can never be
    // typed over or swallowed into the cell's textContent.
    const cells = BM_CELL_FIELDS.map(f => {
      const suggestable = BM_SUGGESTABLE_FIELDS.indexOf(f) !== -1;
      return '<td' + (suggestable ? ' class="bm-sugg"' : '') + '>'
        + '<span contenteditable spellcheck="false" data-row="' + row.id + '" data-cell="' + f + '">'
        + escapeHtml(row.cells[f] || '') + '</span>'
        + (suggestable
          ? '<button type="button" class="bm-dd" data-bom-dd="' + row.id + '|' + f
            + '" tabindex="-1" title="Suggestions from the material library — pick by hand, never auto-filled"></button>'
          : '')
        + '</td>';
    }).join('');
    const photoCell = '<td class="bm-photo-cell"><button type="button" class="bm-photo-trigger" data-bom-photo="'
      + row.id + '" title="Material photo — upload or paste an image">'
      + (row.photo && row.photo.dataURL ? '<img src="' + row.photo.dataURL + '" alt="">' : '+')
      + '</button></td>';
    const cw = colorways.map(c =>
      '<td contenteditable spellcheck="false" data-row="' + row.id + '" data-cw="' + escapeHtml(c.col) + '">'
      + escapeHtml(bmCwValue(row, c)) + '</td>').join('');
    const scope = row.scope || 'BOTH';
    const act = '<td class="act">'
      + '<button type="button" data-row="' + row.id + '" data-bom-mk title="Place this row&#39;s numbered callout on the Material Key">&#8853;</button>'
      + '<button type="button" data-row="' + row.id + '" data-bom-split title="Split into a size pair (.1/.2)">&#9112;</button>'
      + '<button type="button" data-row="' + row.id + '" data-bom-rm title="Delete row">&times;</button>'
      + '<select data-row="' + row.id + '" data-scope aria-label="Scope" title="Which sheet prints this row">'
      + ['BOTH', 'SOLID', 'LACE'].map(s =>
        '<option value="' + s + '"' + (scope === s ? ' selected' : '') + '>' + s + '</option>').join('')
      + '</select></td>';
    const selectedCls = row.id === bmSelectedRowId ? ' class="bm-row-selected"' : '';
    return '<tr data-bom-row="' + row.id + '"' + selectedCls + '>'
      + '<td class="bm-num">' + seq + '</td>' + cells + photoCell + cw + act + '</tr>';
  }

  function bmRenderMaterialPanel() {
    const empty = document.getElementById('bomMatEmpty');
    const panel = document.getElementById('bomMatPanel');
    if (!empty || !panel) return;
    const row = bmSelectedRowId ? bmRowById(bmSelectedRowId) : null;
    if (!row) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }
    empty.hidden = true;
    panel.hidden = false;
    const label = document.getElementById('bomMatRowLabel');
    if (label) {
      const seq = bmRowSeq(row.id, bmVariant);
      label.textContent = (seq ? seq + '. ' : '') + (row.cells.description || '(empty description)');
    }
    bmRenderMaterialList();
  }

  function bmRenderMaterialList() {
    const box = document.getElementById('bomMatList');
    if (!box) return;
    const tokens = bmSearchText.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = tokens.length
      ? BOM_MATERIAL_LIBRARY.filter(m => bmMaterialMatches(m, tokens))
      : BOM_MATERIAL_LIBRARY;
    bmMaterialHits = hits.slice(0, 60);
    box.innerHTML = bmMaterialHits.map((m, i) =>
      '<button type="button" data-bom-mat="' + i + '">' + escapeHtml(m.name)
      + '<span class="bm-mat-section">' + escapeHtml(m.section) + '</span></button>').join('')
      || '<div class="bm-mat-empty">No material matches — type your own description in the row</div>';
  }

  function bmDrawCanvas() {
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    bmDrawCanvasInto(canvas, rect.width, rect.height, dpr);
  }

  // Draw the active variant's Material Key (images + callouts) into any
  // canvas at a given CSS size and pixel scale. Extracted from bmDrawCanvas
  // (US-079) so the tech-pack Excel export can render a chosen variant
  // offscreen through the same drawing code the live Material Key uses.
  function bmDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale) {
    const w = Math.max(1, Math.round(cssWidth * pixelScale));
    const h = Math.max(1, Math.round(cssHeight * pixelScale));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const images = bmVariantImages();
    if (!images.length) {
      ctx.fillStyle = '#8a8f9a';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Paste, drop, or add images to this ' + bmVariant.toUpperCase() + ' Material Key.', cssWidth / 2, cssHeight / 2);
      bmCanvasView = { offX: cssWidth / 2, offY: cssHeight / 2, scale: 1 };
      return;
    }

    const bounds = bmImageBounds();
    const pad = 40;
    const scale = Math.min(
      (cssWidth - pad * 2) / bounds.width,
      (cssHeight - pad * 2) / bounds.height,
      4
    );
    const offX = (cssWidth - bounds.width * scale) / 2 - bounds.x * scale;
    const offY = (cssHeight - bounds.height * scale) / 2 - bounds.y * scale;
    bmCanvasView = { offX, offY, scale };

    ctx.save();
    ctx.translate(offX, offY);
    ctx.scale(scale, scale);
    images.forEach(image => {
      const img = bmImageRuntime(image.id);
      if (img) ctx.drawImage(img, image.x, image.y, image.width, image.height);
      if (image.id === bmSelectedImageId) {
        ctx.strokeStyle = '#356dff';
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(image.x, image.y, image.width, image.height);
      }
    });
    ctx.restore();

    bmVisibleCallouts().forEach(c => bmDrawCallout(ctx, c, c.id === bmSelectedCalloutId));
  }

  // Offscreen render of ONE variant's Material Key for the tech-pack Excel
  // export (US-079). Swaps the module view state so the shared draw code
  // targets the requested variant with no selection chrome, and restores it
  // in finally — bmCanvasView is the live canvas's hit-test mapping and must
  // never be left pointing at the offscreen render.
  function bmRenderMatkeyToCanvas(variant, cssWidth, cssHeight, pixelScale) {
    const saved = {
      variant: bmVariant, callout: bmSelectedCalloutId,
      image: bmSelectedImageId, view: bmCanvasView,
    };
    const canvas = document.createElement('canvas');
    try {
      bmVariant = bmVariantKey(variant);
      bmSelectedCalloutId = null;
      bmSelectedImageId = null;
      bmDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale || 1);
    } finally {
      bmVariant = saved.variant;
      bmSelectedCalloutId = saved.callout;
      bmSelectedImageId = saved.image;
      bmCanvasView = saved.view;
    }
    return canvas;
  }

  function bmLabelBox(ctx, label, text, isSelected) {
    ctx.font = (isSelected ? 'bold ' : '') + '12px sans-serif';
    const w = ctx.measureText(text).width;
    return { x: label.x - 4, y: label.y - 9, width: w + 8, height: 18 };
  }

  function bmEdgeToward(box, ax, ay) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = ax - cx, dy = ay - cy;
    if (Math.abs(dx) < box.width / 2 && Math.abs(dy) < box.height / 2) return null;
    const tx = dx !== 0 ? (box.width / 2) / Math.abs(dx) : 1e9;
    const ty = dy !== 0 ? (box.height / 2) / Math.abs(dy) : 1e9;
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function bmDrawArrowHead(ctx, from, to, color) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - BM_ARROW_SIZE * Math.cos(angle - Math.PI / 6), to.y - BM_ARROW_SIZE * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - BM_ARROW_SIZE * Math.cos(angle + Math.PI / 6), to.y - BM_ARROW_SIZE * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function bmDrawCallout(ctx, c, isSelected) {
    const im = bmImageById(c.imageId);
    if (!im) return;
    const label = bmWorldToCanvas(bmWorldOf(im, c.textPos));
    const orphan = !bmRowById(c.rowId);
    const color = orphan ? BM_ORPHAN_COLOR : BM_CALLOUT_COLOR;
    const text = bmCalloutLabelText(c);
    const box = bmLabelBox(ctx, label, text, isSelected);
    const targets = c.targets || [];
    const seq = bmRowBase(c.rowId, bmVariant);

    ctx.save();
    targets.forEach((t, i) => {
      const pin = bmWorldToCanvas(bmWorldOf(im, t));
      const edge = bmEdgeToward(box, pin.x, pin.y);
      const from = edge || { x: label.x, y: label.y };
      ctx.strokeStyle = color;
      ctx.lineWidth = isSelected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      bmDrawArrowHead(ctx, from, pin, color);
      if (i === 0) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, BM_PIN_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(seq || '?'), pin.x, pin.y + 0.5);
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(pin.x, pin.y, BM_ANCHOR_RADIUS, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    ctx.font = (isSelected ? 'bold ' : '') + '12px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    if (isSelected) {
      ctx.strokeStyle = color;
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(box.x, box.y, box.width, box.height);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = orphan ? BM_ORPHAN_COLOR : '#111';
    ctx.fillText(text, label.x, label.y);
    ctx.restore();
  }

  function bmRenderCalloutSidePanel() {
    const empty = document.getElementById('bomMkSideEmpty');
    const panel = document.getElementById('bomMkSideCallout');
    if (!empty || !panel) return;
    const c = bmSelectedCallout();
    if (!c) {
      empty.hidden = false;
      panel.hidden = true;
      return;
    }
    empty.hidden = true;
    panel.hidden = false;
    const seqEl = document.getElementById('bomMkSideSeq');
    if (seqEl) seqEl.textContent = String(bmRowSeq(c.rowId, bmVariant) || '?');
    const rowSelect = document.getElementById('bomMkRowSelect');
    if (rowSelect && rowSelect !== document.activeElement) {
      const rows = bmVisibleRows(bmVariant);
      const orphan = !rows.some(r => r.id === c.rowId);
      rowSelect.innerHTML = (orphan
        ? '<option value="" selected disabled>? deleted BOM row — pick a row to relink</option>'
        : '')
        + rows.map(r => {
          const seq = bmRowSeq(r.id, bmVariant);
          const occupied = bmCalloutForRow(r.id, bmVariant);
          const disabled = occupied && occupied.id !== c.id;
          return '<option value="' + r.id + '"' + (!orphan && r.id === c.rowId ? ' selected' : '')
            + (disabled ? ' disabled' : '') + '>'
            + seq + '. ' + escapeHtml(r.cells.description || '(empty)') + '</option>';
        }).join('');
    }
  }

  /* ---- Wiring --------------------------------------------------------------- */
  // Page open/close belongs to page-nav.js's setActivePage('bom' | 'board' |
  // 'mainpage' | 'construction') — the BOM page is a peer page, not a modal
  // this file owns the visibility of.

  function bmOnPointerDown(e) {
    if (!state.bom) return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const pt = bmCanvasPointFromEvent(e, canvas);
    if (bmTool === 'callout') { bmCreateCalloutAt(pt); return; }
    if (bmTool === 'leader') { bmAddArrowAt(pt); return; }
    const hit = bmHitTest(pt);
    if (hit) {
      bmSelectedCalloutId = hit.callout.id;
      bmSelectedRowId = hit.callout.rowId;
      bmSelectedImageId = null;
      bmDrag = hit.part === 'line' ? null
        : { callout: hit.callout, part: hit.part, anchorIndex: hit.anchorIndex, imageRec: hit.imageRec };
      renderBom();
      e.preventDefault();
      return;
    }
    const image = bmImageAt(pt);
    if (image) {
      bmSelectedCalloutId = null;
      bmSelectedImageId = image.id;
      bmDrag = {
        part: 'image', imageRec: image,
        startX: pt.x, startY: pt.y, originX: image.x, originY: image.y,
      };
      renderBom();
      e.preventDefault();
      return;
    }
    bmSelectedCalloutId = null;
    bmSelectedImageId = null;
    renderBom();
  }

  function bmOnPointerMove(e) {
    if (!bmDrag) return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    const pt = bmCanvasPointFromEvent(e, canvas);
    if (bmDrag.part === 'image') {
      if (!bmDrag.imageRec.locked) {
        bmDrag.imageRec.x = bmDrag.originX + pt.x - bmDrag.startX;
        bmDrag.imageRec.y = bmDrag.originY + pt.y - bmDrag.startY;
      }
    } else {
      const norm = bmNormalize(bmDrag.imageRec, pt);
      if (bmDrag.part === 'anchor') bmDrag.callout.targets[bmDrag.anchorIndex] = norm;
      else bmDrag.callout.textPos = norm;
    }
    bmDrawCanvas();
  }

  function bmOnPointerUp() {
    if (!bmDrag) return;
    bmDrag = null;
    pushHistoryIfChanged();
  }

  function bmOnDoubleClick(e) {
    if (bmTool !== 'select') return;
    const canvas = document.getElementById('bomMatkeyCanvas');
    if (!canvas) return;
    bmDeleteAnchorAt(bmCanvasPointFromEvent(e, canvas));
  }

  function initBom() {
    ensureBom();
    const page = document.getElementById('bomPage');
    if (!page) return;

    document.querySelectorAll('[data-bom-variant]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = btn.dataset.bomVariant;
        if (v !== 'solid' && v !== 'lace') return;
        bmVariant = v;
        bmCloseDd();
        bmSelectedRowId = null;
        bmSelectedCalloutId = null;
        bmSelectedImageId = null;
        bmSetTool('select');
        bmSyncVariantTabs();
        renderBom();
      });
    });

    const selectToolBtn = document.getElementById('bomSelectToolBtn');
    if (selectToolBtn) selectToolBtn.addEventListener('click', () => {
      bmSetTool('select');
      showToast('Select tool active');
    });

    const addCalloutBtn = document.getElementById('bomAddCalloutBtn');
    if (addCalloutBtn) {
      addCalloutBtn.addEventListener('click', () => {
        if (bmTool === 'callout') {
          bmSetTool('select');
          showToast('Select tool active');
          return;
        }
        bmStartCalloutTool();
      });
    }

    const addArrowBtn = document.getElementById('bomAddArrowBtn');
    if (addArrowBtn) {
      addArrowBtn.addEventListener('click', () => {
        if (!bmSelectedCallout()) { showToast('Select a callout first'); return; }
        if (bmTool === 'leader') {
          bmSetTool('select');
          showToast('Select tool active');
          return;
        }
        bmSetTool('leader');
        showToast('Add Leaders · click multiple targets; Select/Esc finishes');
      });
    }

    const deleteCalloutBtn = document.getElementById('bomDeleteCalloutBtn');
    if (deleteCalloutBtn) deleteCalloutBtn.addEventListener('click', bmDeleteSelectedCallout);

    const imageInput = document.getElementById('bomImageFileInput');
    const addImageBtn = document.getElementById('bomAddImageBtn');
    if (addImageBtn && imageInput) addImageBtn.addEventListener('click', () => imageInput.click());
    if (imageInput) imageInput.addEventListener('change', async () => {
      const files = Array.from(imageInput.files || []);
      imageInput.value = '';
      await bmAddImageFiles(files, bmVariant);
    });
    const pasteImageBtn = document.getElementById('bomPasteImageBtn');
    if (pasteImageBtn) pasteImageBtn.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('Use Cmd/Ctrl+V while Material Key is open.');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        const dataURLs = [];
        for (const item of items) {
          const type = item.types.find(t => /^image\//i.test(t));
          if (type) dataURLs.push(await blobToDataURL(await item.getType(type)));
        }
        if (dataURLs.length) await bmAddImagesFromDataURLs(dataURLs, bmVariant);
        else showToast('Clipboard has no image.');
      } catch (_) {
        showToast('Clipboard access was blocked. Use Cmd/Ctrl+V instead.');
      }
    });
    const deleteImageBtn = document.getElementById('bomDeleteImageBtn');
    if (deleteImageBtn) deleteImageBtn.addEventListener('click', bmDeleteSelectedImage);
    const zoomOutImageBtn = document.getElementById('bomImageZoomOutBtn');
    if (zoomOutImageBtn) zoomOutImageBtn.addEventListener('click', () => bmZoomSelectedImage(0.9));
    const zoomInImageBtn = document.getElementById('bomImageZoomInBtn');
    if (zoomInImageBtn) zoomInImageBtn.addEventListener('click', () => bmZoomSelectedImage(1.1));
    const fitImagesBtn = document.getElementById('bomFitImagesBtn');
    if (fitImagesBtn) fitImagesBtn.addEventListener('click', () => {
      if (!bmVariantImages().length) return;
      bmReflowImages();
      bmSelectedImageId = null;
      renderBom();
      pushHistoryIfChanged();
    });

    const rowSelect = document.getElementById('bomMkRowSelect');
    if (rowSelect) {
      rowSelect.addEventListener('change', () => {
        const c = bmSelectedCallout();
        if (!c) return;
        const rowId = +rowSelect.value;
        const occupied = bmCalloutForRow(rowId, bmVariant);
        if (occupied && occupied.id !== c.id) {
          showToast('That BOM row already owns a callout on this variant');
          renderBom();
          return;
        }
        c.rowId = rowId;
        bmSelectedRowId = rowId;
        renderBom();
        pushHistoryIfChanged();
      });
    }

    const canvas = document.getElementById('bomMatkeyCanvas');
    if (canvas) {
      canvas.addEventListener('mousedown', bmOnPointerDown);
      canvas.addEventListener('dblclick', bmOnDoubleClick);
      const filesDragging = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
      canvas.addEventListener('dragover', e => {
        if (!filesDragging(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        canvas.classList.add('bm-drag-over');
      });
      canvas.addEventListener('dragleave', () => canvas.classList.remove('bm-drag-over'));
      canvas.addEventListener('drop', async e => {
        if (!e.dataTransfer) return;
        e.preventDefault();
        canvas.classList.remove('bm-drag-over');
        await bmAddImageFiles(e.dataTransfer.files, bmVariant);
      });
    }
    window.addEventListener('mousemove', bmOnPointerMove);
    window.addEventListener('mouseup', bmOnPointerUp);
    window.addEventListener('resize', () => {
      if (state.activePage === 'bom') bmDrawCanvas();
    });

    const searchEl = document.getElementById('bomMatSearch');
    if (searchEl) {
      searchEl.addEventListener('input', () => {
        bmSearchText = searchEl.value;
        bmRenderMaterialList();
      });
      searchEl.addEventListener('keydown', e => {
        if (e.key !== 'Tab') e.stopPropagation();
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (bmMaterialHits[0]) bmApplyMaterialByIndex(0);
      });
    }

    const matList = document.getElementById('bomMatList');
    if (matList) {
      matList.addEventListener('click', e => {
        const btn = e.target.closest('[data-bom-mat]');
        if (btn) bmApplyMaterialByIndex(+btn.dataset.bomMat);
      });
    }

    // The floating ▾ menu is parked on <body>; anything that moves the cell
    // out from under it (outside click, scroll, tab/variant switches) closes
    // it rather than leaving it hovering over stale coordinates.
    document.addEventListener('click', e => {
      if (bmDdOpenFor && !e.target.closest('#bomDdMenu,[data-bom-dd]')) bmCloseDd();
      if (bmPhotoOpenRow != null && !e.target.closest('#bomPhotoMenu,[data-bom-photo]')) bmClosePhotoMenu();
    });
    window.addEventListener('scroll', () => {
      if (bmDdOpenFor) bmCloseDd();
      if (bmPhotoOpenRow != null) bmClosePhotoMenu();
    }, true);

    // Delegated on the page element, which survives every table re-render —
    // a listener on a cell/row/button would die on the next renderBom().
    page.addEventListener('input', e => {
      const cell = e.target.closest('[data-cell]');
      if (cell) {
        const row = bmRowById(+cell.dataset.row);
        if (row) {
          row.cells[cell.dataset.cell] = cell.textContent;
          if (cell.dataset.cell === 'description') {
            bmDrawCanvas();
            bmRenderPrintSheets();
          }
        }
        return;
      }
      const cw = e.target.closest('[data-cw]');
      if (cw) {
        const row = bmRowById(+cw.dataset.row);
        if (row) {
          if (!row.cwOverride || typeof row.cwOverride !== 'object') row.cwOverride = {};
          row.cwOverride[cw.dataset.cw] = cw.textContent;
        }
      }
    });

    // One history entry per cell, not per keystroke: mutate on input, push
    // on blur, same pattern as main-page.js's contenteditable fields.
    page.addEventListener('focusout', e => {
      if (e.target.closest('[contenteditable]')) pushHistoryIfChanged();
    });

    page.addEventListener('change', e => {
      const scopeSel = e.target.closest('[data-scope]');
      if (!scopeSel) return;
      const row = bmRowById(+scopeSel.dataset.row);
      if (!row) return;
      row.scope = scopeSel.value;
      const allowed = row.scope === 'BOTH'
        ? new Set(['solid', 'lace'])
        : new Set([row.scope.toLowerCase()]);
      const removed = state.bom.callouts.filter(c => c.rowId === row.id && !allowed.has(bmVariantKey(c.variant)));
      if (removed.length) {
        const removedIds = new Set(removed.map(c => c.id));
        state.bom.callouts = state.bom.callouts.filter(c => !removedIds.has(c.id));
        if (removedIds.has(bmSelectedCalloutId)) bmSelectedCalloutId = null;
        if (bmTool === 'leader' && !bmSelectedCallout()) bmTool = 'select';
      }
      renderBom();
      pushHistoryIfChanged();
      if (removed.length) showToast('Scope updated · removed ' + removed.length + ' callout(s) from excluded variant(s) · Ctrl/Cmd+Z to undo');
    });

    page.addEventListener('click', e => {
      const dd = e.target.closest('[data-bom-dd]');
      if (dd) {
        if (bmDdOpenFor === dd.dataset.bomDd) bmCloseDd();
        else bmOpenDd(dd);
        return;
      }
      const photoBtn = e.target.closest('[data-bom-photo]');
      if (photoBtn) {
        if (bmPhotoOpenRow === +photoBtn.dataset.bomPhoto) bmClosePhotoMenu();
        else bmOpenPhotoMenu(photoBtn);
        return;
      }
      const addRow = e.target.closest('[data-bom-add]');
      if (addRow) { bmAddRow(addRow.dataset.bomAdd); return; }
      const mk = e.target.closest('[data-bom-mk]');
      if (mk) { bmArmRowCallout(+mk.dataset.row); return; }
      const split = e.target.closest('[data-bom-split]');
      if (split) { bmSplitRow(+split.dataset.row); return; }
      const rm = e.target.closest('[data-bom-rm]');
      if (rm) { bmRemoveRow(+rm.dataset.row); return; }
      const rowEl = e.target.closest('[data-bom-row]');
      if (rowEl) {
        const id = +rowEl.dataset.bomRow;
        if (bmSelectedRowId !== id) {
          bmSelectedRowId = id;
          bmSyncSelectedRowClass();
          bmRenderMaterialPanel();
        }
      }
    });

    document.addEventListener('keydown', e => {
      if (state.activePage !== 'bom') return;
      if (e.key === 'Escape') {
        if (bmDdOpenFor) { bmCloseDd(); return; }
        if (bmPhotoOpenRow != null) { bmClosePhotoMenu(); return; }
        if (bmTool !== 'select') { bmSetTool('select'); showToast('Select tool active'); return; }
        if (bmSelectedCalloutId !== null) { bmSelectedCalloutId = null; renderBom(); return; }
        if (bmSelectedImageId !== null) { bmSelectedImageId = null; renderBom(); return; }
        setActivePage('board');
        return;
      }
      if (e.key === 'Backspace' && bmSelectedCalloutId !== null) {
        const active = document.activeElement;
        const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
        if (inField) return;
        e.preventDefault();
        bmDeleteSelectedCallout();
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && bmSelectedImageId !== null) {
        const active = document.activeElement;
        const inField = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
        if (inField) return;
        e.preventDefault();
        bmDeleteSelectedImage();
      }
    }, true);

    bmSyncVariantTabs();
    renderBom();
  }
