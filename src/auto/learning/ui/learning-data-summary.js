// Transparent Learning panel: always-visible top summary strip above the
// tabs.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Top summary ----------------------------------------------------
  // Five focused fields TDs use to gauge style readiness at a glance.
  // confirmedLinePomCount counts POMs with at least one confirmed line
  // (not raw record count) so the same POM saved over many sessions
  // doesn't inflate the headline.
  function buildLearningTopSummary(learning, meanings, evidence) {
    const section = document.createElement('div');
    section.className = 'ld-section ld-top-summary';

    const styleLabel = meanings
      ? (meanings.currentStyleIsDefault
          ? 'Default (no style code)'
          : meanings.currentStyleId)
      : '—';

    let confirmedLinePomCount = 0;
    let absentPomCount = 0;
    let needsReviewPomCount = 0;
    if (evidence && Array.isArray(evidence.rows)) {
      for (const row of evidence.rows) {
        if (row.status === 'confirmed') confirmedLinePomCount += 1;
        else if (row.status === 'absent-confirmed') absentPomCount += 1;
        else needsReviewPomCount += 1;
      }
    }

    const lastLearned = pickLatestLearningTimestamp(learning, evidence);

    const items = [
      {
        label: 'Current style',
        value: styleLabel,
        tone: meanings && meanings.currentStyleIsDefault ? 'muted' : null,
      },
      {
        label: 'Confirmed lines',
        value: String(confirmedLinePomCount) + ' POM' + (confirmedLinePomCount === 1 ? '' : 's'),
        tone: confirmedLinePomCount > 0 ? 'ok' : 'muted',
      },
      {
        label: 'Absent POMs',
        value: absentPomCount > 0 ? String(absentPomCount) : '0',
        tone: absentPomCount > 0 ? 'warn' : 'muted',
      },
      {
        label: 'Needs review',
        value: needsReviewPomCount > 0 ? String(needsReviewPomCount) : '0',
        tone: needsReviewPomCount > 0 ? 'attention' : 'muted',
      },
      {
        label: 'Last learned',
        value: lastLearned ? formatEvidenceTimestamp(lastLearned, true) : '—',
        tone: lastLearned ? null : 'muted',
      },
    ];

    const grid = document.createElement('div');
    grid.className = 'ld-summary-grid ld-summary-grid-top';
    for (const it of items) grid.appendChild(buildSummaryCard(it));
    section.appendChild(grid);
    return section;
  }

  function pickLatestLearningTimestamp(learning, evidence) {
    let best = 0;
    if (evidence && evidence.lastUpdated) {
      const t = Date.parse(evidence.lastUpdated);
      if (Number.isFinite(t) && t > best) best = t;
    }
    if (learning && Array.isArray(learning.rows)) {
      for (const row of learning.rows) {
        const t = Number(row.lastTs) || 0;
        if (t > best) best = t;
      }
    }
    return best > 0 ? new Date(best).toISOString() : null;
  }
