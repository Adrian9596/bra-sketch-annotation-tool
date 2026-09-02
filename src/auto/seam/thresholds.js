// US-109 Auto Seam — every number a lane DECIDES with, named and placed next
// to the corpus measurement that set it. TBC — TD calibrated: a calibration
// pass edits THIS file only. Feature DEFINITIONS are deliberately not here —
// the corridor's search radius, penalty weights, diagonal-ratio cut and
// evidence weights (corridor.js), and the pixel model's background/mask/box
// parameters (pixel-model.js) define what a feature means; changing them
// changes the feature, not the decision. Read only inside functions (never at
// load time), so part order does not matter for this `const`.
// Source part for app.js.
const AUTO_SEAM_THRESHOLDS = {
  classifier: {
    // A technical flat is sparse high-contrast ink on a white field.
    sparseInk: { nearWhiteMin: 0.72, lumaEntropyMax: 2.2, strongEdgeMin: 0.025, darkInkMin: 0.018, darkInkMax: 0.22 },
    // measured 2026-09-02: dominant 5-bit foreground colour share 0.525 on the
    // colour-filled flat image2.png vs <= 0.116 on all six product photos and
    // <= 0.08 on line flats; crisp-edge density 0.076 vs <= 0.035 on photos.
    flatFill: { nearWhiteMin: 0.30, dominantColourMin: 0.35, strongEdgeMin: 0.05 },
    productPhoto: { foregroundMin: 0.055, foregroundMax: 0.78 },
  },
  technicalFlat: {
    // Phase 1 non-zigzag appearance gates. All measurements are taken along a
    // source-supported path inside one Semantic ROI. These are intentionally
    // conservative until the TD-labelled technical-flat corpus is large
    // enough to calibrate release precision/recall.
    pattern: {
      inkCutBelowBackground: 55,
      normalRadius: 0.022,
      minimumRadius: 8,
      pathSupport: 0.40,
      continuity: 0.55,
      solid: { occupancy: 0.88 },
      dashed: {
        occupancyMin: 0.22,
        occupancyMax: 0.78,
        runCount: 4,
        medianRunMin: 2,
        medianGapMin: 1,
        periodicity: 0.40,
      },
      // A 3 px source stroke plus the 1 px anti-alias neighbourhood can expose
      // two dark edge sequences 4–5 px apart; require 7 px so one line cannot
      // masquerade as a pair.
      parallel: { spacingMin: 7, spacingMax: 18, alignmentMin: 0.42 },
    },
    // Contour-derived seeds (neckline from the top ink profile, underbust from
    // the bottom one). Proportions of the garment box.
    contour: {
      strapCeiling: 0.10,     // topmost ink above this is strap/shoulder, not neckline
      hemFloor: 0.12,         // bottom-most ink below this is the hem
      // measured: bindings 17–24 px inside the outline on 3 real flats = 1.8–2.5% of box height
      bindingInset: 0.025,
      innerStart: 0.12,       // neckline walk starts this far from the axis (skips center decorations)
      minSpan: 0.12,          // a side shorter than this is not a neckline/hem
      // Keep the top-contour trace off steep strap edges; when a neckline is
      // visibly occluded by that edge, walk the lower overlap outline separately
      // so display geometry includes the steep binding flank without treating it
      // as reliable triangle-wave evidence.
      junctionSlopeMax: 3.0,
      junctionInset: 0.02,    // start this far inside the detected strap junction
      overlapJunctionX: 0.19,
      overlapJunctionY: 0.35,
      overlapMinXGap: 0.10,
      overlapTraceRise: 0.004,
      overlapTraceFall: 0.018,
      hemStartInBox: 0.05,    // template hem start (x), nudged inward until the column reads as hem
      hemOuterMargin: 0.03,
    },
    // Edge band: the strip just inside a garment edge, per image column.
    edgeBand: {
      lo: 0.005,                    // skip the outline stroke
      hi: 0.055,                    // real bindings 1.8–2.5%; synthetic drawn at 2.7%; deeper changes nothing where a nearer structure exists
      inkCutBelowBackground: 55,    // crisp ink = luma <= bgLuma - 55 (anti-aliasing must not widen strokes)
      steepSlope: 1.2,              // column scanning unreliable past ~50° (photo4 junction flank: 68-column run of bandTop=lo)
      evaluateFrom: 0.20, evaluateTo: 0.95,  // stats over the middle of each side, away from junction and center front
      flatRunMin: 4,                // a zero-step run at least this long is an arc top or a straight line, never a zigzag apex
      smoothStepMax: 3,             // |step| <= 3 px counts as a smooth step
      maxFlatRunNormalizer: 64,     // contourBindingMaxFlatRun = min(1, run / 64) so it stays in [0,1] for the validator
      geometryWindow: 7,            // moving median half-window on the envelope
      geometryHalfStroke: 1.5,      // envelope (first ink) + half a stroke = centerline
      // measured 2026-09-02, per side: zigzag (photo4/image5 necklines) flips .27/.23,
      // flatRun>=4 share .00, longest run 2–3, smooth .71–.79; scallop (image5 hem)
      // flips .25–.31 but flatRun share .10–.17 and longest run 9–10; plain (image3
      // neckline) flips .94/.95; single-line hems ink share .39–.46.
      gate: { evaluableMin: 0.40, inkMin: 0.80, flipMax: 0.45, flatRunShareMax: 0.06, maxFlatRunMax: 6, smoothMin: 0.50 },
    },
    gates: {
      // Edge-seeded zones: the band decides; these are sanity floors. Balance alone
      // rejects a plain outline (0.22–0.35, e.g. image2's filled armholes).
      edgeSeeded: { pathSupport: 0.45, continuity: 0.60, diagonalEnergy: 0.18, balance: 0.55 },
      // Template-seeded fallback when the top contour could not be read.
      templateNeckline: { pathSupport: 0.60, continuity: 0.80, diagonalEnergy: 0.20, diagonalAlternation: 0.42, balance: 0.55 },
      // measured: center-straddling armhole bindings 0.87–0.97 balance (image5,
      // synthetic), while plain image3 outlines stay at 0.29–0.35. The true
      // photo4 bindings are one-sided and are handled by armholeEdge below.
      armhole: { pathSupport: 0.45, continuity: 0.80, diagonalEnergy: 0.18, diagonalAlternation: 0.45, balance: 0.70 },
      // Edge-only armhole bindings are one-sided, so balance is intentionally
      // weak here. photo4's true zigzags have lateral activity .464/.557,
      // diagonal energy .316/.356 and two-sided coverage .041/.041; image3's
      // plain armholes stay at activity .309/.320 and energy .194/.261, while
      // image2's filled outlines have two-sided coverage .959/1.0.
      armholeEdge: { pathSupport: 0.45, continuity: 0.80, diagonalEnergy: 0.30, diagonalAlternation: 0.45, balance: 0.28, lateralActivity: 0.45, twoSidedMax: 0.10 },
      // measured: true straps 0.485/0.546 pathSupport vs a plain-line false positive at 0.557 —
      // corridorTwoSidedCoverage separates them (straps < 0.10, false positive 0.35).
      templateDefault: { pathSupport: 0.45, continuity: 0.80, diagonalEnergy: 0.18, diagonalAlternation: 0.58, balance: 0.55, twoSidedMax: 0.15 },
    },
  },
  productPhoto: {
    // Adaptive proposal gate, not a release/accuracy threshold.
    adaptive: { overallMin: 0.40, continuityMin: 0.48, diagonalEnergyMin: 0.24, diagonalAlternationMin: 0.34 },
    zone: {
      underbust_band: { diagonalShare: 0.50, balance: 0.55, twoSided: 0.75, diagonalAlternation: 0.45, overall: 0.65 },
      // Armhole stitches in the approved pilot are blurred by binding texture: dense
      // bilateral coverage with strongly balanced diagonal directions, weaker raw share.
      armhole: { diagonalShare: 0.28, balance: 0.85, twoSided: 0.85, diagonalAlternation: 0.40, overall: 0.55 },
      // The TD-confirmed neckline binding is visibly blurred: balanced, continuous
      // corridor evidence but LOW pointwise diagonal energy; crisp decorative motifs
      // in the negative photos score much higher energy and are excluded by the cap.
      neckline: { overall: 0.50, continuity: 0.60, diagonalEnergyMin: 0.08, diagonalEnergyMax: 0.22, diagonalAlternation: 0.48, diagonalShare: 0.40, balance: 0.55 },
    },
    // Underbust is judged as one bilateral construction row.
    pair: { underbust_band: { diagonalShare: 0.55, balance: 0.55, twoSided: 0.80, overallAverage: 0.70 } },
    underbustCenterClearance: 0.035,  // of box width, either side of the center closure
  },
};
