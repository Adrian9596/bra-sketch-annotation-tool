// Transparent Learning panel (read-only TD review).
// Reads from summarizeLearningStore + summarizeMeaningStore +
// summarizeStyleEvidence + listStyleEvidence. Renders a top summary plus
// a tabbed body: Style Evidence, Learning Corrections, POM Meanings.
// No mutations — Reset and Manage Meanings live in the Auto Mode Manage
// menu and stay there. Opens regardless of mode so the TD can audit prior
// calibration before switching into Auto Mode.
// Source part for app.js. Run `npm run build` after editing.
//
// This is the orchestrator only — it wires the 4 tab defs to their build()
// functions. The shared formatters live in learning-data-shared.js; the
// generic tab-shell widget lives in learning-data-tabs.js; each tab's body
// lives in its own file: learning-data-telemetry.js, learning-data-summary.js,
// learning-data-corrections.js, learning-data-meanings.js,
// learning-data-evidence.js.

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
