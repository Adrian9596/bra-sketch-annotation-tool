// Transparent Learning panel: Style Evidence tab, incl. expandable
// per-record detail rows.
// Improved columns: POM, Status, Meaning, View, Evidence Source, Records,
// Last Saved. Each POM row is expandable to show the individual records
// (id, timestamp, source, view) — TDs can audit exactly what was saved
// without diving into localStorage.
// Source part for app.js. Run `npm run build` after editing.

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
