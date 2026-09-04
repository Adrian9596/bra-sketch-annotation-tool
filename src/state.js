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

  // US-092 Board text notes. Every size is in WORLD pixels, not screen pixels,
  // so a note keeps its size relative to the sketch it annotates — resizing the
  // photo scales the note with it (scaleNoteAbout), exactly as it scales the POM
  // lines drawn on that photo (US-091).
  const NOTE_DEFAULT_FONT_SIZE = 16;
  const NOTE_MIN_FONT_SIZE = 5;
  const NOTE_MAX_FONT_SIZE = 200;
  const NOTE_DEFAULT_BOX_WIDTH = 220;
  const NOTE_MIN_BOX_WIDTH = 40;
  const NOTE_MAX_BOX_WIDTH = 4000;
  const NOTE_LINE_HEIGHT_RATIO = 1.32;
  const NOTE_PADDING_RATIO = 0.35; // box padding as a fraction of the font size
  const NOTE_APPEARANCE_TEXT_ONLY = 'text-only';
  const NOTE_APPEARANCE_BOX = 'box';
  const NOTE_WIDTH_MODE_CONTENT = 'content';
  const NOTE_WIDTH_MODE_FIXED = 'fixed';

  // US-109/120/121 Auto Detect Seam runtime state — session-only: generated
  // Board annotations persist through the ordinary project/history path,
  // while a detector's transient running/result/review UI does not belong in
  // project JSON. Function declarations (hoisted) so `state` below and
  // project-load.js's reset build the identical shape from ONE definition.
  function autoSeamReviewInitialState() {
    // US-121 TD Review overlay. `corrections` is keyed by Automatic ROI id:
    // { verdict: 'correct'|'wrong', reasonCode, correctedPolygon } — TD truth,
    // exported to a downloadable file, never fed back into the detector.
    return { active: false, runId: null, selectedRoiId: null, editingRoiId: null, corrections: {} };
  }

  function autoSeamInitialState() {
    return {
      running: false,
      lastRun: null,
      // US-120: { engine: 'worker' | 'main-thread', reason, elapsedMs } of the
      // most recent analysis — which engine ran and, if not the worker, why.
      lastExecution: null,
      review: autoSeamReviewInitialState(),
    };
  }

  const state = {
    tool: 'select',
    drawStyle: 'solid',
    drawColor: 'red',
    arrowType: 'double',
    lineWidth: DEFAULT_LINE_WIDTH,
    // The size a newly-placed note (or the next chip edit with none selected)
    // uses — the note's own equivalent of lineWidth. Persisted with the
    // project + history exactly like lineWidth/drawColor.
    noteFontSize: NOTE_DEFAULT_FONT_SIZE,
    // US-100: sticky defaults for the next Board note. These are separate from
    // drawColor because line ink and note text/leader colour are independent.
    noteAppearance: NOTE_APPEARANCE_TEXT_ONLY,
    noteTextColor: 'black',
    noteLeaderColor: 'red',
    annotations: [],
    // ADR 0071: small perpendicular tick marks placed near a line (garment-
    // pattern alignment notches). Plain WORLD coordinates, like graphics/
    // notes below — not normalized to an owning image, since a piece can sit
    // in blank Scratch Area space with nothing to normalize against. Carries
    // no POM identity; never a measurement (see isMeasurementAnnotation).
    notches: [],
    // ADR 0070: templateGroupId -> human label (a DXF INSERT's block name,
    // e.g. "CUP_36C"), for the Pattern Pieces panel only. Sparse — only DXF
    // import writes an entry, and only when the source block had a name; a
    // group with no entry falls back to a positional label. Not view state
    // like templateGroupEditId above: it describes the sketch itself, so it
    // is persisted with the project (see buildProjectSnapshot/loadProject).
    templateGroupLabels: {},
    // Phase 3 of US-124 (ADR 0091): templateGroupId -> what the DXF said
    // about the piece — the ASTM annotation (PIECE NAME / SIZE / QUANTITY),
    // the classification (kind, boundary layer, class counts, notch chains)
    // and what dedupe dropped. Display/provenance for the Pattern Pieces
    // panel; never read by grouping or measurement. Sparse like
    // templateGroupLabels and persisted the same way.
    templateGroupMeta: {},
    // Phase 3: import-time options for the next DXF import. keepQualityCurves
    // places ASTM 84/85/86/87 quality-validation twins instead of dropping
    // them; the value used for an import travels with its dxfPatternSource.
    dxfImportOptions: { keepQualityCurves: false },
    // US-095: visual vector construction shapes. Deliberately separate from
    // annotations, which are the measurement/POM collection.
    graphics: [],
    deletedAutoAnnotations: [],
    // US-047: POM labels whose drawn line the TD deleted. Excluded from the
    // exported spec exactly like a hidden line (TD: "delete = hide"), until a
    // line with that label is redrawn. Persisted with the project + history.
    deletedPomKeys: [],
    images: [],
    eraseStrokes: [],
    // US-092: free text the TD places on the Board — a factory remark, a
    // reminder, a label on a detail — with 0+ leader arrows pointing at the
    // spot it refers to. Deliberately its OWN collection, never part of
    // state.annotations: annotations are the measurement set (the spec panel,
    // the tolerance check, grading, the Excel table and deletedPomKeys all
    // derive from them by label), so a note living there would become a POM
    // row. Persisted with the project and captured in history.
    notes: [],
    brushSize: 24,
    showLabels: true,
    nextSequence: 1,
    selection: { kind: null, id: null },
    // Session-only focused path-edit state for one selected Board Graphic.
    graphicEdit: null,
    // US-097 / ADR 0056: which saved shape the stamp tool will place. Session
    // only — like state.tool itself, an armed tool is a view concern, not
    // project data, so it is absent from makeSnapshot and never round-trips
    // through undo or a saved project.
    activeStampId: null,
    // US-106: place the armed Template mirrored left-right (a saved left
    // wing placed as the right one). Session-only, same reasoning as
    // activeStampId; always reset to false when a stamp is (re-)armed — see
    // setActiveShapeStamp.
    activeStampMirrored: false,
    // US-098: null means a placed Template selects as one group. Double-click
    // sets this to a templateGroupId so its member paths can be edited one at a
    // time. Session-only; the grouping itself lives on annotations.
    templateGroupEditId: null,
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
    // US-099: pointer-assistance state is intentionally session-only. The
    // geometry produced by a snapped drag enters ordinary history/project data;
    // hover, guides and the current preference never do.
    smartAlignEnabled: true,
    smartAlignGuides: [],
    hoverAnnotationId: null,
    // POM Focus / Sketch Focus (US-102): session-only, like smartAlignEnabled
    // above — a display/tool-visibility toggle within Manual Mode, never
    // saved to the project. `false` here is simply the fresh-load default; it
    // is also explicitly reset to false by the `Sketch` toolbar toggle
    // itself, by switching to Auto Mode, and by Open Project / autosave
    // Restore, all three through src/manual/sketch-mode.js's
    // applySketchModeVisual — the one function those three sites share.
    sketchMode: false,
    // US-109 Auto Detect Seam runtime state. Session-only: generated Board
    // annotations persist through the ordinary project/history path, while a
    // detector's transient running/result UI does not belong in project JSON.
    // Built by autoSeamInitialState() below — the ONE definition of this
    // shape. project-load.js resets it through the same factory; a literal
    // copy there once dropped `review` and broke Review ROI after Open
    // (US-121 recheck, 2026-09-03).
    autoSeam: autoSeamInitialState(),
    // US-103: the POM-side pending arrow preference (state.arrowType), saved
    // by applySketchModeVisual the moment Sketch Focus turns on and restored
    // the moment it turns off. Session-only, like sketchMode itself — never
    // read by makeSnapshot/buildProjectSnapshot, so it cannot leak into the
    // project file or undo history.
    pomArrowType: null,

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
    // US-092: the Board note editor's live session, or null when it is closed.
    // `id` is set when re-opening an existing note; `pos` (plus the styling the
    // note will be born with) when the Text tool is placing a new one. Exactly
    // one of the two is ever non-null. Session state only — deliberately absent
    // from makeSnapshot, so an editor left open at save time cannot travel into
    // the project file or into a history entry.
    noteEditor: null,

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

    // US-105 / ADR 0062: DXF Pattern Measure — native-coordinate source
    // model (pieces of native line/arc segments, unit/unitSource), the
    // board<->native placement mapping, and the TD's temporary A/B
    // measurements for the currently-imported DXF. Session-only by design:
    // absent from makeSnapshot/restoreSnapshot and buildProjectSnapshot.
    // ADR 0088 persists only the separate dxfPatternSource and uses it to
    // rebuild a NEW empty session on load. Because the GLOBAL undo stack
    // restores a snapshot that never contains this field, it structurally
    // cannot undo a measurement edit; measurements use their OWN small
    // fingerprint-diff undo stack instead (see
    // src/manual/dxf-measure-session.js). null until a DXF import creates
    // one; cleared to null on another DXF import or a mode/board reset (see
    // the call sites listed in that file).
    dxfMeasureSession: null,
    // ADR 0088: durable source for the NEWEST successfully imported DXF.
    // Unlike dxfMeasureSession, this is serialized into Project JSON (full
    // text) and autosave (IndexedDB fingerprint reference) so reopening can
    // build a fresh empty measurement session. It is deliberately excluded
    // from global history; Remove/Simplify invalidate it fail-closed.
    dxfPatternSource: null,
    // US-112: Pattern Measure snap preferences. A TD-level tool preference,
    // like smartAlignEnabled above — session-only, never saved/restored,
    // and deliberately OUTSIDE state.dxfMeasureSession so opening a new DXF
    // (which resets that session) does not reset what the TD just set here.
    dxfMeasureSnapEndpoint: true,
    dxfMeasureSnapMidpoint: true,
    dxfMeasureSnapIntersection: false,
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
