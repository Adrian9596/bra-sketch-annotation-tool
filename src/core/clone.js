// Deep copy of plain JSON-shaped data (state records, project snapshots,
// debug-hook results). JSON round-trip on purpose: it drops functions, DOM
// nodes and undefined fields, which is exactly what a saved project, an undo
// snapshot or a debug payload must not carry. Used by 11 feature groups, so it
// lives in core (ADR 0103 Phase B).
// Source part for app.js. Run `npm run build` after editing.

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }
