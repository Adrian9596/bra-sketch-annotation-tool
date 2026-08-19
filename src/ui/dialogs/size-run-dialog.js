// Size-run grading dialog: grade the base spec into a full size run.
// Additive and offline — reads each POM's base value (its Size L, else the
// calibrated measured value), applies a per-POM per-size-step increment, and
// renders a POM x size grid the TD can copy. Grade rules live in
// state.gradeRules (persisted + undoable); NOTHING here touches the rule JSON.
// The grade-rule domain model (GRADE_SIZES, GRADE_BASE_SIZE,
// HOUSE_GRADE_INCHES, inchesToUnit, getGradeRule, gradeBaseValue,
// gradedRunForPom) lives in grading-rules-model.js, shared with
// grading-dialog.js.
// Source part for app.js. Run `npm run build` after editing.

  function pomDisplayName(pomKey) {
    const entry = POM_TEMPLATE && POM_TEMPLATE[String(pomKey)];
    return entry && entry.desc ? entry.desc : ('POM ' + pomKey);
  }

  function openSizeRunDialog() {
    const unit = state.calibration.unit;
    const annByPom = new Map();
    for (const ann of state.annotations) annByPom.set(getLabelText(ann), ann);
    const pomKeys = Object.keys(POM_TEMPLATE).sort((a, b) => Number(a) - Number(b));

    const dialog = buildDialog({
      title: 'Generate size run',
      sub: 'Grade the base spec across ' + GRADE_SIZES[0] + '–' + GRADE_SIZES[GRADE_SIZES.length - 1]
        + ' (base ' + GRADE_BASE_SIZE + '). Unit: ' + unit + '.',
    });

    const body = document.createElement('div');
    body.className = 'size-run-body';
    body.style.cssText = 'max-width:100%;overflow:auto;';
    const lead = document.createElement('p');
    lead.style.cssText = 'margin:0 0 8px;font-size:12px;color:#555;';
    // US-011: this dialog is a read-only PREVIEW of the graded run. All
    // grade-rule editing lives in the Grading dialog (one source of truth) —
    // the review flagged that two editing surfaces over one persisted object
    // silently disagree (per-size overrides beat steps with no UI signal).
    lead.innerHTML = 'Base = each POM’s <b>Size L</b>, or its calibrated measured value if Size L is blank. '
      + 'Preview only — edit the rule via the <b>Grading</b> button. Held POMs (straps) stay flat and are shaded.';
    body.appendChild(lead);

    const scroller = document.createElement('div');
    scroller.style.cssText = 'overflow:auto;max-height:56vh;border:1px solid #e5e5e5;border-radius:8px;';
    const table = document.createElement('table');
    table.className = 'size-run-table';
    table.style.cssText = 'border-collapse:collapse;font-size:12px;white-space:nowrap;';
    scroller.appendChild(table);
    body.appendChild(scroller);
    dialog.panel.appendChild(body);

    function renderTable() {
      table.innerHTML = '';
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      const headCells = ['POM', 'Step/size', 'Hold'].concat(GRADE_SIZES);
      headCells.forEach((h, idx) => {
        const th = document.createElement('th');
        th.textContent = h + (idx === 1 ? ' (' + unit + ')' : '');
        th.style.cssText = 'position:sticky;top:0;background:#fafafa;border-bottom:1px solid #e5e5e5;'
          + 'padding:5px 8px;text-align:' + (idx <= 2 ? 'left' : 'right') + ';font-weight:600;';
        if (GRADE_SIZES[idx - 3] === GRADE_BASE_SIZE) th.style.background = '#eef4ff';
        hr.appendChild(th);
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      for (const key of pomKeys) {
        const rule = getGradeRule(key);
        const baseInfo = gradeBaseValue(key, annByPom);
        const tr = document.createElement('tr');
        if (rule.hold) tr.style.background = '#fffbe6'; // held POMs shaded

        const nameTd = document.createElement('td');
        nameTd.style.cssText = 'padding:4px 8px;border-bottom:1px solid #f0f0f0;max-width:190px;overflow:hidden;text-overflow:ellipsis;';
        nameTd.textContent = key + '. ' + pomDisplayName(key);
        nameTd.title = pomDisplayName(key) + (baseInfo.source ? ' · base from ' + baseInfo.source : ' · no base set');
        tr.appendChild(nameTd);

        // Read-only step/hold display (US-011: editing moved to the Grading
        // dialog; legacy step overrides remain honored and visible here).
        const stepTd = document.createElement('td');
        stepTd.style.cssText = 'padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#555;';
        stepTd.textContent = rule.hold ? '—' : String(+rule.step.toFixed(3));
        if (rule.overridden) {
          stepTd.style.fontWeight = '600';
          stepTd.title = 'TD step override (edit or clear it in the Grading dialog)';
        }
        tr.appendChild(stepTd);

        const holdTd = document.createElement('td');
        holdTd.style.cssText = 'padding:4px 8px;border-bottom:1px solid #f0f0f0;text-align:center;color:#555;';
        holdTd.textContent = rule.hold ? 'held' : '';
        holdTd.title = rule.hold ? 'Held constant across sizes (e.g. adjustable straps)' : '';
        tr.appendChild(holdTd);

        const run = baseInfo.value != null ? gradedRunForPom(baseInfo.value, rule) : null;
        GRADE_SIZES.forEach((sz, i) => {
          const td = document.createElement('td');
          td.style.cssText = 'padding:4px 8px;border-bottom:1px solid #f0f0f0;text-align:right;'
            + (sz === GRADE_BASE_SIZE ? 'background:#eef4ff;font-weight:600;' : '');
          td.textContent = run ? formatMeasure(run[i]) : '—';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    renderTable();

    function buildTsv() {
      const header = ['POM', 'Description'].concat(GRADE_SIZES.map(s => s + ' (' + unit + ')'));
      const lines = [header.join('\t')];
      for (const key of pomKeys) {
        const rule = getGradeRule(key);
        const baseInfo = gradeBaseValue(key, annByPom);
        const run = baseInfo.value != null ? gradedRunForPom(baseInfo.value, rule) : null;
        const cells = [key, pomDisplayName(key)].concat(
          GRADE_SIZES.map((_, i) => (run ? formatMeasure(run[i]) : ''))
        );
        lines.push(cells.join('\t'));
      }
      return lines.join('\n');
    }

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    // US-011: no reset here — this dialog is a preview; the Grading dialog
    // owns every grade-rule edit (per-POM and global resets included).
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'picker-btn';
    copyBtn.textContent = 'Copy table';
    copyBtn.addEventListener('click', () => {
      const tsv = buildTsv();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(tsv).then(
          () => showToast('Size run copied — paste into a spec sheet.'),
          () => showToast('Copy failed — select and copy manually.')
        );
      } else {
        showToast('Clipboard unavailable in this browser.');
      }
    });
    const doneBtn = document.createElement('button');
    doneBtn.type = 'button';
    doneBtn.className = 'picker-btn primary';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', dialog.close);
    footer.appendChild(spacer);
    footer.appendChild(copyBtn);
    footer.appendChild(doneBtn);
    dialog.panel.appendChild(footer);

    dialog.open();
  }
