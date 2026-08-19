// Transparent Learning panel: Telemetry tab — reaches into
// getAutoTelemetryReport/getAutoTelemetryLog from src/auto/telemetry/*
// rather than the learning/meaning/evidence stores the other tabs use.
// Source part for app.js. Run `npm run build` after editing.

  // ---- Telemetry ------------------------------------------------------
  function buildLearningTelemetrySection(telemetry) {
    const section = document.createElement('div');
    section.className = 'ld-section';

    if (!telemetry || telemetry.count === 0) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'No completed Auto Mode telemetry sessions yet. Run Detect, generate drafts, and apply or discard them to record one.';
      section.appendChild(empty);
      return section;
    }

    const intro = document.createElement('p');
    intro.className = 'ld-section-note';
    intro.textContent = 'Last ' + telemetry.count + ' completed Auto Mode session'
      + (telemetry.count === 1 ? '' : 's')
      + '. Medians show the current speed baseline for Detect-to-POM work.';
    section.appendChild(intro);

    const summaryGrid = document.createElement('div');
    summaryGrid.className = 'ld-summary-grid';
    summaryGrid.appendChild(buildSummaryCard({
      label: 'Median detect',
      value: formatTelemetryDuration(telemetry.medians.detect_ms),
      tone: telemetry.medians.detect_ms == null ? 'muted' : null,
    }));
    summaryGrid.appendChild(buildSummaryCard({
      label: 'Median edit',
      value: formatTelemetryDuration(telemetry.medians.edit_ms),
      tone: telemetry.medians.edit_ms == null ? 'muted' : null,
    }));
    summaryGrid.appendChild(buildSummaryCard({
      label: 'Median apply',
      value: formatTelemetryDuration(telemetry.medians.apply_ms),
      tone: telemetry.medians.apply_ms == null ? 'muted' : null,
    }));
    summaryGrid.appendChild(buildSummaryCard({
      label: 'Median anchors dragged',
      value: formatTelemetryNumber(telemetry.medians.anchors_dragged),
      tone: telemetry.medians.anchors_dragged === 0 ? 'ok' : null,
    }));
    summaryGrid.appendChild(buildSummaryCard({
      label: 'Touchless sessions',
      value: telemetry.touchlessCount + '/' + telemetry.count,
      tone: telemetry.touchlessCount > 0 ? 'ok' : 'muted',
    }));
    section.appendChild(summaryGrid);

    const exportRow = document.createElement('div');
    exportRow.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'picker-btn';
    exportBtn.textContent = 'Export telemetry JSON';
    exportBtn.addEventListener('click', () => exportAutoTelemetryJson());
    exportRow.appendChild(spacer);
    exportRow.appendChild(exportBtn);
    section.appendChild(exportRow);

    const table = document.createElement('table');
    table.className = 'ld-table';
    table.innerHTML =
      '<thead><tr>' +
        '<th>Completed</th>' +
        '<th>Sketch</th>' +
        '<th class="ld-num">Detect</th>' +
        '<th class="ld-num">Edit</th>' +
        '<th class="ld-num">Apply</th>' +
        '<th class="ld-num">Anchors dragged</th>' +
        '<th class="ld-num">Drafts edited</th>' +
        '<th>Status</th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    for (const session of telemetry.sessions) {
      const summary = session.summary || {};
      const tr = document.createElement('tr');
      tr.appendChild(td(session.completed_at ? formatEvidenceTimestamp(session.completed_at, true) : '—'));
      tr.appendChild(td(session.sketch_id || '—'));
      tr.appendChild(td(formatTelemetryDuration(summary.detect_ms), 'ld-num'));
      tr.appendChild(td(formatTelemetryDuration(summary.edit_ms), 'ld-num'));
      tr.appendChild(td(formatTelemetryDuration(summary.apply_ms), 'ld-num'));
      tr.appendChild(td(formatTelemetryNumber(summary.anchors_dragged), 'ld-num'));
      tr.appendChild(td(formatTelemetryNumber(summary.drafts_edited), 'ld-num'));
      const statusCell = td('');
      const chip = document.createElement('span');
      chip.className = 'ld-status ' + (summary.touchless ? 'ld-status-active' : 'ld-status-empty');
      chip.textContent = summary.touchless ? 'Touchless' : 'Touched';
      statusCell.appendChild(chip);
      tr.appendChild(statusCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function exportAutoTelemetryJson() {
    const payload = {
      exportedAt: new Date().toISOString(),
      sessions: (typeof getAutoTelemetryLog === 'function') ? getAutoTelemetryLog() : [],
    };
    const blob = new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' });
    downloadBlob(blob, 'auto-telemetry-log.json');
  }
