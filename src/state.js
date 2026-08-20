// Core app state shape: shared constants, the RULES-derived POM/anchor
// aliases, and the `state` object itself. DOM handles live in dom-refs.js,
// boot sequencing in bootstrap.js, URL-driven test/demo bootstrap in
// dev/url-bootstrap.js.
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
    // Cmd/Ctrl+click multi-selection of images. Always includes the primary
    // `selection` when that is an image; empty otherwise. The primary stays the
    // resize/spec anchor — this set only widens what a group drag / delete acts
    // on. Session-only (not part of the project snapshot).
    selectedImageIds: [],
    // Shift+click / marquee-drag multi-selection of POM lines (annotations).
    // Same derive-through-primary contract as selectedImageIds — always
    // includes the primary `selection` when it is an annotation. Widens what
    // group copy / reflect / delete / drag act on. Session-only.
    selectedAnnotationIds: [],

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
    // US-086: the canvas rect pinned for the duration of one pointer gesture.
    // Null except between mousedown and mouseup. See getMousePos.
    gestureCanvasRect: null,
    // US-088: the canvas rect as of the last resizeCanvas(). Deliberately NOT
    // lastCanvasRect, which getMousePos overwrites with the live rect on every
    // pointer event — diffing against that would read zero change and skip the
    // compensation exactly when a reflow happened mid-gesture. See resizeCanvas.
    sizedCanvasRect: null,
    // The devicePixelRatio the backing buffer was sized for. The buffer is a
    // function of the CSS box AND the density, so a density change alone still
    // needs a resize — and a ResizeObserver cannot see one.
    sizedCanvasDpr: null,
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
    // Lives in project state — the 18-POM rule JSON is never touched.
    // Persisted with the project and captured in history.
    customPoms: [],

    // Which size columns Export Excel emits: { alpha: [...], depth: [...] }
    // of SPEC_SIZE_RUN labels. null → all 15 sizes (back-compat default).
    // Persisted with the project (not in history — an export preference,
    // not board content).
    sizeSelection: null,

    // US-068 / ADR 0037: tech pack MAIN PAGE sheet — style metadata (13
    // fields), off-list values the TD typed (fieldExtra), colorways, and the
    // Color Master List copy this project was saved against. Style metadata
    // only: no anchor, no POM, no view, so detection never reads it. Seeded
    // lazily by ensureMainPage() in src/ui/main-page.js, which owns the field
    // roster and the colour data — null here so state.js does not carry 47
    // colour rows. Persisted with the project and captured in history so
    // undo/redo covers MAIN PAGE edits.
    mainPage: null,

    // US-078 / ADR 0045: two Construction sheets (Solid/Lace), each with
    // independently-owned Outer/Inner working-view images, editable operation
    // rows, and row-owned multi-leader callouts. Image bytes live outside
    // history and are injected only for project save/autosave. No anchor or
    // POM consumes this metadata, so detection remains isolated.
    construction: null,

    // US-072 / ADR 0041: BOM page — editable material table rows
    // { id, section:'FABRIC'|'TRIM', scope:'BOTH'|'SOLID'|'LACE', cells:{...},
    // cwOverride:{} }, variant-owned Material Key image metadata under
    // images.solid/images.lace, plus callouts { id, rowId, imageId, variant,
    // targets:[{nx,ny},...], textPos:{nx,ny} }. BOM image bytes live outside
    // history state and are materialized only for project save/autosave.
    // mod-bom module on this tool's own primitives; no anchor, no POM, so
    // detection never reads it. Seeded lazily by ensureBom() in
    // src/ui/bom.js — a first-time BOM materializes as the reference
    // sheet's exact 12-row BOM (BM_SEED_ROWS, US-074), guarded by
    // bom.seedId so an emptied table stays empty. Null here so state.js
    // does not carry row/callout data by default. Persisted with the
    // project and captured in history so undo/redo covers BOM edits.
    bom: null,

    // src/ui/preview-page.js — Preview & Export page-inclusion checkboxes
    // ({ enabledPages: { <sheetKey>: boolean } }, US-079/ADR 0046). Null here;
    // initPreviewPage materializes the all-enabled default before seedHistory.
    // Persisted with the project and captured in history.
    preview: null,

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
