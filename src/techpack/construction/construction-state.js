// Construction working sheets (US-078, ADR 0045) — schema constants, module
// view/selection state, state.construction seeding/normalization, the legacy
// notes[] -> rows/callouts[] migration, and project serialize/load.
// Source part for app.js. Run `npm run build` after editing.
//
// Sibling parts: construction-images.js (working-board image management),
// construction-canvas.js (leader-line geometry/hit-testing/drawing),
// construction-rows.js (editable row table + phrase picker),
// construction.js (top-level orchestration and DOM wiring).
//
// state.construction is:
// {
//   schemaVersion:2, seedId,
//   rows:[{id,sheet:'solid'|'lace',view:'outer'|'inner',area,detail}],
//   images:{solid:{outer:[],inner:[]},lace:{outer:[],inner:[]}},
//   callouts:[{id,rowId,sheet,view,imageId,targets:[{nx,ny}],textPos:{nx,ny}}]
// }
//
// One row owns at most one callout. Callout number/area/detail are derived
// live from the row; only label and target geometry is independently edited.
// Image bytes live outside history state and are injected only for save/
// autosave, matching BOM's image ownership model.

  const CC_SCHEMA_VERSION = 2;
  const CC_SEED_ID = 'construction-working-sheets-v1';
  const CC_SHEETS = ['solid', 'lace'];
  const CC_VIEWS = ['outer', 'inner'];
  const CC_SEED_AREAS = ['CUP', 'SLING', 'CRADLE', 'SIDE_SEAM', 'BACK_CLOSURE', 'FRONT_CLOSURE'];
  const CC_AREAS = [
    'CUP', 'SLING', 'CRADLE', 'SIDE_SEAM', 'BACK_CLOSURE', 'FRONT_CLOSURE',
    'NECKLINE', 'ARMHOLE', 'UNDERBAND', 'STRAP', 'BACK',
  ];
  const CC_AREA_LABELS = {
    CUP: 'Cup', SLING: 'Sling', CRADLE: 'Cradle', SIDE_SEAM: 'Side seam',
    BACK_CLOSURE: 'Back closure', FRONT_CLOSURE: 'Front closure',
    NECKLINE: 'Neckline', ARMHOLE: 'Armhole', UNDERBAND: 'Underband',
    STRAP: 'Strap', BACK: 'Back',
  };
  const CC_PIN_RADIUS = 9;
  const CC_ANCHOR_RADIUS = 4;
  const CC_HIT_RADIUS = 11;
  const CC_ARROW_SIZE = 7;
  const CC_TEXT_WIDTH = 175;
  const CC_LINE_HEIGHT = 16;
  const CC_CALLOUT_COLOR = '#1c6dd0';

  let ccSheet = 'solid';
  let ccActiveView = 'outer';
  let ccSelectedRowId = null;
  let ccSelectedCalloutId = null;
  let ccSelectedImageId = null;
  let ccTool = 'select';

  function ccSheetKey(value) {
    return String(value || ccSheet).toLowerCase() === 'lace' ? 'lace' : 'solid';
  }

  function ccViewKey(value) {
    return String(value || ccActiveView).toLowerCase() === 'inner' ? 'inner' : 'outer';
  }

  function ccEmptyImages() {
    return { solid: { outer: [], inner: [] }, lace: { outer: [], inner: [] } };
  }

  function ccStripImageForState(image) {
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

  function ccNormalizeArea(value) {
    const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (CC_AREAS.includes(raw)) return raw;
    if (raw === 'SIDE' || raw === 'SIDE_WING') return 'SIDE_SEAM';
    if (raw === 'CLOSURE' || raw === 'HOOK_EYE') return 'BACK_CLOSURE';
    return 'CUP';
  }

  function ccInferLegacyArea(note) {
    const explicit = ccNormalizeArea(note && note.zone);
    if (note && CC_AREAS.includes(String(note.zone || '').toUpperCase())) return explicit;
    const text = String((note && note.note) || '').toLowerCase();
    if (/front closure/.test(text)) return 'FRONT_CLOSURE';
    if (/back closure|hook|eye/.test(text)) return 'BACK_CLOSURE';
    if (/side seam/.test(text)) return 'SIDE_SEAM';
    if (/sling/.test(text)) return 'SLING';
    if (/underband|bottom band|\bub\b/.test(text)) return 'UNDERBAND';
    if (/cradle|gore/.test(text)) return 'CRADLE';
    if (/armhole|underarm|a\/h|wing/.test(text)) return 'ARMHOLE';
    if (/neckline|yoke/.test(text)) return 'NECKLINE';
    if (/strap|ring|slider/.test(text)) return 'STRAP';
    if (/back/.test(text)) return 'BACK';
    return 'CUP';
  }

  function ccHasModelContent(cc) {
    if (!cc || typeof cc !== 'object') return false;
    if (Array.isArray(cc.notes) && cc.notes.length) return true;
    if (Array.isArray(cc.rows) && cc.rows.length) return true;
    if (Array.isArray(cc.callouts) && cc.callouts.length) return true;
    const images = cc.images || {};
    return CC_SHEETS.some(sheet => CC_VIEWS.some(view =>
      images[sheet] && Array.isArray(images[sheet][view]) && images[sheet][view].length));
  }

  function ccLegacyView(note, boardMeta) {
    const role = String((boardMeta && (boardMeta.viewRole || boardMeta.role)) || note.viewRole || '').toLowerCase();
    return role.includes('inner') ? 'inner' : 'outer';
  }

  function ccMigrateLegacyModel(legacy, rawBoardImages) {
    const model = {
      schemaVersion: CC_SCHEMA_VERSION,
      seedId: 'legacy-migrated',
      rows: [],
      images: ccEmptyImages(),
      callouts: [],
    };
    const boardMetas = Array.isArray(rawBoardImages) ? rawBoardImages : [];
    const copied = new Map();
    (legacy.notes || []).forEach(note => {
      const sheet = ccSheetKey(note.variant);
      const boardMeta = boardMetas.find(image => image && image.id === note.imageId)
        || (state.images || []).find(image => image && image.id === note.imageId)
        || null;
      const view = ccLegacyView(note, boardMeta || {});
      const copyKey = sheet + ':' + view + ':' + note.imageId;
      let imageId = copied.get(copyKey);
      if (imageId == null) {
        imageId = state.idCounter++;
        copied.set(copyKey, imageId);
        const width = Math.max(1, Number(boardMeta && boardMeta.width) || 400);
        const height = Math.max(1, Number(boardMeta && boardMeta.height) || 300);
        model.images[sheet][view].push({
          id: imageId, x: 0, y: 0, width, height,
          aspect: width / height, locked: false,
        });
        const dataURL = (boardMeta && boardMeta.dataURL) || null;
        const runtime = (state.images || []).find(image => image && image.id === note.imageId);
        if (dataURL) ccImageDataById.set(imageId, dataURL);
        if (runtime && runtime.img) ccImageElementById.set(imageId, runtime.img);
      }
      const rowId = state.idCounter++;
      const calloutId = state.idCounter++;
      model.rows.push({
        id: rowId,
        sheet,
        view,
        area: ccInferLegacyArea(note),
        detail: String(note.note || ''),
      });
      model.callouts.push({
        id: calloutId,
        rowId,
        sheet,
        view,
        imageId,
        targets: Array.isArray(note.targets) && note.targets.length
          ? clone(note.targets)
          : [clone(note.target || { nx: 0.5, ny: 0.5 })],
        textPos: clone(note.textPos || { nx: 0.58, ny: 0.45 }),
        color: note.color || CC_CALLOUT_COLOR,
        textRed: !!note.textRed,
      });
    });
    CC_SHEETS.forEach(sheet => CC_VIEWS.forEach(view => ccReflowImagesIn(model, sheet, view)));
    state.construction = model;
    return model;
  }

  function ccSeedRows(cc) {
    CC_SHEETS.forEach(sheet => {
      CC_VIEWS.forEach(view => {
        CC_SEED_AREAS.forEach(area => {
          cc.rows.push({ id: state.idCounter++, sheet, view, area, detail: '' });
        });
      });
    });
    cc.seedId = CC_SEED_ID;
  }

  function ensureConstruction(rawBoardImages) {
    let cc = state.construction && typeof state.construction === 'object'
      ? state.construction
      : (state.construction = {});
    if (Array.isArray(cc.notes) && !Array.isArray(cc.rows)) {
      cc = ccMigrateLegacyModel(cc, rawBoardImages);
    }
    if (!Array.isArray(cc.rows)) cc.rows = [];
    if (!Array.isArray(cc.callouts)) cc.callouts = [];
    if (!cc.images || typeof cc.images !== 'object') cc.images = ccEmptyImages();
    CC_SHEETS.forEach(sheet => {
      if (!cc.images[sheet] || typeof cc.images[sheet] !== 'object') cc.images[sheet] = { outer: [], inner: [] };
      CC_VIEWS.forEach(view => {
        if (!Array.isArray(cc.images[sheet][view])) cc.images[sheet][view] = [];
        // Normalize in place. Runtime interactions keep direct references to
        // image/row objects while dragging or changing a select; replacing
        // those objects on every ensureConstruction() call would stale the
        // reference between hit-test and mutation.
        cc.images[sheet][view].forEach(image => {
          Object.assign(image, ccStripImageForState(image));
          // Bitmap bytes are held in ccImageDataById, never in history state.
          // ccLoadProjectState extracts dataURL before this normalization.
          delete image.dataURL;
          delete image.img;
        });
      });
    });
    cc.rows.forEach(row => {
      row.sheet = ccSheetKey(row.sheet || row.variant);
      row.view = ccViewKey(row.view);
      row.area = ccNormalizeArea(row.area || row.zone);
      row.detail = String(row.detail != null ? row.detail : (row.note || ''));
      delete row.variant;
      delete row.zone;
      delete row.note;
    });
    const rowIds = new Set(cc.rows.map(row => row.id));
    const owned = new Set();
    cc.callouts = cc.callouts.filter(callout => {
      if (!rowIds.has(callout.rowId) || owned.has(callout.rowId)) return false;
      owned.add(callout.rowId);
      const row = cc.rows.find(item => item.id === callout.rowId);
      callout.sheet = row.sheet;
      callout.view = row.view;
      if (!Array.isArray(callout.targets) || !callout.targets.length) callout.targets = [{ nx: 0.5, ny: 0.5 }];
      if (!callout.textPos) callout.textPos = { nx: 0.58, ny: 0.45 };
      return true;
    });
    if (!cc.seedId && !ccHasModelContent(cc)) ccSeedRows(cc);
    cc.schemaVersion = CC_SCHEMA_VERSION;
    delete cc.notes;
    return cc;
  }

  function ccSerializeForProject() {
    const out = state.construction ? clone(state.construction) : null;
    if (!out || !out.images) return out;
    CC_SHEETS.forEach(sheet => CC_VIEWS.forEach(view => {
      out.images[sheet][view] = (out.images[sheet][view] || []).map(image => ({
        ...ccStripImageForState(image),
        dataURL: ccImageDataById.get(image.id) || null,
      }));
    }));
    return out;
  }

  async function ccLoadProjectState(rawConstruction, rawBoardImages) {
    ccImageDataById.clear();
    ccImageElementById.clear();
    const embedded = new Map();
    const rawImages = rawConstruction && rawConstruction.images;
    if (rawImages) {
      CC_SHEETS.forEach(sheet => CC_VIEWS.forEach(view => {
        const list = rawImages[sheet] && rawImages[sheet][view];
        (list || []).forEach(image => { if (image && image.dataURL) embedded.set(image.id, image.dataURL); });
      }));
    }
    state.construction = rawConstruction && typeof rawConstruction === 'object' ? clone(rawConstruction) : null;
    const cc = ensureConstruction(rawBoardImages);
    const loads = [];
    CC_SHEETS.forEach(sheet => CC_VIEWS.forEach(view => {
      cc.images[sheet][view].forEach(image => {
        const dataURL = embedded.get(image.id) || ccImageDataById.get(image.id);
        if (!dataURL) return;
        ccImageDataById.set(image.id, dataURL);
        loads.push(loadImageFromDataURL(dataURL)
          .then(img => ccImageElementById.set(image.id, img))
          .catch(() => {}));
      });
    }));
    await Promise.all(loads);
    return cc;
  }

  function ccExpectedSeedRows() {
    const out = [];
    CC_SHEETS.forEach(sheet => CC_VIEWS.forEach(view => CC_SEED_AREAS.forEach(area => {
      out.push({ sheet, view, area, detail: '' });
    })));
    return out;
  }

  function hasMeaningfulConstructionWork() {
    const cc = ensureConstruction();
    if (cc.callouts.length) return true;
    if (CC_SHEETS.some(sheet => CC_VIEWS.some(view => cc.images[sheet][view].length))) return true;
    const comparable = cc.rows.map(row => ({ sheet: row.sheet, view: row.view, area: row.area, detail: row.detail }));
    return JSON.stringify(comparable) !== JSON.stringify(ccExpectedSeedRows());
  }
