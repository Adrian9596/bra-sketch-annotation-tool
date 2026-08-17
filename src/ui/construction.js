// Construction working sheets (US-078, ADR 0045).
// Source part for app.js. Run `npm run build` after editing.
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
  let ccDrag = null;
  let ccPanelLayouts = {};
  let ccBoxCache = {};
  let ccPhraseRowId = null;
  let ccPhraseHits = [];
  const ccImageDataById = new Map();
  const ccImageElementById = new Map();

  const CONSTRUCTION_PHRASES = (function () {
    const seen = new Set();
    const out = [];
    function add(text, extra) {
      const clean = String(text || '').trim();
      const key = clean.toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(Object.assign({ text: clean }, extra || {}));
    }
    CONSTRUCTION_STARTER_PHRASES.forEach(p => add(p.text, { favorite: !!p.favorite }));
    CONSTRUCTION_TERM_LIBRARY.forEach(t => add(t.en));
    CONSTRUCTION_GENERATED_PHRASES.forEach(p => add(p.text));
    return out;
  })();

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

  function ccRows(sheet) {
    const key = ccSheetKey(sheet);
    const rows = ensureConstruction().rows.filter(row => row.sheet === key);
    return rows.slice().sort((a, b) => {
      const va = CC_VIEWS.indexOf(a.view), vb = CC_VIEWS.indexOf(b.view);
      if (va !== vb) return va - vb;
      return ensureConstruction().rows.indexOf(a) - ensureConstruction().rows.indexOf(b);
    });
  }

  function ccRowsForView(view, sheet) {
    const key = ccViewKey(view);
    return ccRows(sheet).filter(row => row.view === key);
  }

  function ccRowById(id) {
    return ensureConstruction().rows.find(row => row.id === id) || null;
  }

  function ccRowSeq(id, sheet) {
    const index = ccRows(sheet).findIndex(row => row.id === id);
    return index === -1 ? '' : String(index + 1);
  }

  function ccCalloutForRow(rowId) {
    return ensureConstruction().callouts.find(callout => callout.rowId === rowId) || null;
  }

  function ccVisibleCallouts() {
    return ensureConstruction().callouts.filter(callout => callout.sheet === ccSheet);
  }

  function ccSelectedCallout() {
    return ccVisibleCallouts().find(callout => callout.id === ccSelectedCalloutId) || null;
  }

  function ccImages(sheet, view) {
    return ensureConstruction().images[ccSheetKey(sheet)][ccViewKey(view)];
  }

  function ccImageById(id, sheet, view) {
    const views = view ? [ccViewKey(view)] : CC_VIEWS;
    for (const candidate of views) {
      const found = ccImages(sheet, candidate).find(image => image.id === id);
      if (found) return found;
    }
    return null;
  }

  function ccImageRuntime(id) {
    return ccImageElementById.get(id) || null;
  }

  function ccReflowImagesIn(model, sheet, view) {
    const images = model.images[sheet][view];
    const commonHeight = 300;
    const gap = 28;
    let x = 0;
    images.forEach(image => {
      image.height = commonHeight;
      image.width = commonHeight * (image.aspect || 1);
      image.x = x;
      image.y = 0;
      x += image.width + gap;
    });
  }

  function ccReflowImages(sheet, view) {
    ccReflowImagesIn(ensureConstruction(), ccSheetKey(sheet), ccViewKey(view));
  }

  async function ccAddImagesFromDataURLs(dataURLs, sheet, view) {
    const sheetKey = ccSheetKey(sheet);
    const viewKey = ccViewKey(view);
    const images = ccImages(sheetKey, viewKey);
    let added = 0;
    for (const dataURL of dataURLs || []) {
      if (!dataURL) continue;
      const img = await loadImageFromDataURL(dataURL);
      const id = state.idCounter++;
      const aspect = img.height > 0 ? img.width / img.height : 1;
      images.push({ id, x: 0, y: 0, width: 300 * aspect, height: 300, aspect, locked: false });
      ccImageDataById.set(id, dataURL);
      ccImageElementById.set(id, img);
      added += 1;
    }
    if (!added) return 0;
    ccReflowImages(sheetKey, viewKey);
    ccActiveView = viewKey;
    ccSelectedImageId = null;
    ccSelectedCalloutId = null;
    ccSetTool('select');
    renderConstruction();
    pushHistoryIfChanged();
    showToast(added + ' image' + (added === 1 ? '' : 's') + ' added to ' + sheetKey.toUpperCase() + ' · ' + viewKey.toUpperCase());
    return added;
  }

  async function ccAddImageFiles(files, sheet, view) {
    const imageFiles = Array.from(files || []).filter(file => file && /^image\//i.test(file.type || ''));
    if (!imageFiles.length) {
      showToast('Add PNG, JPEG, or WebP images to the Construction working board.');
      return 0;
    }
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    return ccAddImagesFromDataURLs(dataURLs, sheet, view);
  }

  function ccDeleteSelectedImage() {
    const image = ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    if (!image) { showToast('Select an image in the active Construction panel first.'); return; }
    const linked = ccVisibleCallouts().filter(callout => callout.imageId === image.id);
    if (linked.length && !window.confirm('Delete this image and its ' + linked.length + ' linked callout(s)?\n\nUndo restores both.')) return;
    const images = ccImages(ccSheet, ccActiveView);
    images.splice(images.indexOf(image), 1);
    if (linked.length) {
      const ids = new Set(linked.map(callout => callout.id));
      state.construction.callouts = state.construction.callouts.filter(callout => !ids.has(callout.id));
    }
    ccSelectedImageId = null;
    ccSelectedCalloutId = null;
    ccReflowImages(ccSheet, ccActiveView);
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccZoomSelectedImage(factor) {
    const image = ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    if (!image) { showToast('Select an image in the active Construction panel first.'); return; }
    const nextWidth = clamp(image.width * factor, 60, 1800);
    const nextHeight = nextWidth / (image.aspect || 1);
    const cx = image.x + image.width / 2, cy = image.y + image.height / 2;
    image.width = nextWidth;
    image.height = nextHeight;
    image.x = cx - nextWidth / 2;
    image.y = cy - nextHeight / 2;
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccAddRow(view) {
    const row = {
      id: state.idCounter++, sheet: ccSheet, view: ccViewKey(view), area: 'CUP', detail: '',
    };
    ensureConstruction().rows.push(row);
    ccSelectedRowId = row.id;
    ccActiveView = row.view;
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccDeleteRow(rowId) {
    const cc = ensureConstruction();
    const index = cc.rows.findIndex(row => row.id === rowId);
    if (index === -1) return;
    const callout = ccCalloutForRow(rowId);
    cc.rows.splice(index, 1);
    if (callout) cc.callouts = cc.callouts.filter(item => item.id !== callout.id);
    if (ccSelectedRowId === rowId) ccSelectedRowId = null;
    if (callout && ccSelectedCalloutId === callout.id) ccSelectedCalloutId = null;
    if (ccTool === 'leader' && !ccSelectedCallout()) ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
    showToast('Construction row deleted · Ctrl/Cmd+Z to undo');
  }

  function ccMoveRowView(row, nextView) {
    const view = ccViewKey(nextView);
    if (!row || row.view === view) return;
    const callout = ccCalloutForRow(row.id);
    if (callout) {
      state.construction.callouts = state.construction.callouts.filter(item => item.id !== callout.id);
      if (ccSelectedCalloutId === callout.id) ccSelectedCalloutId = null;
    }
    row.view = view;
    ccActiveView = view;
    if (ccTool === 'leader') ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
    showToast(callout ? 'Row moved to ' + view.toUpperCase() + '; old-view callout removed · Undo restores both' : 'Row moved to ' + view.toUpperCase());
  }

  function ccMissingRows() {
    return ccRows(ccSheet).filter(row => !ccCalloutForRow(row.id));
  }

  function ccNextMissingRow(afterId) {
    const rows = ccRows(ccSheet);
    const start = Math.max(-1, rows.findIndex(row => row.id === afterId));
    for (let step = 1; step <= rows.length; step += 1) {
      const row = rows[(start + step) % rows.length];
      if (!ccCalloutForRow(row.id)) return row;
    }
    return null;
  }

  function ccArmRowCallout(rowId) {
    const row = ccRowById(rowId);
    if (!row || row.sheet !== ccSheet) return;
    ccSelectedRowId = row.id;
    ccActiveView = row.view;
    const callout = ccCalloutForRow(row.id);
    if (callout) {
      ccSelectedCalloutId = callout.id;
      ccSelectedImageId = null;
      ccSetTool('select');
      showToast('Selected the existing callout for Construction row ' + ccRowSeq(row.id));
    } else {
      ccSelectedCalloutId = null;
      ccSelectedImageId = null;
      ccSetTool('callout');
      showToast('Click an image in ' + row.view.toUpperCase() + ' to place row ' + ccRowSeq(row.id));
    }
    renderConstruction();
  }

  function ccStartCalloutTool(preferredRowId) {
    const missing = ccMissingRows();
    if (!missing.length) {
      ccSetTool('select');
      showToast('Every Construction row on this sheet already has a callout');
      return;
    }
    const row = missing.find(item => item.id === preferredRowId)
      || missing.find(item => item.id === ccSelectedRowId)
      || missing[0];
    ccSelectedRowId = row.id;
    ccSelectedCalloutId = null;
    ccSelectedImageId = null;
    ccActiveView = row.view;
    ccSetTool('callout');
    renderConstruction();
  }

  function ccSetTool(tool) {
    if (!['select', 'callout', 'leader'].includes(tool)) tool = 'select';
    if (tool === 'leader' && !ccSelectedCallout()) {
      showToast('Select a Construction callout before adding leaders');
      tool = 'select';
    }
    ccTool = tool;
    ccSyncUi();
  }

  function ccDeleteSelectedCallout() {
    const callout = ccSelectedCallout();
    if (!callout) return;
    state.construction.callouts = state.construction.callouts.filter(item => item.id !== callout.id);
    ccSelectedCalloutId = null;
    if (ccTool === 'leader') ccTool = 'select';
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccImageBounds(sheet, view) {
    const images = ccImages(sheet, view);
    if (!images.length) return { x: 0, y: 0, width: 1, height: 1 };
    const minX = Math.min(...images.map(image => image.x));
    const minY = Math.min(...images.map(image => image.y));
    const maxX = Math.max(...images.map(image => image.x + image.width));
    const maxY = Math.max(...images.map(image => image.y + image.height));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  function ccBuildPanelLayout(view, x, y, width, height) {
    const content = { x: x + 12, y: y + 36, width: width - 24, height: height - 48 };
    const bounds = ccImageBounds(ccSheet, view);
    const hasImages = ccImages(ccSheet, view).length > 0;
    const scale = hasImages ? Math.min(content.width / bounds.width, content.height / bounds.height, 2) : 1;
    return {
      view, x, y, width, height, content,
      offX: content.x + (content.width - bounds.width * scale) / 2 - bounds.x * scale,
      offY: content.y + (content.height - bounds.height * scale) / 2 - bounds.y * scale,
      scale,
    };
  }

  function ccWorldToCanvas(layout, point) {
    return { x: point.x * layout.scale + layout.offX, y: point.y * layout.scale + layout.offY };
  }

  function ccCanvasToWorld(layout, point) {
    return { x: (point.x - layout.offX) / layout.scale, y: (point.y - layout.offY) / layout.scale };
  }

  function ccWorldOf(image, norm) {
    return { x: image.x + norm.nx * image.width, y: image.y + norm.ny * image.height };
  }

  function ccNormalize(image, point) {
    return {
      nx: clamp((point.x - image.x) / image.width, 0, 1),
      ny: clamp((point.y - image.y) / image.height, 0, 1),
    };
  }

  function ccPanelAt(point) {
    return CC_VIEWS.map(view => ccPanelLayouts[view]).find(layout => layout
      && point.x >= layout.x && point.x <= layout.x + layout.width
      && point.y >= layout.y && point.y <= layout.y + layout.height) || null;
  }

  function ccImageAt(view, worldPoint) {
    const images = ccImages(ccSheet, view);
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const image = images[i];
      if (worldPoint.x >= image.x && worldPoint.x <= image.x + image.width
        && worldPoint.y >= image.y && worldPoint.y <= image.y + image.height) return image;
    }
    return null;
  }

  function ccDistanceToSegment(point, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
  }

  function ccHitTest(point) {
    const callouts = ccVisibleCallouts();
    for (let i = callouts.length - 1; i >= 0; i -= 1) {
      const callout = callouts[i];
      const layout = ccPanelLayouts[callout.view];
      const image = ccImageById(callout.imageId, ccSheet, callout.view);
      if (!layout || !image) continue;
      for (let ti = callout.targets.length - 1; ti >= 0; ti -= 1) {
        const pin = ccWorldToCanvas(layout, ccWorldOf(image, callout.targets[ti]));
        if (Math.hypot(point.x - pin.x, point.y - pin.y) <= CC_HIT_RADIUS) {
          return { callout, image, layout, part: 'anchor', anchorIndex: ti };
        }
      }
      const box = ccBoxCache[callout.id];
      if (box && point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height) {
        return { callout, image, layout, part: 'label', anchorIndex: -1 };
      }
      const label = ccWorldToCanvas(layout, ccWorldOf(image, callout.textPos));
      for (let ti = callout.targets.length - 1; ti >= 0; ti -= 1) {
        const pin = ccWorldToCanvas(layout, ccWorldOf(image, callout.targets[ti]));
        if (ccDistanceToSegment(point, label, pin) <= 6) {
          return { callout, image, layout, part: 'line', anchorIndex: ti };
        }
      }
    }
    return null;
  }

  function ccCreateCalloutAt(layout, worldPoint) {
    const row = ccRowById(ccSelectedRowId) || ccMissingRows()[0];
    if (!row || row.sheet !== ccSheet || ccCalloutForRow(row.id)) {
      ccStartCalloutTool();
      return;
    }
    if (layout.view !== row.view) {
      ccActiveView = row.view;
      ccSyncUi();
      showToast('Row ' + ccRowSeq(row.id) + ' belongs to ' + row.view.toUpperCase() + '; place it in that panel');
      return;
    }
    const image = ccImageAt(row.view, worldPoint);
    if (!image) { showToast('Click a sketch image in the ' + row.view.toUpperCase() + ' panel'); return; }
    const target = ccNormalize(image, worldPoint);
    const callout = {
      id: state.idCounter++, rowId: row.id, sheet: row.sheet, view: row.view, imageId: image.id,
      targets: [target],
      textPos: {
        nx: clamp(target.nx + (target.nx > 0.65 ? -0.30 : 0.08), 0.02, 0.88),
        ny: clamp(target.ny - 0.04, 0.04, 0.94),
      },
      color: CC_CALLOUT_COLOR,
    };
    ensureConstruction().callouts.push(callout);
    const next = ccNextMissingRow(row.id);
    if (next) {
      ccSelectedRowId = next.id;
      ccSelectedCalloutId = null;
      ccActiveView = next.view;
    } else {
      ccSelectedRowId = row.id;
      ccSelectedCalloutId = callout.id;
      ccTool = 'select';
    }
    renderConstruction();
    pushHistoryIfChanged();
    showToast(next ? 'Callout added · next row ' + ccRowSeq(next.id) + ' · ' + next.view.toUpperCase() : 'All Construction rows now have callouts · Select is active');
  }

  function ccAddLeaderAt(layout, worldPoint) {
    const callout = ccSelectedCallout();
    if (!callout) { ccSetTool('select'); return; }
    if (layout.view !== callout.view) { showToast('Add leaders inside the selected callout\'s ' + callout.view.toUpperCase() + ' panel'); return; }
    const image = ccImageById(callout.imageId, ccSheet, callout.view);
    if (!image || ccImageAt(callout.view, worldPoint) !== image) {
      showToast('Add the leader inside the selected callout\'s own image');
      return;
    }
    callout.targets.push(ccNormalize(image, worldPoint));
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccDeleteAnchorAt(point) {
    const hit = ccHitTest(point);
    if (!hit || hit.part !== 'anchor') return;
    if (hit.callout.targets.length <= 1) {
      showToast('A callout needs at least one leader; delete the callout to remove it');
      return;
    }
    hit.callout.targets.splice(hit.anchorIndex, 1);
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccWrapLines(ctx, text, maxWidth) {
    const paragraphs = String(text || '').split('\n');
    const lines = [];
    paragraphs.forEach(paragraph => {
      const words = paragraph.split(/\s+/).filter(Boolean);
      if (!words.length) { lines.push(''); return; }
      let line = '';
      words.forEach(word => {
        const next = line ? line + ' ' + word : word;
        if (line && ctx.measureText(next).width > maxWidth) { lines.push(line); line = word; }
        else line = next;
      });
      lines.push(line);
    });
    return lines.length ? lines : [''];
  }

  function ccEdgeToward(box, target) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const dx = target.x - cx, dy = target.y - cy;
    const tx = dx ? (box.width / 2) / Math.abs(dx) : 1e9;
    const ty = dy ? (box.height / 2) / Math.abs(dy) : 1e9;
    const t = Math.min(tx, ty);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  function ccDrawArrow(ctx, from, to, color) {
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - CC_ARROW_SIZE * Math.cos(angle - Math.PI / 6), to.y - CC_ARROW_SIZE * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(to.x - CC_ARROW_SIZE * Math.cos(angle + Math.PI / 6), to.y - CC_ARROW_SIZE * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  function ccCalloutText(callout) {
    const row = ccRowById(callout.rowId);
    if (!row) return '? deleted Construction row';
    const detail = String(row.detail || '').trim();
    return ccRowSeq(row.id, row.sheet) + '. ' + CC_AREA_LABELS[row.area].toUpperCase() + (detail ? ' — ' + detail : '');
  }

  function ccDrawCallout(ctx, callout) {
    const row = ccRowById(callout.rowId);
    const layout = ccPanelLayouts[callout.view];
    const image = ccImageById(callout.imageId, callout.sheet, callout.view);
    if (!row || !layout || !image) return;
    const selected = callout.id === ccSelectedCalloutId;
    const color = callout.color || CC_CALLOUT_COLOR;
    const label = ccWorldToCanvas(layout, ccWorldOf(image, callout.textPos));
    ctx.save();
    ctx.font = (selected ? 'bold ' : '') + '12px sans-serif';
    const lines = ccWrapLines(ctx, ccCalloutText(callout), CC_TEXT_WIDTH);
    const widths = lines.map(line => ctx.measureText(line).width);
    const box = { x: label.x - 5, y: label.y - 9, width: Math.max(34, ...widths) + 10, height: Math.max(1, lines.length) * CC_LINE_HEIGHT + 6 };
    ccBoxCache[callout.id] = box;
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillRect(box.x, box.y, box.width, box.height);
    callout.targets.forEach((target, index) => {
      const pin = ccWorldToCanvas(layout, ccWorldOf(image, target));
      const from = ccEdgeToward(box, pin);
      ctx.strokeStyle = color;
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(pin.x, pin.y);
      ctx.stroke();
      ccDrawArrow(ctx, from, pin, color);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pin.x, pin.y, index === 0 ? CC_PIN_RADIUS : CC_ANCHOR_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      if (index === 0) {
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ccRowSeq(row.id, row.sheet), pin.x, pin.y + .5);
      }
    });
    if (selected) {
      ctx.strokeStyle = '#3f8ae0';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
    ctx.font = (selected ? 'bold ' : '') + '12px sans-serif';
    ctx.fillStyle = callout.textRed ? '#cc0000' : '#111';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    lines.forEach((line, index) => ctx.fillText(line, label.x, label.y + index * CC_LINE_HEIGHT));
    ctx.restore();
  }

  function ccDrawCanvas() {
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    ccDrawCanvasInto(canvas, rect.width, rect.height, dpr);
  }

  // Draw the active sheet's working board (Outer/Inner panels + callouts)
  // into any canvas at a given CSS size and pixel scale. Extracted from
  // ccDrawCanvas so the Preview & Export page can render a chosen sheet
  // offscreen through the exact same drawing code the live board uses
  // (US-079: preview and export share one render path).
  function ccDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale) {
    canvas.width = Math.round(cssWidth * pixelScale);
    canvas.height = Math.round(cssHeight * pixelScale);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);
    ctx.fillStyle = '#eef0f4';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
    const gap = 12;
    const panelWidth = (cssWidth - gap * 3) / 2;
    const panelHeight = cssHeight - gap * 2;
    ccPanelLayouts = {
      outer: ccBuildPanelLayout('outer', gap, gap, panelWidth, panelHeight),
      inner: ccBuildPanelLayout('inner', gap * 2 + panelWidth, gap, panelWidth, panelHeight),
    };
    ccBoxCache = {};
    CC_VIEWS.forEach(view => {
      const layout = ccPanelLayouts[view];
      ctx.fillStyle = '#fff';
      ctx.fillRect(layout.x, layout.y, layout.width, layout.height);
      ctx.strokeStyle = view === ccActiveView ? '#1c6dd0' : '#c7ccd4';
      ctx.lineWidth = view === ccActiveView ? 2 : 1;
      ctx.strokeRect(layout.x, layout.y, layout.width, layout.height);
      ctx.fillStyle = view === ccActiveView ? '#eaf2ff' : '#f5f6f8';
      ctx.fillRect(layout.x, layout.y, layout.width, 30);
      ctx.fillStyle = '#111827';
      ctx.font = '600 13px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(view.toUpperCase(), layout.x + 10, layout.y + 15);
      const images = ccImages(ccSheet, view);
      if (!images.length) {
        ctx.strokeStyle = '#c8ccd4';
        ctx.setLineDash([6, 5]);
        ctx.strokeRect(layout.content.x, layout.content.y, layout.content.width, layout.content.height);
        ctx.setLineDash([]);
        ctx.fillStyle = '#7a8190';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Paste, drop, or add images to ' + view.toUpperCase(), layout.content.x + layout.content.width / 2, layout.content.y + layout.content.height / 2);
      }
      images.forEach(image => {
        const topLeft = ccWorldToCanvas(layout, { x: image.x, y: image.y });
        const width = image.width * layout.scale, height = image.height * layout.scale;
        const runtime = ccImageRuntime(image.id);
        if (runtime) ctx.drawImage(runtime, topLeft.x, topLeft.y, width, height);
        else {
          ctx.fillStyle = '#f3f4f6';
          ctx.fillRect(topLeft.x, topLeft.y, width, height);
          ctx.fillStyle = '#8b919c';
          ctx.textAlign = 'center';
          ctx.fillText('Image data unavailable', topLeft.x + width / 2, topLeft.y + height / 2);
        }
        if (image.id === ccSelectedImageId) {
          ctx.strokeStyle = '#3f8ae0';
          ctx.lineWidth = 2;
          ctx.strokeRect(topLeft.x - 2, topLeft.y - 2, width + 4, height + 4);
        }
      });
    });
    ccVisibleCallouts().forEach(callout => ccDrawCallout(ctx, callout));
  }

  // Offscreen render of ONE sheet (solid|lace) for the Preview & Export page
  // and the tech-pack Excel export. Swaps the module view state so the shared
  // draw code targets the requested sheet with no selection/active-panel
  // chrome, and restores it in finally so the live board never observes the
  // swap. ccPanelLayouts/ccBoxCache are hit-testing caches keyed to the live
  // canvas — they must be restored or clicks after a render would mis-hit.
  function ccRenderSheetToCanvas(sheet, cssWidth, cssHeight, pixelScale) {
    const saved = {
      sheet: ccSheet, view: ccActiveView, callout: ccSelectedCalloutId,
      image: ccSelectedImageId, layouts: ccPanelLayouts, boxes: ccBoxCache,
    };
    const canvas = document.createElement('canvas');
    try {
      ccSheet = ccSheetKey(sheet);
      ccActiveView = '';
      ccSelectedCalloutId = null;
      ccSelectedImageId = null;
      ccDrawCanvasInto(canvas, cssWidth, cssHeight, pixelScale || 1);
    } finally {
      ccSheet = saved.sheet;
      ccActiveView = saved.view;
      ccSelectedCalloutId = saved.callout;
      ccSelectedImageId = saved.image;
      ccPanelLayouts = saved.layouts;
      ccBoxCache = saved.boxes;
    }
    return canvas;
  }

  function ccAreaOptions(selected) {
    return CC_AREAS.map(area => '<option value="' + area + '"' + (area === selected ? ' selected' : '') + '>' + escapeHtml(CC_AREA_LABELS[area]) + '</option>').join('');
  }

  function ccRowHtml(row) {
    const callout = ccCalloutForRow(row.id);
    const selected = row.id === ccSelectedRowId || (callout && callout.id === ccSelectedCalloutId);
    return '<tr data-cc-row="' + row.id + '"' + (selected ? ' class="cc-row-selected"' : '') + '>'
      + '<td class="cc-tbl-seq">' + ccRowSeq(row.id) + '</td>'
      + '<td class="cc-tbl-view"><select data-cc-row-view="' + row.id + '" aria-label="Construction view">'
      + '<option value="outer"' + (row.view === 'outer' ? ' selected' : '') + '>Outer</option>'
      + '<option value="inner"' + (row.view === 'inner' ? ' selected' : '') + '>Inner</option></select></td>'
      + '<td class="cc-tbl-area"><select data-cc-row-area="' + row.id + '" aria-label="Construction area">' + ccAreaOptions(row.area) + '</select></td>'
      + '<td class="cc-tbl-detail"><div class="cc-detail-wrap"><textarea rows="1" spellcheck="false" data-cc-row-detail="' + row.id + '" aria-label="Construction detail">' + escapeHtml(row.detail) + '</textarea>'
      + '<button type="button" data-cc-phrase-row="' + row.id + '" title="Choose a construction phrase">&#9662;</button></div></td>'
      + '<td class="cc-tbl-callout"><button type="button" data-cc-row-callout="' + row.id + '" title="' + (callout ? 'Select existing callout' : 'Place callout') + '">' + (callout ? '&#9679;' : '&#8853;') + '</button></td>'
      + '<td class="cc-tbl-del"><button type="button" data-cc-row-del="' + row.id + '" title="Delete row">&#10005;</button></td>'
      + '</tr>';
  }

  function ccRenderTable() {
    const body = document.getElementById('ccTableBody');
    if (!body) return;
    const active = document.activeElement;
    if (active && body.contains(active)) return;
    body.innerHTML = CC_VIEWS.map(view => {
      const rows = ccRowsForView(view, ccSheet);
      return '<tr class="cc-view-band"><th colspan="6">' + view.toUpperCase() + '</th></tr>'
        + rows.map(ccRowHtml).join('')
        + '<tr class="cc-add-row"><td colspan="6"><button type="button" data-cc-add-row="' + view + '">&#65291; Add ' + view + ' row</button></td></tr>';
    }).join('');
  }

  function ccOpenPhraseMenu(rowId, button) {
    ccPhraseRowId = rowId;
    ccSelectedRowId = rowId;
    const row = ccRowById(rowId);
    if (row) ccActiveView = row.view;
    const menu = document.getElementById('ccPhraseMenu');
    const search = document.getElementById('ccPhraseSearch');
    if (!menu || !search) return;
    search.value = '';
    menu.hidden = false;
    const rect = button.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 390)) + 'px';
    menu.style.top = Math.min(rect.bottom + 4, window.innerHeight - 330) + 'px';
    ccRenderPhraseList();
    search.focus();
    renderConstruction();
  }

  function ccClosePhraseMenu() {
    const menu = document.getElementById('ccPhraseMenu');
    if (menu) menu.hidden = true;
    ccPhraseRowId = null;
  }

  function ccRenderPhraseList() {
    const search = document.getElementById('ccPhraseSearch');
    const list = document.getElementById('ccPhraseList');
    if (!list) return;
    const tokens = String((search && search.value) || '').toLowerCase().split(/\s+/).filter(Boolean);
    ccPhraseHits = (tokens.length
      ? CONSTRUCTION_PHRASES.filter(item => tokens.every(token => item.text.toLowerCase().includes(token)))
      : CONSTRUCTION_PHRASES.filter(item => item.favorite)).slice(0, 60);
    list.innerHTML = ccPhraseHits.map((item, index) => '<button type="button" data-cc-phrase="' + index + '">' + escapeHtml(item.text) + '</button>').join('')
      || '<div class="cc-phrase-empty">No matching phrase</div>';
  }

  function ccApplyPhrase(index) {
    const row = ccRowById(ccPhraseRowId);
    const item = ccPhraseHits[index];
    if (!row || !item) return;
    row.detail = item.text;
    ccClosePhraseMenu();
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccSyncUi() {
    document.querySelectorAll('[data-cc-sheet]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ccSheet === ccSheet));
    });
    document.querySelectorAll('[data-cc-active-view]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ccActiveView === ccActiveView));
    });
    const tools = {
      select: document.getElementById('ccSelectToolBtn'),
      callout: document.getElementById('ccAddCalloutBtn'),
      leader: document.getElementById('ccAddLeaderBtn'),
    };
    Object.keys(tools).forEach(tool => {
      const button = tools[tool];
      if (!button) return;
      button.classList.toggle('cc-tool-active', ccTool === tool);
      button.setAttribute('aria-pressed', String(ccTool === tool));
    });
    if (tools.leader) tools.leader.disabled = !ccSelectedCallout();
    const deleteCallout = document.getElementById('ccDeleteCalloutBtn');
    if (deleteCallout) deleteCallout.disabled = !ccSelectedCallout();
    const deleteImage = document.getElementById('ccDeleteImageBtn');
    if (deleteImage) deleteImage.disabled = !ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    const hint = document.getElementById('ccToolHint');
    if (hint) {
      if (ccTool === 'callout') {
        const row = ccRowById(ccSelectedRowId);
        hint.textContent = row ? 'Add Callouts: place row ' + ccRowSeq(row.id) + ' in ' + row.view.toUpperCase() + '; Select/Esc finishes.' : 'Add Callouts: place the highlighted row.';
      } else if (ccTool === 'leader') {
        hint.textContent = 'Add Leaders: click multiple targets on the selected callout image; Select/Esc finishes.';
      } else {
        hint.textContent = 'Active panel: ' + ccActiveView.toUpperCase() + ' · select a label, leader, target, or image to adjust it.';
      }
    }
    const canvas = document.getElementById('constructionCanvas');
    if (canvas) {
      canvas.classList.remove('cc-tool-select', 'cc-tool-callout', 'cc-tool-leader');
      canvas.classList.add('cc-tool-' + ccTool);
    }
  }

  function renderConstruction() {
    ensureConstruction();
    if (ccTool === 'leader' && !ccSelectedCallout()) ccTool = 'select';
    const title = document.getElementById('ccSheetTitle');
    if (title) title.textContent = 'CONSTRUCTION · ' + ccSheet.toUpperCase();
    ccDrawCanvas();
    ccRenderTable();
    ccSyncUi();
  }

  function ccEventPoint(event, canvas) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function ccOnPointerDown(event) {
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const point = ccEventPoint(event, canvas);
    const layout = ccPanelAt(point);
    if (!layout) return;
    ccActiveView = layout.view;
    const world = ccCanvasToWorld(layout, point);
    if (ccTool === 'callout') { ccCreateCalloutAt(layout, world); return; }
    if (ccTool === 'leader') { ccAddLeaderAt(layout, world); return; }
    const hit = ccHitTest(point);
    if (hit) {
      ccSelectedCalloutId = hit.callout.id;
      ccSelectedRowId = hit.callout.rowId;
      ccSelectedImageId = null;
      if (hit.part !== 'line') ccDrag = { kind: 'callout', hit };
      renderConstruction();
      event.preventDefault();
      return;
    }
    const image = ccImageAt(layout.view, world);
    if (image) {
      ccSelectedImageId = image.id;
      ccSelectedCalloutId = null;
      ccDrag = { kind: 'image', image, layout, prev: world };
    } else {
      ccSelectedImageId = null;
      ccSelectedCalloutId = null;
    }
    renderConstruction();
  }

  function ccOnPointerMove(event) {
    if (!ccDrag) return;
    const canvas = document.getElementById('constructionCanvas');
    if (!canvas) return;
    const point = ccEventPoint(event, canvas);
    if (ccDrag.kind === 'callout') {
      const hit = ccDrag.hit;
      const world = ccCanvasToWorld(hit.layout, point);
      const norm = ccNormalize(hit.image, world);
      if (hit.part === 'anchor') hit.callout.targets[hit.anchorIndex] = norm;
      else if (hit.part === 'label') hit.callout.textPos = norm;
    } else if (ccDrag.kind === 'image') {
      const world = ccCanvasToWorld(ccDrag.layout, point);
      ccDrag.image.x += world.x - ccDrag.prev.x;
      ccDrag.image.y += world.y - ccDrag.prev.y;
      ccDrag.prev = world;
    }
    ccDrawCanvas();
  }

  function ccOnPointerUp() {
    if (!ccDrag) return;
    ccDrag = null;
    pushHistoryIfChanged();
  }

  function initConstruction() {
    ensureConstruction();
    const page = document.getElementById('constructionPage');
    if (!page) return;
    const canvas = document.getElementById('constructionCanvas');
    const imageInput = document.getElementById('ccImageInput');
    const tableBody = document.getElementById('ccTableBody');

    document.querySelectorAll('[data-cc-sheet]').forEach(button => {
      button.addEventListener('click', () => {
        ccSheet = ccSheetKey(button.dataset.ccSheet);
        ccSelectedRowId = null;
        ccSelectedCalloutId = null;
        ccSelectedImageId = null;
        ccSetTool('select');
        renderConstruction();
      });
    });
    document.querySelectorAll('[data-cc-active-view]').forEach(button => {
      button.addEventListener('click', () => {
        ccActiveView = ccViewKey(button.dataset.ccActiveView);
        ccSelectedImageId = null;
        renderConstruction();
      });
    });

    const addImage = document.getElementById('ccAddImageBtn');
    if (addImage) addImage.addEventListener('click', () => imageInput && imageInput.click());
    if (imageInput) imageInput.addEventListener('change', async () => {
      await ccAddImageFiles(imageInput.files, ccSheet, ccActiveView);
      imageInput.value = '';
    });
    const pasteImage = document.getElementById('ccPasteImageBtn');
    if (pasteImage) pasteImage.addEventListener('click', async () => {
      if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
        showToast('Use Ctrl/Cmd+V while Construction is open to paste images.');
        return;
      }
      try {
        const items = await navigator.clipboard.read();
        const urls = [];
        for (const item of items) {
          const type = item.types.find(value => /^image\//i.test(value));
          if (type) urls.push(await blobToDataURL(await item.getType(type)));
        }
        if (urls.length) await ccAddImagesFromDataURLs(urls, ccSheet, ccActiveView);
        else showToast('Clipboard has no image.');
      } catch (_) { showToast('Clipboard access was blocked; use Ctrl/Cmd+V instead.'); }
    });
    const deleteImage = document.getElementById('ccDeleteImageBtn');
    if (deleteImage) deleteImage.addEventListener('click', ccDeleteSelectedImage);
    const zoomOut = document.getElementById('ccImageZoomOutBtn');
    const zoomIn = document.getElementById('ccImageZoomInBtn');
    if (zoomOut) zoomOut.addEventListener('click', () => ccZoomSelectedImage(0.9));
    if (zoomIn) zoomIn.addEventListener('click', () => ccZoomSelectedImage(1.1));
    const selectTool = document.getElementById('ccSelectToolBtn');
    const addCallout = document.getElementById('ccAddCalloutBtn');
    const addLeader = document.getElementById('ccAddLeaderBtn');
    const deleteCallout = document.getElementById('ccDeleteCalloutBtn');
    if (selectTool) selectTool.addEventListener('click', () => ccSetTool('select'));
    if (addCallout) addCallout.addEventListener('click', () => ccStartCalloutTool(ccSelectedRowId));
    if (addLeader) addLeader.addEventListener('click', () => ccSetTool('leader'));
    if (deleteCallout) deleteCallout.addEventListener('click', ccDeleteSelectedCallout);

    if (canvas) {
      canvas.addEventListener('mousedown', ccOnPointerDown);
      canvas.addEventListener('dblclick', event => {
        if (ccTool === 'select') ccDeleteAnchorAt(ccEventPoint(event, canvas));
      });
      canvas.addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
      canvas.addEventListener('drop', async event => {
        event.preventDefault();
        const layout = ccPanelAt(ccEventPoint(event, canvas));
        if (layout) ccActiveView = layout.view;
        await ccAddImageFiles(event.dataTransfer.files, ccSheet, ccActiveView);
      });
    }
    window.addEventListener('mousemove', ccOnPointerMove);
    window.addEventListener('mouseup', ccOnPointerUp);
    window.addEventListener('resize', () => { if (state.activePage === 'construction') ccDrawCanvas(); });

    if (tableBody) {
      tableBody.addEventListener('input', event => {
        const detail = event.target.closest('[data-cc-row-detail]');
        if (!detail) return;
        const row = ccRowById(Number(detail.dataset.ccRowDetail));
        if (!row) return;
        row.detail = detail.value;
        ccDrawCanvas();
      });
      tableBody.addEventListener('change', event => {
        const viewSelect = event.target.closest('[data-cc-row-view]');
        if (viewSelect) {
          const rowId = Number(viewSelect.dataset.ccRowView);
          const nextView = viewSelect.value;
          // A focused table control suppresses tbody rebuilds to preserve the
          // caret. Blur before moving so the row immediately relocates under
          // its new OUTER/INNER band.
          viewSelect.blur();
          ccMoveRowView(ccRowById(rowId), nextView);
          return;
        }
        const areaSelect = event.target.closest('[data-cc-row-area]');
        if (areaSelect) {
          const row = ccRowById(Number(areaSelect.dataset.ccRowArea));
          if (!row) return;
          row.area = ccNormalizeArea(areaSelect.value);
          ccDrawCanvas();
          pushHistoryIfChanged();
        }
      });
      tableBody.addEventListener('focusout', event => {
        if (event.target.closest('[data-cc-row-detail]')) {
          pushHistoryIfChanged();
          setTimeout(ccRenderTable, 0);
        }
      });
      tableBody.addEventListener('keydown', event => {
        const detail = event.target.closest('[data-cc-row-detail]');
        if (!detail || event.key !== 'Enter') return;
        if (event.shiftKey) return;
        event.preventDefault();
        detail.blur();
      });
      tableBody.addEventListener('click', event => {
        const phrase = event.target.closest('[data-cc-phrase-row]');
        if (phrase) { ccOpenPhraseMenu(Number(phrase.dataset.ccPhraseRow), phrase); return; }
        const callout = event.target.closest('[data-cc-row-callout]');
        if (callout) { callout.blur(); ccArmRowCallout(Number(callout.dataset.ccRowCallout)); return; }
        const remove = event.target.closest('[data-cc-row-del]');
        if (remove) { remove.blur(); ccDeleteRow(Number(remove.dataset.ccRowDel)); return; }
        const add = event.target.closest('[data-cc-add-row]');
        if (add) { add.blur(); ccAddRow(add.dataset.ccAddRow); return; }
        if (event.target.closest('select,textarea,button')) return;
        const tr = event.target.closest('tr[data-cc-row]');
        if (!tr) return;
        const row = ccRowById(Number(tr.dataset.ccRow));
        if (!row) return;
        ccSelectedRowId = row.id;
        ccActiveView = row.view;
        const existing = ccCalloutForRow(row.id);
        ccSelectedCalloutId = existing ? existing.id : null;
        renderConstruction();
      });
    }

    const phraseSearch = document.getElementById('ccPhraseSearch');
    const phraseList = document.getElementById('ccPhraseList');
    if (phraseSearch) phraseSearch.addEventListener('input', ccRenderPhraseList);
    if (phraseList) phraseList.addEventListener('click', event => {
      const button = event.target.closest('[data-cc-phrase]');
      if (button) ccApplyPhrase(Number(button.dataset.ccPhrase));
    });
    document.addEventListener('click', event => {
      const menu = document.getElementById('ccPhraseMenu');
      if (menu && !menu.hidden && !event.target.closest('#ccPhraseMenu,[data-cc-phrase-row]')) ccClosePhraseMenu();
    });
    document.addEventListener('paste', async event => {
      if (state.activePage !== 'construction') return;
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
      const files = Array.from((event.clipboardData && event.clipboardData.items) || [])
        .filter(item => item.kind === 'file' && /^image\//i.test(item.type || ''))
        .map(item => item.getAsFile()).filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      await ccAddImageFiles(files, ccSheet, ccActiveView);
    }, true);
    document.addEventListener('keydown', event => {
      if (state.activePage !== 'construction') return;
      if (event.key === 'Escape') {
        if (ccTool !== 'select') { ccSetTool('select'); return; }
        if (ccSelectedCalloutId != null || ccSelectedImageId != null || ccSelectedRowId != null) {
          ccSelectedCalloutId = null; ccSelectedImageId = null; ccSelectedRowId = null; renderConstruction(); return;
        }
        setActivePage('board');
        return;
      }
      if (event.key === 'Backspace') {
        const active = document.activeElement;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable)) return;
        if (ccSelectedCallout()) { event.preventDefault(); ccDeleteSelectedCallout(); }
      }
    }, true);
    renderConstruction();
  }
