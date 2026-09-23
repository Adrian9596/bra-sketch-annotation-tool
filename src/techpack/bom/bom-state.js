// BOM page — schema constants, seeding, project persistence, session UI
// state, and row CRUD/numbering for state.bom (US-072, ADR 0041). Source
// part for app.js. Run `npm run build` after editing. Loads first of the
// bom-* parts; siblings are bom-images.js (Material Key image board),
// bom-materials.js (material-suggestion engine + per-row photo popover),
// bom-canvas.js (Material Key leader-line engine), bom-table.js (factory
// table + print sheets) and bom.js (initBom DOM wiring).
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
  // US-090: the fit-to-bounds basis, frozen while an image drag is in flight so
  // the view cannot move under the drag's own reference. Null otherwise.
  let bmFrozenBounds = null;

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
