// Transparent Learning panel (read-only TD review).
// Reads from summarizeLearningStore + summarizeMeaningStore +
// summarizeStyleEvidence + listStyleEvidence. Renders a top summary plus
// a tabbed body: Style Evidence, Learning Corrections, POM Meanings.
// No mutations — Reset and Manage Meanings live in the Auto Mode Manage
// menu and stay there. Opens regardless of mode so the TD can audit prior
// calibration before switching into Auto Mode.
// Source part for app.js. Run `npm run build` after editing.

  function openLearningDataDialog() {
    const learning = (typeof summarizeLearningStore === 'function') ? summarizeLearningStore() : null;
    const meanings = (typeof summarizeMeaningStore === 'function') ? summarizeMeaningStore() : null;
    const styleId = (typeof currentStyleId === 'function') ? currentStyleId() : null;
    const evidence = (typeof summarizeStyleEvidence === 'function' && styleId != null)
      ? summarizeStyleEvidence(styleId)
      : null;
    const evidenceRecords = (typeof listStyleEvidence === 'function' && styleId != null)
      ? listStyleEvidence(styleId)
      : [];
    const telemetry = (typeof getAutoTelemetryReport === 'function')
      ? getAutoTelemetryReport(10)
      : null;

    const dialog = buildDialog({
      title: 'Learning data',
      sub: 'What the tool has learned from your corrections.',
    });
    dialog.panel.classList.add('ld-wide');

    const body = document.createElement('div');
    body.className = 'dialog-body learning-data-body';

    body.appendChild(buildLearningTopSummary(learning, meanings, evidence));

    const tabs = buildLearningTabs([
      {
        id: 'evidence',
        label: 'Style Evidence',
        count: evidence ? evidence.pomRowCount : 0,
        build: () => buildLearningEvidenceSection(evidence, evidenceRecords, meanings),
      },
      {
        id: 'corrections',
        label: 'Learning Corrections',
        count: learning ? learning.rows.length : 0,
        build: () => buildLearningAnchorSection(learning),
      },
      {
        id: 'meanings',
        label: 'POM Meanings',
        count: meanings ? meanings.currentRows.length : 0,
        build: () => buildLearningMeaningsSection(meanings),
      },
      {
        id: 'telemetry',
        label: 'Telemetry',
        count: telemetry ? telemetry.count : 0,
        build: () => buildLearningTelemetrySection(telemetry),
      },
    ]);
    body.appendChild(tabs);

    dialog.panel.appendChild(body);

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const note = document.createElement('span');
    note.className = 'learning-data-foot-note';
    note.textContent = 'Use the Manage menu to reset calibration or edit POM meanings.';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'picker-btn primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', dialog.close);
    footer.appendChild(note);
    footer.appendChild(closeBtn);
    dialog.panel.appendChild(footer);

    dialog.open();
    closeBtn.focus();
  }

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

  function buildSummaryCard({ label, value, tone }) {
    const card = document.createElement('div');
    card.className = 'ld-card';
    const labelEl = document.createElement('div');
    labelEl.className = 'ld-card-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'ld-card-value' + (tone ? ' ' + tone : '');
    valueEl.textContent = value;
    card.appendChild(labelEl);
    card.appendChild(valueEl);
    return card;
  }

  // ---- Tab shell ------------------------------------------------------
  // Tabs are built lazily — each panel's content is constructed once on
  // first activation so revisiting a tab doesn't lose the expanded-row
  // state from the previous visit.
  function buildLearningTabs(defs) {
    const wrap = document.createElement('div');
    wrap.className = 'ld-tab-shell';

    const bar = document.createElement('div');
    bar.className = 'ld-tabs';
    bar.setAttribute('role', 'tablist');

    const panels = document.createElement('div');
    panels.className = 'ld-tab-panels';

    const built = new Map();
    const buttons = [];
    const panelEls = [];

    defs.forEach((def, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ld-tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-controls', 'ld-tab-panel-' + def.id);
      btn.id = 'ld-tab-' + def.id;
      btn.dataset.tab = def.id;

      const labelEl = document.createElement('span');
      labelEl.textContent = def.label;
      btn.appendChild(labelEl);
      if (Number.isFinite(def.count)) {
        const badge = document.createElement('span');
        badge.className = 'ld-tab-badge';
        badge.textContent = String(def.count);
        btn.appendChild(badge);
      }
      bar.appendChild(btn);
      buttons.push(btn);

      const panel = document.createElement('div');
      panel.className = 'ld-tab-panel';
      panel.setAttribute('role', 'tabpanel');
      panel.id = 'ld-tab-panel-' + def.id;
      panel.setAttribute('aria-labelledby', 'ld-tab-' + def.id);
      panels.appendChild(panel);
      panelEls.push(panel);

      btn.addEventListener('click', () => activate(idx));
    });

    function activate(activeIdx) {
      for (let i = 0; i < buttons.length; i++) {
        const isActive = i === activeIdx;
        buttons[i].classList.toggle('is-active', isActive);
        buttons[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
        buttons[i].tabIndex = isActive ? 0 : -1;
        panelEls[i].classList.toggle('is-active', isActive);
        if (isActive && !built.has(i)) {
          const content = defs[i].build();
          if (content) panelEls[i].appendChild(content);
          built.set(i, true);
        }
      }
    }

    wrap.appendChild(bar);
    wrap.appendChild(panels);
    activate(0);
    return wrap;
  }

  // ---- Learning Corrections (anchor calibration) ----------------------
  function buildLearningAnchorSection(learning) {
    const section = document.createElement('div');
    section.className = 'ld-section';

    if (!learning || learning.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'No anchor corrections recorded yet. Drag an Auto Mode anchor or label a manual POM line to start.';
      section.appendChild(empty);
      return section;
    }

    const conflictingCount = Number(learning.conflictingCount) || 0;
    const intro = document.createElement('p');
    intro.className = 'ld-section-note';
    const introParts = [
      'A bucket goes Active after ' + learning.minSamples + ' samples.',
      'Median offsets are clamped to ±' + Math.round(learning.clampLimit * 100) + '% of the image size.',
      'Anchor samples total: ' + learning.totalSamples + '.',
      'Parameter samples: ' + learning.totalParamSamples + '.',
    ];
    if (conflictingCount > 0) {
      introParts.push(conflictingCount === 1
        ? '1 bucket is Conflicting — its spread dwarfs its median, so bias is halved when applied.'
        : conflictingCount + ' buckets are Conflicting — spread dwarfs median, so bias is halved when applied.');
    }
    // Phase 8: corrections by suspected pipeline stage — tells the TD (and
    // engineers) WHERE the engine loses accuracy, not just how often.
    const stageCounts = learning.stageCounts || {};
    const stageLabels = {
      'anchor-nudge': 'small nudges',
      'landmark-wrong': 'landmark wrong',
      'contour-missing': 'contour/seam evidence missing',
      'geometry-wrong': 'geometry frame weak',
      'segmentation-weak': 'segmentation weak',
      unknown: 'no detection context',
      unattributed: 'recorded before stage tracking',
    };
    const stageBits = Object.keys(stageCounts)
      .filter(k => stageCounts[k] > 0)
      .sort((x, y) => stageCounts[y] - stageCounts[x])
      .map(k => (stageLabels[k] || k) + ': ' + stageCounts[k]);
    if (stageBits.length) {
      introParts.push('Suspected cause of corrections — ' + stageBits.join(' · ') + '.');
    }
    intro.textContent = introParts.join(' ');
    section.appendChild(intro);

    const table = document.createElement('table');
    table.className = 'ld-table';
    table.innerHTML =
      '<thead><tr>' +
        '<th>Anchor</th>' +
        '<th>View role</th>' +
        '<th class="ld-num">Samples</th>' +
        '<th class="ld-num">Median dx</th>' +
        '<th class="ld-num">Median dy</th>' +
        '<th class="ld-num">Spread dx</th>' +
        '<th class="ld-num">Spread dy</th>' +
        '<th>Status</th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of learning.rows) {
      const tr = document.createElement('tr');
      tr.appendChild(td(row.kind));
      tr.appendChild(td(row.viewRole || '—'));
      tr.appendChild(td(String(row.samples), 'ld-num'));
      tr.appendChild(td(formatLearningDelta(row.medianDx), 'ld-num'));
      tr.appendChild(td(formatLearningDelta(row.medianDy), 'ld-num'));
      tr.appendChild(td(formatLearningSpread(row.madDx), 'ld-num'));
      tr.appendChild(td(formatLearningSpread(row.madDy), 'ld-num'));
      const statusCell = td('');
      const chip = document.createElement('span');
      chip.className = 'ld-status ld-status-' + row.status;
      chip.textContent = statusLabelForRow(row.status);
      statusCell.appendChild(chip);
      tr.appendChild(statusCell);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  // ---- POM Meanings ---------------------------------------------------
  function buildLearningMeaningsSection(meanings) {
    const section = document.createElement('div');
    section.className = 'ld-section';

    if (!meanings) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'Meaning store not available.';
      section.appendChild(empty);
      return section;
    }

    const intro = document.createElement('p');
    intro.className = 'ld-section-note';
    intro.textContent = meanings.currentStyleIsDefault
      ? 'Showing the default bucket (no Style code set). Set a Style code to keep per-style meanings separate.'
      : 'Showing meanings confirmed for style "' + meanings.currentStyleId + '". ' +
        meanings.fixedPomCount + ' fixed · ' + meanings.confirmedForCurrent + ' confirmed · ' +
        meanings.customCount + ' custom across all styles.';
    section.appendChild(intro);

    if (meanings.currentRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'No POM meanings resolved for this style yet. Label a manual POM 6+ line to confirm one.';
      section.appendChild(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'ld-table';
      table.innerHTML =
        '<thead><tr>' +
          '<th class="ld-num">POM</th>' +
          '<th>Meaning</th>' +
          '<th>Start anchor</th>' +
          '<th>End anchor</th>' +
          '<th>Source</th>' +
        '</tr></thead>';
      const tbody = document.createElement('tbody');
      for (const row of meanings.currentRows) {
        const m = row.meaning;
        const tr = document.createElement('tr');
        tr.appendChild(td(row.pom, 'ld-num'));
        tr.appendChild(td(m && m.label || '—'));
        tr.appendChild(td(m && m.start || '—'));
        tr.appendChild(td(m && m.end || '—'));
        const sourceCell = td('');
        const chip = document.createElement('span');
        chip.className = 'ld-status ld-status-' + (row.source === 'fixed' ? 'fixed' : 'confirmed');
        chip.textContent = row.source === 'fixed' ? 'Fixed' : 'Confirmed';
        sourceCell.appendChild(chip);
        tr.appendChild(sourceCell);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      section.appendChild(table);
    }

    if (meanings.knownStyles.length > 1
        || (meanings.knownStyles.length === 1
            && meanings.knownStyles[0].styleId !== meanings.currentStyleId)) {
      const styleHead = document.createElement('p');
      styleHead.className = 'ld-section-note';
      styleHead.textContent = 'Confirmed POMs per known style:';
      section.appendChild(styleHead);
      const ul = document.createElement('ul');
      ul.className = 'ld-style-list';
      for (const s of meanings.knownStyles) {
        const li = document.createElement('li');
        const name = (s.styleId === meanings.defaultStyleId)
          ? 'default bucket'
          : 'style "' + s.styleId + '"';
        const tag = (s.styleId === meanings.currentStyleId) ? ' (current)' : '';
        li.textContent = name + tag + ' — ' + s.confirmedCount + ' confirmed';
        ul.appendChild(li);
      }
      section.appendChild(ul);
    }
    return section;
  }

  // ---- Style Evidence -------------------------------------------------
  // Improved columns: POM, Status, Meaning, View, Evidence Source, Records,
  // Last Saved. Each POM row is expandable to show the individual records
  // (id, timestamp, source, view) — TDs can audit exactly what was saved
  // without diving into localStorage.
  function buildLearningEvidenceSection(evidence, records, meanings) {
    const section = document.createElement('div');
    section.className = 'ld-section';

    if (!evidence) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'Style evidence store not available.';
      section.appendChild(empty);
      return section;
    }

    const styleLabel = meanings && meanings.currentStyleIsDefault
      ? 'the default bucket (no Style code)'
      : 'style "' + evidence.styleId + '"';
    const intro = document.createElement('p');
    intro.className = 'ld-section-note';
    intro.textContent = 'TD-confirmed POM lines remembered for ' + styleLabel
      + (evidence.lastUpdated ? ' · last updated ' + formatEvidenceTimestamp(evidence.lastUpdated) : '')
      + '. Evidence stays separate from calibration residuals and POM meanings.';
    section.appendChild(intro);

    if (evidence.rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ld-empty';
      empty.textContent = 'No style evidence yet. Future Save flows will offer to store corrected POM lines here.';
      section.appendChild(empty);
      return section;
    }

    const pom7Absent = evidence.rows.find(r =>
      String(r.pom) === '7' && r.status === 'absent-confirmed');
    if (pom7Absent) {
      const banner = document.createElement('div');
      banner.className = 'ld-callout ld-callout-absent';
      banner.textContent = 'POM 7 is confirmed absent for this style. Auto Mode will skip drawing POM 7.';
      section.appendChild(banner);
    }

    const recordsByPom = groupRecordsByPom(records);

    const table = document.createElement('table');
    table.className = 'ld-table ld-table-evidence';
    table.innerHTML =
      '<thead><tr>' +
        '<th class="ld-expand-col"></th>' +
        '<th class="ld-num">POM</th>' +
        '<th>Status</th>' +
        '<th>Meaning</th>' +
        '<th>View</th>' +
        '<th>Evidence Source</th>' +
        '<th class="ld-num">Records</th>' +
        '<th>Last Saved</th>' +
      '</tr></thead>';
    const tbody = document.createElement('tbody');
    for (const row of evidence.rows) {
      const pomRecords = recordsByPom.get(String(row.pom)) || [];
      const isAbsent = row.status === 'absent-confirmed';
      const isPom7 = String(row.pom) === '7';

      const tr = document.createElement('tr');
      tr.className = 'ld-evidence-row';
      if (isAbsent) tr.classList.add('ld-evidence-row-absent');
      if (isAbsent && isPom7) tr.classList.add('ld-evidence-row-pom7-absent');

      const expandCell = td('', 'ld-expand-col');
      const expandBtn = document.createElement('button');
      expandBtn.type = 'button';
      expandBtn.className = 'ld-expand-btn';
      expandBtn.setAttribute('aria-label', 'Show records for POM ' + row.pom);
      expandBtn.textContent = '▸';
      expandBtn.disabled = pomRecords.length === 0;
      expandCell.appendChild(expandBtn);
      tr.appendChild(expandCell);

      tr.appendChild(td(row.pom, 'ld-num'));

      const statusCell = td('');
      statusCell.appendChild(buildEvidenceStatusChip(row.status));
      tr.appendChild(statusCell);

      tr.appendChild(td(row.meaningLabel || row.meaningId || '—'));
      tr.appendChild(td(formatViewRole(row.viewRole)));
      tr.appendChild(td(formatEvidenceSource(row.source, pomRecords)));
      tr.appendChild(td(String(row.count), 'ld-num'));
      tr.appendChild(td(row.lastSavedAt ? formatEvidenceTimestamp(row.lastSavedAt, true) : '—'));

      tbody.appendChild(tr);

      const detailRow = document.createElement('tr');
      detailRow.className = 'ld-detail-row';
      detailRow.hidden = true;
      const detailCell = document.createElement('td');
      detailCell.colSpan = 8;
      detailCell.className = 'ld-detail-cell';
      detailCell.appendChild(buildEvidenceDetail(row, pomRecords));
      detailRow.appendChild(detailCell);
      tbody.appendChild(detailRow);

      expandBtn.addEventListener('click', () => {
        if (expandBtn.disabled) return;
        const open = !detailRow.hidden;
        detailRow.hidden = open;
        expandBtn.classList.toggle('is-open', !open);
        expandBtn.textContent = open ? '▸' : '▾';
        expandBtn.setAttribute(
          'aria-label',
          (open ? 'Show' : 'Hide') + ' records for POM ' + row.pom,
        );
      });
    }
    table.appendChild(tbody);
    section.appendChild(table);
    return section;
  }

  function groupRecordsByPom(records) {
    const out = new Map();
    if (!Array.isArray(records)) return out;
    for (const rec of records) {
      const key = rec.pom != null ? String(rec.pom) : '?';
      let arr = out.get(key);
      if (!arr) { arr = []; out.set(key, arr); }
      arr.push(rec);
    }
    return out;
  }

  function buildEvidenceStatusChip(status) {
    const s = status || 'unknown';
    const chip = document.createElement('span');
    if (s === 'confirmed') {
      chip.className = 'ld-status ld-status-confirmed';
      chip.textContent = 'Confirmed';
    } else if (s === 'absent-confirmed') {
      chip.className = 'ld-status ld-status-absent';
      chip.textContent = 'Absent';
    } else if (s === 'pending') {
      chip.className = 'ld-status ld-status-needs-more-samples';
      chip.textContent = 'Needs review';
    } else {
      chip.className = 'ld-status ld-status-empty';
      chip.textContent = s === 'unknown' ? 'Unknown' : s;
    }
    return chip;
  }

  function formatViewRole(viewRole) {
    if (!viewRole) return '—';
    const map = {
      front: 'Front',
      back: 'Back',
      side: 'Side',
      inside: 'Inside',
      detail: 'Detail',
    };
    return map[String(viewRole).toLowerCase()] || String(viewRole);
  }

  function formatEvidenceSourceKind(kind) {
    if (!kind) return null;
    switch (kind) {
      case 'td-edited-auto-line': return 'Auto + TD edit';
      case 'manual-confirmed-line': return 'Manual confirm';
      case 'td-deleted-auto-line': return 'Auto removed';
      default: return kind;
    }
  }

  function formatEvidenceSource(primarySource, records) {
    const kinds = new Set();
    if (primarySource) kinds.add(primarySource);
    if (Array.isArray(records)) {
      for (const r of records) if (r && r.source) kinds.add(r.source);
    }
    if (kinds.size === 0) return '—';
    return Array.from(kinds).map(formatEvidenceSourceKind).join(', ');
  }

  // ---- Expanded row detail --------------------------------------------
  // Shows every persisted record under this POM. We stick to metadata
  // the TD can verify (when, where, what shape) — coordinate dumps would
  // overwhelm without helping audit decisions.
  function buildEvidenceDetail(row, records) {
    const wrap = document.createElement('div');
    wrap.className = 'ld-detail';

    const header = document.createElement('div');
    header.className = 'ld-detail-header';
    header.textContent = 'POM ' + row.pom + ' · ' + (row.meaningLabel || row.meaningId || 'no meaning')
      + ' · ' + records.length + ' record' + (records.length === 1 ? '' : 's');
    wrap.appendChild(header);

    if (!records || records.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ld-detail-empty';
      empty.textContent = 'No individual records recorded for this POM.';
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement('ul');
    list.className = 'ld-detail-list';
    const sorted = records.slice().sort((a, b) => {
      const ta = a.savedAt ? Date.parse(a.savedAt) : 0;
      const tb = b.savedAt ? Date.parse(b.savedAt) : 0;
      return tb - ta;
    });
    for (const rec of sorted) {
      list.appendChild(buildEvidenceDetailItem(rec));
    }
    wrap.appendChild(list);
    return wrap;
  }

  function buildEvidenceDetailItem(rec) {
    const li = document.createElement('li');
    li.className = 'ld-detail-item';

    const title = document.createElement('div');
    title.className = 'ld-detail-item-title';
    const sourceLabel = formatEvidenceSourceKind(rec.source) || '—';
    title.textContent = sourceLabel + (rec.tdStatus === 'absent-confirmed' ? ' · Absent' : '');
    if (rec.tdStatus === 'absent-confirmed') title.classList.add('is-absent');
    li.appendChild(title);

    const meta = document.createElement('dl');
    meta.className = 'ld-detail-meta';
    appendMetaPair(meta, 'Saved', rec.savedAt ? formatEvidenceTimestamp(rec.savedAt, true) : '—');
    appendMetaPair(meta, 'View', formatViewRole(rec.viewRole));
    appendMetaPair(meta, 'Line type', rec.line ? rec.line.type : (rec.tdStatus === 'absent-confirmed' ? 'none (absent)' : '—'));
    if (rec.sourceImageId) appendMetaPair(meta, 'Image', String(rec.sourceImageId));
    if (rec.appRuleVersion) appendMetaPair(meta, 'Rule version', String(rec.appRuleVersion));
    if (rec.templateVersion) appendMetaPair(meta, 'Template', String(rec.templateVersion));
    if (rec.absentReason) appendMetaPair(meta, 'Absent reason', String(rec.absentReason));
    li.appendChild(meta);

    return li;
  }

  function appendMetaPair(dl, label, value) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }

  // ---- Formatters -----------------------------------------------------
  function formatEvidenceTimestamp(iso, withTime) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    const date = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    if (!withTime) return date;
    return date + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function td(text, className) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    cell.textContent = text == null ? '' : String(text);
    return cell;
  }

  function statusLabelForRow(status) {
    switch (status) {
      case 'active': return 'Active';
      case 'needs-more-samples': return 'Needs more samples';
      case 'large-correction': return 'Large correction';
      case 'conflicting': return 'Conflicting';
      case 'empty': return 'Empty';
      default: return status;
    }
  }

  // Spread/MAD as a percentage of image dimension — mirrors how the
  // median dx/dy column is displayed so the TD can compare magnitudes
  // at a glance.
  function formatLearningSpread(value) {
    const num = Math.abs(Number(value) || 0);
    const pct = num * 100;
    return '±' + pct.toFixed(1) + '%';
  }

  function formatLearningDelta(value) {
    const num = Number(value) || 0;
    const pct = num * 100;
    const sign = pct > 0 ? '+' : (pct < 0 ? '' : ' ');
    return sign + pct.toFixed(1) + '%';
  }

  function formatTelemetryDuration(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '—';
    if (n < 1000) return Math.round(n) + 'ms';
    return (n / 1000).toFixed(n < 10000 ? 1 : 0) + 's';
  }

  function formatTelemetryNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '—';
  }
