// Auto Mode acceptance statistics — totalApplied / acceptedWithoutEdit
// counters per POM, persisted via localStorage. Source part for app.js.
// Run `npm run build` after editing.
//
// recordAutoAcceptanceStats is called from applyApprovedDraftsAtomically
// after each apply; the panel header reads loadAutoAcceptanceStats to
// surface the per-POM accepted/edited counts in the Auto review header.

  const AUTO_ACCEPTANCE_KEY = 'bra.autoAcceptance.v1';

  function makeEmptyAcceptanceStats() {
    return {
      totalApplied: 0,
      acceptedWithoutEdit: 0,
      edited: 0,
      byPom: {},
    };
  }

  function loadAutoAcceptanceStats() {
    try {
      const raw = localStorage.getItem(AUTO_ACCEPTANCE_KEY);
      if (!raw) return makeEmptyAcceptanceStats();
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return makeEmptyAcceptanceStats();
      return {
        totalApplied: Number(parsed.totalApplied) || 0,
        acceptedWithoutEdit: Number(parsed.acceptedWithoutEdit) || 0,
        edited: Number(parsed.edited) || 0,
        byPom: parsed.byPom && typeof parsed.byPom === 'object' ? parsed.byPom : {},
      };
    } catch (_) {
      return makeEmptyAcceptanceStats();
    }
  }

  function saveAutoAcceptanceStats(stats) {
    try { localStorage.setItem(AUTO_ACCEPTANCE_KEY, JSON.stringify(stats)); }
    catch (_) { /* quota — stats are helpful, not project-critical */ }
  }

  function getAutoAcceptanceStats() {
    return loadAutoAcceptanceStats();
  }

  function clearAutoAcceptanceStats() {
    try { localStorage.removeItem(AUTO_ACCEPTANCE_KEY); } catch (_) { /* ignore */ }
    updateUI();
  }

  function recordAutoAcceptanceStats(applied) {
    if (!Array.isArray(applied) || !applied.length) return;
    const stats = loadAutoAcceptanceStats();
    for (const ann of applied) {
      const pom = getLabelText(ann);
      const key = String(pom || '?');
      const row = stats.byPom[key] || {
        applied: 0,
        acceptedWithoutEdit: 0,
        edited: 0,
        approximate: 0,
      };
      row.applied += 1;
      stats.totalApplied += 1;
      if (ann.tdEdited) {
        row.edited += 1;
        stats.edited += 1;
      } else {
        row.acceptedWithoutEdit += 1;
        stats.acceptedWithoutEdit += 1;
      }
      if (ann.drawability === 'APPROXIMATE') row.approximate += 1;
      stats.byPom[key] = row;
    }
    saveAutoAcceptanceStats(stats);
  }
