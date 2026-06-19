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

  const RULES = window.BraMeasurementRules;
  if (!RULES) throw new Error('Missing auto_mode_rules.js');
  const POM_UNIT = RULES.POM_UNIT;
  const POM_TEMPLATE = RULES.POM_TEMPLATE;
  const POM_PAIR_PRIMARIES = RULES.POM_PAIR_PRIMARIES;
  const POM_PAIR_SECONDARIES = (() => {
    const map = Object.create(null);
    for (const primary of Object.keys(POM_PAIR_PRIMARIES)) {
      map[POM_PAIR_PRIMARIES[primary].partner] = primary;
    }
    return map;
  })();
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
    exportPdfBtn: document.getElementById('exportPdfBtn'),
    importPptxBtn: document.getElementById('importPptxBtn'),
    pptxFileInput: document.getElementById('pptxFileInput'),
    saveProjectBtn: document.getElementById('saveProjectBtn'),
    openProjectBtn: document.getElementById('openProjectBtn'),
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
    autoDetectBtn: document.getElementById('autoDetectBtn'),
    autoResetAnchorsBtn: document.getElementById('autoResetAnchorsBtn'),
    autoGenerateBtn: document.getElementById('autoGenerateBtn'),
    autoApproveBtn: document.getElementById('autoApproveBtn'),
    autoReviewOnlyBtn: document.getElementById('autoReviewOnlyBtn'),
    autoApplyBtn: document.getElementById('autoApplyBtn'),
    autoDiscardBtn: document.getElementById('autoDiscardBtn'),
    autoResetBoardBtn: document.getElementById('autoResetBoardBtn'),
    autoLearnToggleBtn: document.getElementById('autoLearnToggleBtn'),
    autoLearnChip: document.getElementById('autoLearnChip'),
    autoLearnMenuWrap: document.getElementById('autoLearnMenuWrap'),
    autoLearnMenuBtn: document.getElementById('autoLearnMenuBtn'),
    autoLearnMenuList: document.getElementById('autoLearnMenuList'),
    resetResidualsItem: document.getElementById('resetResidualsItem'),
    resetMeaningsCurrentItem: document.getElementById('resetMeaningsCurrentItem'),
    resetMeaningsAllItem: document.getElementById('resetMeaningsAllItem'),
    manageMeaningsItem: document.getElementById('manageMeaningsItem'),
    autoStatusChip: document.getElementById('autoStatusChip'),
    pomMeaningPopover: document.getElementById('pomMeaningPopover'),
    pmpPomLabel: document.getElementById('pmpPomLabel'),
    pmpSuggestions: document.getElementById('pmpSuggestions'),
    pmpOtherBtn: document.getElementById('pmpOtherBtn'),
    pmpSkipBtn: document.getElementById('pmpSkipBtn'),
    annContextMenu: document.getElementById('annContextMenu'),
    annCtxReconfirm: document.getElementById('annCtxReconfirm'),
    styleIdInput: document.getElementById('styleIdInput'),
  };

  let ctx = el.canvas.getContext('2d');

  // Image pixel data is stored once per image id here, so history snapshots can
  // reference images by id instead of carrying (and re-serializing) base64 copies.
  const imageDataById = new Map();

  const state = {
    tool: 'select',
    drawStyle: 'solid',
    drawColor: 'red',
    arrowType: 'double',
    lineWidth: DEFAULT_LINE_WIDTH,
    annotations: [],
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

    calibration: { unitsPerPx: null, unit: 'cm' },
    editingLabelId: null,

    history: {
      past: [],
      future: [],
      restoring: false,
    },

    appMode: 'manual',
    autoMode: makeInitialAutoModeState(),

    // Phase 3.5: per-project style code. Drives meaning store scoping
    // (POM 6+ meanings are keyed by this). Empty string falls back to
    // a shared '__default__' bucket. Saved with the project.
    styleId: '',
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
    };
  }

  function init() {
    bindUI();
    resizeCanvas();
    seedHistory();
    updateUI();
    render();
    void loadProjectFromUrl().then(() => maybeAutoDraftFromUrl());
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
