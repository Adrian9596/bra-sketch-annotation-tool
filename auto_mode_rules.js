// Versioned Point-of-Measure and Auto Mode rule data.
//
// Keep this file data-only so TD-reviewed rules can change without editing
// the main annotation app logic in index.html.
(function () {
  'use strict';

  const POM_UNIT = 'in';

  // Built-in Point-of-Measure template (bra measurement standard, base size L, inches).
  // refL = standard size-L reference value (per-style confidential). Null in this public
  // build; restore real values in a private copy for production use.
  const POM_TEMPLATE = {
    '1':  { desc: '1/2 Bottom band - Relax', refL: null, viewRole: 'front_outer' },
    '2':  { desc: '1/2 Bottom band - Extend', refL: null, viewRole: 'front_outer' },
    '3':  { desc: '1/2 chest - Measure straight', refL: null, viewRole: 'front_outer' },
    '4':  { desc: '1/2 chest - Extend', refL: null, viewRole: 'front_outer' },
    '5':  { desc: 'Center front height', refL: null, viewRole: 'front_outer' },
    '6':  { desc: 'Cradle height at center front', refL: null, viewRole: 'front_outer' },
    '7':  { desc: 'Cradle height at bottom cup', refL: null, viewRole: 'front_outer' },
    '8':  { desc: 'Cup height at center front', refL: null, viewRole: 'front_outer' },
    '9':  { desc: 'Inner cup height', refL: null, viewRole: 'front_inner' },
    '10': { desc: 'Inner cup width', refL: null, viewRole: 'front_inner' },
    '11': { desc: 'Side seam length', refL: null, viewRole: 'back' },
    '12': { desc: 'Back center length', refL: null, viewRole: 'back' },
    '13': { desc: 'Back panel height', refL: null, viewRole: 'back' },
    '14': { desc: 'Shoulder strap length', refL: null, viewRole: 'front_outer' },
    '15': { desc: 'Back strap distances', refL: null, viewRole: 'back' },
    '16': { desc: 'Front apex distance', refL: null, viewRole: 'front_outer' },
  };

  // Spec-panel pairing: POMs that share a physical measurement on the sketch
  // (relax vs. extend) render as one row with two value inputs. The underlying
  // data model remains one annotation per POM.
  const POM_PAIR_PRIMARIES = {
    '1': { partner: '2', desc: '1/2 Bottom band', primaryLabel: 'Relax', secondaryLabel: 'Extend' },
    '3': { partner: '4', desc: '1/2 Chest',       primaryLabel: 'Measure straight', secondaryLabel: 'Extend' },
  };

  // Draggable named points the TD can correct after Detect Sketch seeds them.
  // The POM generator reads anchors by `kind`, so every kind corresponds to a
  // real geometric role used by one or more POMs.
  //
  // x, y are stored normalized [0, 1] relative to the source image's native
  // pixel space so anchors survive image moves, resizes, zooms, and save/reopen.
  const ANCHOR_SCHEMA = [
    // Center axis
    { kind: 'cf-top',          name: 'CF top',     group: 'axis',      hint: 'Top of the center-front, where the cradle meets the chest line.' },
    { kind: 'cf-bottom',       name: 'CF bottom',  group: 'axis',      hint: 'Bottom of the center front, on the underbust band.' },
    // Bottom band (POM 1, 2)
    { kind: 'band-left',       name: 'Band L',     group: 'band',      hint: 'Leftmost end of the underbust band line.' },
    { kind: 'band-right',      name: 'Band R',     group: 'band',      hint: 'Rightmost end of the underbust band line.' },
    // Chest line (POM 3, 4)
    { kind: 'chest-left',      name: 'Chest L',    group: 'chest',     hint: 'Left end of the chest / overbust horizontal line.' },
    { kind: 'chest-right',     name: 'Chest R',    group: 'chest',     hint: 'Right end of the chest / overbust horizontal line.' },
    // Inner cup (POM 9, 10)
    { kind: 'inner-cup-top',   name: 'IC top',     group: 'inner-cup', hint: 'Top of the inner cup curve (POM 9 start).' },
    { kind: 'inner-cup-bottom',name: 'IC btm',     group: 'inner-cup', hint: 'Bottom of the inner cup curve (POM 9 end).' },
    { kind: 'inner-cup-left',  name: 'IC L',       group: 'inner-cup', hint: 'Inner-cup-width left end (POM 10 start).' },
    { kind: 'inner-cup-right', name: 'IC R',       group: 'inner-cup', hint: 'Inner-cup-width right end (POM 10 end).' },
    // Side seam (POM 11)
    { kind: 'side-top',        name: 'Side top',   group: 'side',      hint: 'Top of the side seam at the underarm.' },
    { kind: 'side-bottom',     name: 'Side btm',   group: 'side',      hint: 'Bottom of the side seam at the band.' },
    // Front apex (POM 16)
    { kind: 'apex-left',       name: 'Apex L',     group: 'apex',      hint: 'Left front apex.' },
    { kind: 'apex-right',      name: 'Apex R',     group: 'apex',      hint: 'Right front apex.' },
    // Strap (POM 14)
    { kind: 'strap-top',       name: 'Strap top',  group: 'strap',     hint: 'Where the shoulder strap meets the shoulder.' },
    { kind: 'strap-bottom',    name: 'Strap btm',  group: 'strap',     hint: 'Where the shoulder strap meets the cup top.' },
    // Back panel (POM 12, 13, 15)
    { kind: 'back-top',        name: 'Back top',   group: 'back',      hint: 'Top edge of the back panel.' },
    { kind: 'back-bottom',     name: 'Back btm',   group: 'back',      hint: 'Bottom edge of the back panel.' },
    { kind: 'back-panel-top',  name: 'Panel top',  group: 'back',      hint: 'Upper point for back panel height.' },
    { kind: 'back-panel-bottom',name: 'Panel btm',  group: 'back',      hint: 'Lower point for back panel height.' },
    { kind: 'back-strap-left',  name: 'Back strap L',group: 'back',     hint: 'Left point of the back strap distance.' },
    { kind: 'back-strap-right', name: 'Back strap R',group: 'back',     hint: 'Right point of the back strap distance.' },
  ];

  window.BraMeasurementRules = Object.freeze({
    POM_UNIT,
    POM_TEMPLATE,
    POM_PAIR_PRIMARIES,
    ANCHOR_SCHEMA,
    AUTO_TEMPLATE_VERSION: 'fixed16-2026-06-18',
    AUTO_RULE_VERSION: 'offline-vision-rules-v2',
  });
})();
