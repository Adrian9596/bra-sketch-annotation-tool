// Transparent Learning panel: POM Meanings tab.
// Source part for app.js. Run `npm run build` after editing.

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
