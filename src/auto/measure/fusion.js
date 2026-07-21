// Mode B measurement: library × sketch fusion (ADR 0033), ported to production
// from the validated lab engine (test/engine.js) via US-039 Stage 1.
//
// Pure + side-effect-free: this part only DEFINES functions and one flag const.
// It is FLAGGED OFF by default — getPomSpec only consults it when Mode B is on
// (compile-time MODE_B_DEFAULT or the ?modeB=1 URL pin) — so with the flag off
// production behaviour is bit-identical to Tier-0 (docs/decisions/0009).
//
// The value for each sketch-reliable POM is a precision-weighted SHRINKAGE of
// the sketch measurement (detected anchor pixel distance × a view-local scale)
// toward the library median — never a blind average, and never assigned: it is a
// suggestion the TD accepts or overrides (ADR 0009), and a conflicted POM falls
// back to the library value rather than showing a wrong number.

// Off by default. Turn on for a build by flipping this, or per-session with
// ?modeB=1 (mirrors the ?freeCv=1 / ?label=1 harness pins).
const MODE_B_DEFAULT = false;

function modeBEnabled() {
  if (MODE_B_DEFAULT) return true;
  try {
    if (typeof window !== 'undefined' && window.location) {
      return new URLSearchParams(window.location.search || '').get('modeB') === '1';
    }
  } catch (_e) { /* non-browser / restricted context */ }
  return false;
}

// Per-POM roll-out set (US-041). Empty by default — with the global flag off and
// this list empty, Mode B is fully inert. A POM id is added here ONLY after
// `npm run measurement-accuracy --promote` shows its fused value beats
// library-only on TD-confirmed ground truth; editing this list is the reviewed
// promotion step (mirrors golden/accuracy --update). Governance, not learning:
// it never mutates the versioned contract JSON.
const MODE_B_ENABLED_POMS = [];

// Mode B is live for a POM when the global flag is on OR the POM is promoted.
function modeBEnabledForPom(pom) {
  if (modeBEnabled()) return true;
  return MODE_B_ENABLED_POMS.indexOf(String(pom == null ? '' : pom).trim()) !== -1;
}
// True when ANY Mode B path is live (global flag or a promoted POM) — used to
// skip the whole measured-suggestion computation when nothing is enabled.
function modeBAnyEnabled() {
  return modeBEnabled() || MODE_B_ENABLED_POMS.length > 0;
}

// POM -> [startAnchor, endAnchor], from auto_mode_rules/pom-template.json
// requiredAnchors. Only the corpus sketchReliable POMs (5-13) are fusable; POM
// 1-4 are schematic, 14 is front-to-back (unmeasurable from 2D views, ADR 0026),
// 15/16/17/18 have no corpus median.
const MODE_B_POM_ANCHORS = {
  '5': ['cf-top', 'cf-bottom'],
  '6': ['cradle-cf-top', 'cf-bottom'],
  '7': ['cradle-cup-top', 'cradle-cup-bottom'],
  '8': ['cf-top', 'cradle-cf-top'],
  '9': ['inner-cup-top', 'inner-cup-bottom'],
  '10': ['inner-cup-left', 'inner-cup-right'],
  '11': ['side-top', 'side-bottom'],
  '12': ['back-top', 'back-bottom'],
  '13': ['back-top', 'back-bottom'],
};
const MODE_B_POM_VIEW = {
  '5': 'front_outer', '6': 'front_outer', '7': 'front_outer', '8': 'front_outer',
  '9': 'front_outer', '10': 'front_outer', '11': 'back', '12': 'back', '13': 'back',
};

function mbClamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function mbRound(v, p) { const m = Math.pow(10, p == null ? 3 : p); return Math.round(v * m) / m; }
function mbMedian(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return 0;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Coherent, view-wide style offset (kept, not shrunk): robust median of
// (sketch/median - 1). MAD is the in-distribution / scale-trust signal.
function mbStyleOffset(pairs) {
  const ratios = (pairs || []).filter(p => p && p.median > 0 && p.sketch > 0).map(p => p.sketch / p.median - 1);
  if (ratios.length < 2) return { offset: 0, dispersion: null, n: ratios.length };
  const offset = mbMedian(ratios);
  const dispersion = mbMedian(ratios.map(r => Math.abs(r - offset)));
  return { offset: mbRound(mbClamp(offset, -0.25, 0.25), 4), dispersion: mbRound(dispersion, 4), n: ratios.length };
}

// Precision-weighted shrinkage toward the style-adjusted median.
//   styleExpected = median · (1 + styleOffset)
//   fused         = styleExpected + k · (sketch − styleExpected),  k = σL²/(σL²+σs²)
function mbFuseValue(args) {
  const sketch = Number(args.sketch), median = Number(args.median);
  const styleOffset = Number(args.styleOffset) || 0;
  const sL = Math.max(1e-6, Number(args.priorSpreadFrac) || 0.08);
  const sS = Math.max(1e-6, Number(args.sketchSigmaFrac) || 0.08);
  const k = (sL * sL) / (sL * sL + sS * sS);
  const styleExpected = median * (1 + styleOffset);
  const fused = styleExpected + k * (sketch - styleExpected);
  const residual = median > 0 ? (sketch / median - 1 - styleOffset) : 0;
  return { fused: mbRound(fused, 3), k: mbRound(k, 3), residual: mbRound(residual, 4) };
}

function mbDiagnose(residual, dispersion) {
  const r = Math.abs(Number(residual) || 0);
  const d = Number(dispersion);
  if (Number.isFinite(d) && d > 0.12) return 'scale_suspect';
  if (r > 0.15) return 'anchor_outlier';
  return 'coherent';
}

// Sketch noise fraction: lower (more trust) for ink-confirmed anchors and
// independent (TD/construction) scale; higher for short POMs and inferred scale.
function mbSketchSigmaFrac(scaleIndependent, anchorConfirmed, shortPom) {
  return (scaleIndependent ? 0.03 : 0.08) * (anchorConfirmed ? 1.0 : 1.8) * (shortPom ? 1.5 : 1.0);
}

// Build { pom: { value_in, sketch_in, library_in, k, residual, diagnosis,
// confidence, decision, scaleSource } } from detected anchors + library medians.
// anchors: array of { kind, x, y (normalized 0..1), viewRole, confidence, source, reviewRequired }
// suggestions: POM_SUGGESTIONS ({ median, sketchReliable } per POM id)
// dims: { width, height } source-image px (aspect matters for pixel-length ratios)
function mbComputeMeasuredSuggestions(anchors, suggestions, dims) {
  const out = {};
  if (!Array.isArray(anchors) || !anchors.length || !suggestions) return out;
  const W = Number(dims && dims.width) || 1;
  const H = Number(dims && dims.height) || 1;
  const byKind = {};
  for (const a of anchors) if (a && a.kind) byKind[a.kind] = a;

  const rank = { high: 3, medium: 2, low: 1, very_low: 0 };
  const inkSourced = s => /ink|silhouette|opencv/i.test(String(s || ''));

  // Per-POM sketch geometry (source-px pixel distance) + library median.
  const rows = {};
  for (const pom of Object.keys(MODE_B_POM_ANCHORS)) {
    const sug = suggestions[pom];
    if (!sug || !(Number(sug.median) > 0) || sug.sketchReliable === false) continue;
    const [kA, kB] = MODE_B_POM_ANCHORS[pom];
    const a = byKind[kA], b = byKind[kB];
    if (!a || !b || !Number.isFinite(Number(a.x)) || !Number.isFinite(Number(b.x))) continue;
    const dx = (Number(a.x) - Number(b.x)) * W, dy = (Number(a.y) - Number(b.y)) * H;
    const px = Math.hypot(dx, dy);
    if (!(px > 0)) continue;
    const confirmed = !a.reviewRequired && !b.reviewRequired && inkSourced(a.source) && inkSourced(b.source);
    const conf = rank[a.confidence] <= rank[b.confidence] ? (a.confidence || 'low') : (b.confidence || 'low');
    rows[pom] = { pom, view: MODE_B_POM_VIEW[pom], px, median: Number(sug.median), confirmed, confidence: conf };
  }

  // One robust view-local scale from all that view's sketch-reliable POMs
  // (candidate scale = median/px). Dispersion = trust; front never shares back.
  const views = {};
  for (const pom of Object.keys(rows)) {
    const r = rows[pom];
    (views[r.view] = views[r.view] || []).push(r);
  }
  for (const view of Object.keys(views)) {
    const vr = views[view];
    const candidates = vr.map(r => r.median / r.px);
    if (candidates.length < 2) continue;                 // need >=2 POMs to fit a scale
    const scale = mbMedian(candidates);
    const styleOffset = mbStyleOffset(vr.map(r => ({ sketch: r.px * scale, median: r.median })));
    for (const r of vr) {
      const sketch = r.px * scale;
      const spreadFrac = 0.06;                            // corpus between-style spread (provisional; tuned by the accuracy gate)
      const sigmaFrac = mbSketchSigmaFrac(false, r.confirmed, r.pom === '7' || r.pom === '8');
      const f = mbFuseValue({ sketch, median: r.median, priorSpreadFrac: spreadFrac, sketchSigmaFrac: sigmaFrac, styleOffset: styleOffset.offset });
      const diagnosis = mbDiagnose(f.residual, styleOffset.dispersion);
      out[r.pom] = {
        value_in: f.fused, sketch_in: mbRound(sketch, 3), library_in: r.median,
        k: f.k, residual: f.residual, styleOffset: styleOffset.offset, dispersion: styleOffset.dispersion,
        diagnosis, confidence: diagnosis === 'coherent' ? (r.confidence === 'high' ? 'medium' : 'low') : 'low',
        decision: diagnosis === 'coherent' ? 'ESTIMATED_SUGGESTION' : 'REVIEW_REQUIRED',
        scaleSource: 'library_multi_anchor_inference',
      };
    }
  }
  return out;
}
