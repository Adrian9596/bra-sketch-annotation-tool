// State, constants, DOM handles, initialization, URL demo bootstrap.
// Source part for app.js. Run `npm run build` after editing.

  const LINE_COLORS = {
    red: '#e63939',
    blue: '#2563eb',
    black: '#111827',
    white: '#ffffff',
  };
  const LINE_COLOR = LINE_COLORS.red;
  const SELECT_COLOR = '#356dff';

  const RULES = loadAutoModeRules();
  if (!RULES) throw new Error('Missing Auto Mode JSON rules');
  const POM_UNIT = RULES.POM_UNIT;
  const POM_TEMPLATE = RULES.POM_TEMPLATE;
  const POM_PAIR_PRIMARIES = RULES.POM_PAIR_PRIMARIES;
  const POM_SUGGESTIONS = RULES.POM_SUGGESTIONS || {};
  const ANCHOR_SCHEMA = RULES.ANCHOR_SCHEMA;
  const AUTO_TEMPLATE_VERSION = RULES.AUTO_TEMPLATE_VERSION;
  const AUTO_RULE_VERSION = RULES.AUTO_RULE_VERSION;
  const PROJECT_FORMAT = 'bra-sketch-project';
  const PROJECT_VERSION = 1;
  const MIN_ZOOM = 0.15;
  const MAX_ZOOM = 8;
  const HISTORY_LIMIT = 120;
  const BEZIER_SAMPLES = 25;
  const IMAGE_PADDING = 48;
  const DEFAULT_LINE_WIDTH = 2.5;
  const MIN_LINE_WIDTH = 1;
  const MAX_LINE_WIDTH = 16;
  const ZOOM_SENSITIVITY = 0.0018;
  const PRECISE_ZOOM_SENSITIVITY = 0.00105;

  const el = {
    canvas: document.getElementById('boardCanvas'),
    boardCard: document.getElementById('boardCard'),
    boardEmptyImport: document.getElementById('boardEmptyImport'),
    boardEmptyAdd: document.getElementById('boardEmptyAdd'),
    addImageBtn: document.getElementById('addImageBtn'),
    imageFileInput: document.getElementById('imageFileInput'),
    helpBtn: document.getElementById('helpBtn'),
    toolSelect: document.getElementById('toolSelect'),
    toolStraight: document.getElementById('toolStraight'),
    toolCurved: document.getElementById('toolCurved'),
    toolEraser: document.getElementById('toolEraser'),
    lineStyleControl: document.getElementById('lineStyleControl'),
    stitchesBtn: document.getElementById('stitchesBtn'),
    stitchesBtnLabel: document.getElementById('stitchesBtnLabel'),
    stitchesMenu: document.getElementById('stitchesMenu'),
    styleOptionBtns: Array.from(document.querySelectorAll('.style-option')),
    lineWidthChip: document.getElementById('lineWidthChip'),
    lineWidthInput: document.getElementById('lineWidthInput'),
    brushSizeChip: document.getElementById('brushSizeChip'),
    brushSizeInput: document.getElementById('brushSizeInput'),
    arrowDoubleBtn: document.getElementById('arrowDoubleBtn'),
    arrowSingleBtn: document.getElementById('arrowSingleBtn'),
    arrowNoneBtn: document.getElementById('arrowNoneBtn'),
    colorRedBtn: document.getElementById('colorRedBtn'),
    colorBlueBtn: document.getElementById('colorBlueBtn'),
    colorBlackBtn: document.getElementById('colorBlackBtn'),
    colorWhiteBtn: document.getElementById('colorWhiteBtn'),
    undoBtn: document.getElementById('undoBtn'),
    redoBtn: document.getElementById('redoBtn'),
    copyLineBtn: document.getElementById('copyLineBtn'),
    pasteLineBtn: document.getElementById('pasteLineBtn'),
    reflectLineBtn: document.getElementById('reflectLineBtn'),
    deleteBtn: document.getElementById('deleteBtn'),
    clearBtn: document.getElementById('clearBtn'),
    lockImageBtn: document.getElementById('lockImageBtn'),
    lockImageLabel: document.getElementById('lockImageLabel'),
    lockImageIco: document.getElementById('lockImageIco'),
    fitBtn: document.getElementById('fitBtn'),
    togglePanelBtn: document.getElementById('togglePanelBtn'),
    toggleLabelsBtn: document.getElementById('toggleLabelsBtn'),
    workspace: document.querySelector('.workspace'),
    setScaleBtn: document.getElementById('setScaleBtn'),
    clearScaleBtn: document.getElementById('clearScaleBtn'),
    sizeRunBtn: document.getElementById('sizeRunBtn'),
    gradingBtn: document.getElementById('gradingBtn'),
    exportPdfBtn: document.getElementById('exportPdfBtn'),
    exportExcelBtn: document.getElementById('exportExcelBtn'),
    copyImageBtn: document.getElementById('copyImageBtn'),
    importPptxBtn: document.getElementById('importPptxBtn'),
    pptxFileInput: document.getElementById('pptxFileInput'),
    saveProjectBtn: document.getElementById('saveProjectBtn'),
    openProjectBtn: document.getElementById('openProjectBtn'),
    libraryBtn: document.getElementById('libraryBtn'),
    projectFileInput: document.getElementById('projectFileInput'),
    labelEditor: document.getElementById('labelEditor'),
    specBody: document.getElementById('specBody'),
    specEmpty: document.getElementById('specEmpty'),
    specCal: document.getElementById('specCal'),
    toolStatus: document.getElementById('toolStatus'),
    imageStatus: document.getElementById('imageStatus'),
    countStatus: document.getElementById('countStatus'),
    toast: document.getElementById('toast'),
    modeManualBtn: document.getElementById('modeManualBtn'),
    modeAutoBtn: document.getElementById('modeAutoBtn'),
    autoModeBar: document.getElementById('autoModeBar'),
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoResetAnchorsBtn: document.getElementById('autoResetAnchorsBtn'),
    autoManageAnchorsBtn: document.getElementById('autoManageAnchorsBtn'),
    anchorManagerPanel: document.getElementById('anchorManagerPanel'),
    anchorManagerBody: document.getElementById('anchorManagerBody'),
    anchorManagerCount: document.getElementById('anchorManagerCount'),
    anchorManagerCloseBtn: document.getElementById('anchorManagerCloseBtn'),
    anchorManagerHideAllBtn: document.getElementById('anchorManagerHideAllBtn'),
    anchorManagerShowAllBtn: document.getElementById('anchorManagerShowAllBtn'),
    autoGenerateBtn: document.getElementById('autoGenerateBtn'),
    autoApproveBtn: document.getElementById('autoApproveBtn'),
    autoReviewOnlyBtn: document.getElementById('autoReviewOnlyBtn'),
    autoApplyBtn: document.getElementById('autoApplyBtn'),
    autoDiscardBtn: document.getElementById('autoDiscardBtn'),
    autoResetBoardBtn: document.getElementById('autoResetBoardBtn'),
    autoLearnToggleBtn: document.getElementById('autoLearnToggleBtn'),
    autoLearnChip: document.getElementById('autoLearnChip'),
    autoAcceptanceChip: document.getElementById('autoAcceptanceChip'),
    autoLearnMenuWrap: document.getElementById('autoLearnMenuWrap'),
    autoLearnMenuBtn: document.getElementById('autoLearnMenuBtn'),
    autoLearnMenuList: document.getElementById('autoLearnMenuList'),
    viewLearningDataItem: document.getElementById('viewLearningDataItem'),
    resetResidualsItem: document.getElementById('resetResidualsItem'),
    resetMeaningsCurrentItem: document.getElementById('resetMeaningsCurrentItem'),
    resetMeaningsAllItem: document.getElementById('resetMeaningsAllItem'),
    learningToolbarBtn: document.getElementById('learningToolbarBtn'),
    learningToolbarChip: document.getElementById('learningToolbarChip'),
    autoStatusChip: document.getElementById('autoStatusChip'),
    autoStepIndicator: document.getElementById('autoStepIndicator'),
    visionEngineChip: document.getElementById('visionEngineChip'),
    styleIdInput: document.getElementById('styleIdInput'),
  };

  let ctx = el.canvas.getContext('2d');

  // Image pixel data is stored once per image id here, so history snapshots can
  // reference images by id instead of carrying (and re-serializing) base64 copies.
  const imageDataById = new Map();

  // ---- Grade rules v2 container (US-011) ----------------------------------
  // One persisted object holds every TD grading override:
  //   steps        — v1 constant-step overrides { [pom]: {step, hold} }
  //                  (step in the project unit, as the Size Run dialog wrote)
  //   alpha, depth — per-POM per-size delta overrides { [pom]: {[size]: Δ} },
  //                  stored in INCHES (unit-independent, converted at use like
  //                  the built-ins). Written by the Grading dialog (S3).
  //   depthOffsets — the former state.depthRules { [pom]: {offset} } (project
  //                  unit), absorbed here so one field persists all grading.
  function makeEmptyGradeRulesV2() {
    return { version: 2, steps: {}, alpha: {}, depth: {}, depthOffsets: {} };
  }

  // Lossless upgrade of persisted grading state to the v2 container.
  // Accepts: a v2 container (returned normalized), a v1 map of
  // { [pom]: {step, hold} } entries, or null/garbage (fresh container).
  // legacyDepthRules is the old separate state.depthRules field from
  // pre-US-011 files; it folds into depthOffsets.
  function migrateGradeRulesV2(raw, legacyDepthRules) {
    const out = makeEmptyGradeRulesV2();
    if (raw && typeof raw === 'object') {
      if (raw.version === 2) {
        for (const k of ['steps', 'alpha', 'depth', 'depthOffsets']) {
          if (raw[k] && typeof raw[k] === 'object') out[k] = JSON.parse(JSON.stringify(raw[k]));
        }
      } else {
        // v1: version-less map of per-POM {step, hold} overrides.
        for (const key of Object.keys(raw)) {
          const e = raw[key];
          if (e && typeof e === 'object' && ('step' in e || 'hold' in e)) {
            out.steps[key] = { ...e };
          }
        }
      }
    }
    if (legacyDepthRules && typeof legacyDepthRules === 'object') {
      for (const key of Object.keys(legacyDepthRules)) {
        const e = legacyDepthRules[key];
        if (e && typeof e === 'object' && e.offset != null && out.depthOffsets[key] == null) {
          out.depthOffsets[key] = { ...e };
        }
      }
    }
    return out;
  }

  // Custom POM registry lookup (US-011 S4). Custom POMs (17+) live in
  // state.customPoms — never in the 16-POM rule JSON (ADR 0018).
  function customPomEntry(pomKey) {
    const key = String(pomKey == null ? '' : pomKey).trim();
    if (!key) return null;
    return (state.customPoms || []).find(p => String(p.pom) === key) || null;
  }

  // Next free custom POM number: one past the highest of 16 and any
  // existing custom or annotation label number.
  function nextCustomPomNumber() {
    // Core template now reserves 1..18 (US-037: neckline 17, armhole 18);
    // custom POMs start at 19. See ADR 0032.
    let max = 18;
    for (const p of state.customPoms || []) {
      const n = Number(p.pom);
      if (Number.isFinite(n) && n > max) max = n;
    }
    for (const ann of state.annotations || []) {
      const n = Number(ann.text != null ? ann.text : NaN);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max + 1;
  }

  const state = {
    tool: 'select',
    drawStyle: 'solid',
    drawColor: 'red',
    arrowType: 'double',
    lineWidth: DEFAULT_LINE_WIDTH,
    annotations: [],
    deletedAutoAnnotations: [],
    // US-047: POM labels whose drawn line the TD deleted. Excluded from the
    // exported spec exactly like a hidden line (TD: "delete = hide"), until a
    // line with that label is redrawn. Persisted with the project + history.
    deletedPomKeys: [],
    images: [],
    eraseStrokes: [],
    brushSize: 24,
    showLabels: true,
    nextSequence: 1,
    selection: { kind: null, id: null },

    zoom: 1,
    panX: 0,
    panY: 0,

    drawSession: null,
    eraseSession: null,
    interaction: null,

    spacePan: false,
    rafPending: false,
    toastTimer: null,
    lastCanvasRect: null,
    idCounter: 1,

    calibration: { unitsPerPx: null, unit: 'in' },
    editingLabelId: null,

    history: {
      past: [],
      future: [],
      restoring: false,
    },

    appMode: 'auto',
    autoMode: makeInitialAutoModeState(),

    // S1: OpenCV WASM warm-up status for the toolbar readiness chip.
    //   'warming'     — vendored opencv.js still loading / compiling
    //   'ready'       — real backend compiled; Detect uses best quality
    //   'unavailable' — script failed (or ?freeCv=1 pin) → free fallback
    // Session-only UI state: never serialized with projects or history.
    visionEngine: 'warming',

    // Phase 3.5: per-project style code. Drives meaning store scoping
    // (POM 6+ meanings are keyed by this). Empty string falls back to
    // a shared '__default__' bucket. Saved with the project.
    styleId: '',

    // Per-POM spec sheet targets (Size L nominal + tolerance) shown in
    // the side panel next to the measured Value column. Keyed by POM
    // label ("1".."16"). Persisted with the project and captured in
    // history snapshots so undo/redo covers spec edits.
    pomSpecs: {},

    // Grading overrides, v2 container (US-011): constant-step overrides
    // (steps, the old v1 shape), per-size delta overrides (alpha/depth, from
    // the Grading dialog), and L2−L offsets (depthOffsets, the former
    // state.depthRules). Only TD overrides are stored; built-in defaults live
    // in export-xlsx.js. Persisted with the project and captured in history
    // so undo/redo covers grade edits. Old files migrate on load via
    // migrateGradeRulesV2.
    gradeRules: makeEmptyGradeRulesV2(),

    // TD-defined POMs beyond the standard 16 (US-011, ADR 0018). Array of
    // { pom: '17', en, zh, tol }. Numbering continues from 17 per project.
    // Lives in project state — the 16-POM rule JSON is never touched.
    // Persisted with the project and captured in history.
    customPoms: [],

    // Which size columns Export Excel emits: { alpha: [...], depth: [...] }
    // of SPEC_SIZE_RUN labels. null → all 15 sizes (back-compat default).
    // Persisted with the project (not in history — an export preference,
    // not board content).
    sizeSelection: null,

    // Review-time per-POM visibility toggles. When an annotation / draft id
    // is in these lists it is skipped by the canvas renderer and hit-test
    // so the TD can isolate one POM line to sanity-check the detection.
    // Session-only: NOT persisted, NOT in history — the panel is a review
    // overlay, not project data. Reset on project load / mode change /
    // reset working board (see project-io + mode.js + draft-actions).
    hiddenAnnIds: [],
    hiddenDraftIds: [],
  };

  // Auto Mode allowed statuses:
  //   idle, ready, detecting, detected, loading, reviewing, applying, error
  function makeInitialAutoModeState() {
    return {
      status: 'idle',
      runId: null,
      draftAnnotations: [],
      validation: null,
      lastError: null,
      // Offline sketch detection result. Populated by runOfflineDetection()
      // — null until the user clicks Detect Sketch on a source image.
      //   {
      //     sourceImageId, computedAt, durationMs, sampleWidth,
      //     bbox:     { x, y, width, height }       // normalized [0,1]^2
      //     axisX:    number                         // normalized, vertical sym. axis
      //     bandY:    number                         // normalized, bottom-band guess
      //     chestY:   number | null                  // normalized, chest-line guess
      //     coverage: number                         // share of dark pixels
      //   }
      detection: null,
      // Phase 2: draggable named anchors. One record per ANCHOR_SCHEMA entry,
      // each { id, kind, name, x, y, sourceImageId, confidence, autoFilled }.
      // x/y are normalized [0, 1] relative to the source image. Seeded by
      // prefillAnchorsFromDetection(); the TD then drags them; the POM
      // generator reads them by kind.
      anchors: [],
      anchorSelectedId: null,
      // After a successful apply the anchor pins are hidden so the applied
      // POM lines stay readable. Detect / Reset Anchors show them again.
      anchorsHidden: false,
      // US-038: per-anchor visibility (session-only view state, not
      // persisted, not in history). An anchor is visible iff
      // !anchorsHidden && !hiddenAnchorKinds.includes(kind). Reset on
      // re-seed. Managed from the Anchors section of the Measurements panel.
      hiddenAnchorKinds: [],
      // CV debug capture. When enabled (via window.__braAutoModeDebug.cv
      // .setEnabled(true) or ?cvDebug=1), runOfflineDetection asks the pure
      // pipeline to attach an intermediate-state object to the returned
      // detection. The last capture is mirrored here so it can be exported
      // / downloaded independently of the live detection object.
      cvDebug: {
        enabled: false,
        lastDebug: null,
        lastExport: null,
      },
    };
  }

  function init() {
    // S1: start watching the vendored OpenCV build immediately (fire and
    // forget) so the WASM compiles while the TD is still adding the sketch,
    // and the readiness chip never stalls silently on the first Detect.
    warmupVisionEngine();
    bindUI();
    // Auto-only build: boot straight into Auto Mode (sets body class,
    // status chip, and locks manual editing paths).
    setAppMode('auto');
    resizeCanvas();
    seedHistory();
    updateUI();
    render();
    maybeShowGroundTruthLabeler();
    // Ground-truth labeling (?label=1) is an ephemeral, one-image-per-URL flow:
    // don't autosave it or offer to restore a prior label session, which would
    // pop a "Recovered work" modal over the board on every reload.
    const labeling = new URLSearchParams(window.location.search).get('label') === '1';
    if (!labeling) armAutosave();
    void loadProjectFromUrl()
      .then(() => (labeling ? null : maybeOfferAutosaveRestore()))
      .then(() => maybeAutoDraftFromUrl());
  }

  // S1: watch the real OpenCV backend's readiness and mirror it into
  // state.visionEngine for the toolbar chip. Does not restart the polling —
  // opencv_real_api.js already began watching when its script loaded; this
  // just observes the same promise. Best-effort: any failure means the app
  // keeps working on the FreeOpenCVAPI fallback exactly as before.
  function warmupVisionEngine() {
    const real = typeof window !== 'undefined' ? window.RealOpenCVAPI : null;
    if (FORCE_FREE_CV || !real || typeof real.whenReady !== 'function') {
      state.visionEngine = 'unavailable';
      return;
    }
    if (typeof real.isReady === 'function' && real.isReady()) {
      state.visionEngine = 'ready';
      return;
    }
    state.visionEngine = 'warming';
    real.whenReady()
      .then((ready) => {
        state.visionEngine = ready ? 'ready' : 'unavailable';
        updateUI();
      })
      .catch(() => {
        state.visionEngine = 'unavailable';
        updateUI();
      });
  }

  // Ground-truth labeling helper: ?label=1 shows a floating "Save Ground
  // Truth" button. The TD runs Detect Sketch, drags anchors to the correct
  // positions, then clicks Save to download a JSON file for the accuracy
  // harness (scripts/accuracy-tests.mjs). Hidden unless the param is present,
  // so it never touches the normal toolbar layout.
  function maybeShowGroundTruthLabeler() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('label') !== '1') return;
    const btn = document.createElement('button');
    btn.id = 'gtLabelBtn';
    btn.type = 'button';
    btn.textContent = '💾 Save Ground Truth';
    btn.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px', 'z-index:9999',
      'padding:8px 12px', 'background:#b3005a', 'color:#fff', 'border:none',
      'border-radius:6px', 'font:13px system-ui,sans-serif', 'cursor:pointer',
      'box-shadow:0 2px 8px rgba(0,0,0,.3)',
    ].join(';');
    btn.addEventListener('click', () => {
      if (state.appMode !== 'auto' || !state.autoMode.anchors.length) {
        showToast('Switch to Auto Mode, run Detect Sketch, and correct the anchors first.', 4200);
        return;
      }
      const suggested = (window.__braGroundTruthName || 'sketch.jpg') + '.json';
      const name = window.prompt(
        'Ground-truth file name (match the image, e.g. demo1.jpg.json):',
        suggested
      );
      if (!name) return;
      downloadGroundTruth(name);
    });
    document.body.appendChild(btn);

    // Convenience for building the accuracy corpus: ?label=1&image=demo/demo1.jpg
    // auto-loads that image, runs Detect Sketch, and pre-fills the save file
    // name — so labeling a corpus is "open URL → drag the wrong anchors → Save",
    // one image per URL. Absent the param, the manual add-image flow is unchanged.
    const imagePath = params.get('image');
    if (imagePath) void autoLoadLabelImage(imagePath);
  }

  // Fetch a same-origin image, put it on the board, and run Detect Sketch so the
  // detector's seeded anchors are ready for the TD to correct. Used only by the
  // ?label=1&image= labeling flow above. Best-effort: on any failure it falls
  // back to the manual add-image path with a toast.
  async function autoLoadLabelImage(imagePath) {
    try {
      const res = await fetch(encodeURI(imagePath), { cache: 'no-store' });
      if (!res.ok) throw new Error('fetch ' + res.status);
      const blob = await res.blob();
      const dataURL = await new Promise((ok, no) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result || ''));
        r.onerror = () => no(new Error('read failed'));
        r.readAsDataURL(blob);
      });
      setAppMode('auto');
      await addImagesFromDataURLs([dataURL]);
      await new Promise((r) => setTimeout(r, 80));
      const sourceImage = state.images[state.images.length - 1] || null;
      if (!sourceImage) throw new Error('image did not load');
      state.selection = { kind: 'image', id: sourceImage.id };
      window.__braGroundTruthName = imagePath.split('/').pop();
      await runOfflineDetection();
      updateUI();
      render();
      const n = state.autoMode.anchors.length;
      showToast('Loaded ' + window.__braGroundTruthName + ' — ' + n
        + ' anchors detected. Click "Fit", drag any anchors that are off, then Save Ground Truth.', 6000);
    } catch (err) {
      console.error('[Ground Truth] auto-load failed:', err);
      showToast('Could not auto-load ' + imagePath + ' — add it manually, then Detect Sketch.', 5200);
    }
  }

  async function loadProjectFromUrl() {
    const projectUrl = new URLSearchParams(window.location.search).get('project');
    if (!projectUrl) return;
    try {
      const response = await fetch(projectUrl, { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load project');
      await loadProject(await response.json());
      showToast('Draft project loaded.');
    } catch (error) {
      console.error(error);
      showToast('Could not load the draft project.', 4200);
    }
  }

  // Demo helper: ?autoDraft=1 drives Auto Mode → Detect Sketch → Generate POM
  // Drafts on whatever image is on the board after load. Lets the demo flow be
  // shared as a URL without manual clicking. No-op when the param is absent.
  async function maybeAutoDraftFromUrl() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autoDraft') !== '1') return;
    const waitForImage = async () => {
      for (let i = 0; i < 50; i += 1) {
        const img = pickAutoSourceImage();
        if (img && img.img && img.img.complete) return img;
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
    };
    const sourceImage = await waitForImage();
    if (!sourceImage) {
      showToast('autoDraft: no source image found.', 4200);
      return;
    }
    setAppMode('auto');
    await runOfflineDetection();
    if (state.autoMode.status !== 'detected') {
      showToast('autoDraft: detection did not complete.', 4200);
      return;
    }
    generatePOMDraftsFromAnchors();
  }
