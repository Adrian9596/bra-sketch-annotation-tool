// Transparent Learning panel: Learning Corrections (anchor calibration) tab.
// Source part for app.js. Run `npm run build` after editing.

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
