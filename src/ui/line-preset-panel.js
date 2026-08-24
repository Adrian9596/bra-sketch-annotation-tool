// US-096 / ADR 0055: the line-preset dropdown.
//
// Presentation only. Every mutation goes through src/manual/line-presets.js,
// which owns the model, the storage and the apply semantics — this file decides
// what the rows look like and which control calls what, exactly the split
// src/ui/board-toolbar.js already uses for the rest of the toolbar.
//
// The rows are rendered from stored data rather than written into index.html,
// because the list is the TD's own and changes at runtime.
// Source part for app.js. Run `npm run build` after editing.

  // Inline SVG previews, one per style, matching the Stitches menu's own
  // artwork so a preset reads as the same thing the Stitches menu offers.
  function linePresetPreviewSvg(style) {
    const open = '<svg class="style-preview" viewBox="0 0 36 14" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    if (style === 'dashed') return open + '<line x1="3" y1="7" x2="33" y2="7" stroke-width="1.8" stroke-dasharray="6 4"/></svg>';
    if (style === 'zigzag') return open + '<polyline points="3,7 7,3 11,11 15,3 19,11 23,3 27,11 31,3 33,7" stroke-width="1.6"/></svg>';
    if (style === 'cover') return open + '<line x1="3" y1="5" x2="33" y2="5" stroke-width="1.5" stroke-dasharray="5 4"/><line x1="3" y1="9" x2="33" y2="9" stroke-width="1.5" stroke-dasharray="5 4"/></svg>';
    if (style === 'bartack') return open + '<line x1="3" y1="7" x2="33" y2="7" stroke-width="1.4" opacity="0.32"/><polyline points="8,4 11,10 14,4 17,10 20,4 23,10 26,4 28,10" stroke-width="1.5"/></svg>';
    return open + '<line x1="3" y1="7" x2="33" y2="7" stroke-width="1.8"/></svg>';
  }

  // What the row says it will do, spelled out because the consequence is not
  // obvious: picking a stitch preset takes the line OUT of the measurement
  // table (ADR 0055), and a TD should be able to read that before clicking.
  function linePresetRowTitle(preset) {
    const base = `${preset.name} — ${lineStyleLabel(preset.style)}, ${preset.color}, ${formatLineWidth(preset.lineWidth)} px`;
    return isStitchStyle(preset.style)
      ? base + '. A construction mark: drawn and exported, but no measurement row and no callout number.'
      : base + '. A measurement line.';
  }

  function renderLinePresetList() {
    if (!el.linePresetList) return;
    // Only offered while an opened project actually holds presets this browser
    // lacks — otherwise it is a row that does nothing.
    if (el.linePresetImportProjectBtn) {
      const pending = getPendingProjectLinePresets().length;
      el.linePresetImportProjectBtn.hidden = pending === 0;
      el.linePresetImportProjectBtn.textContent = pending
        ? `Import ${pending} preset${pending > 1 ? 's' : ''} from project`
        : 'Import from project';
    }
    const presets = getLinePresets();
    const swatch = (color) => LINE_COLORS[color] || LINE_COLOR;
    el.linePresetList.innerHTML = presets.map((preset, index) => {
      const first = index === 0 ? ' disabled' : '';
      const last = index === presets.length - 1 ? ' disabled' : '';
      return '<div class="preset-row" data-preset-id="' + escapeHtml(preset.id) + '">'
        + '<button type="button" role="menuitem" class="preset-apply" data-preset-action="apply"'
        + ' style="color:' + escapeHtml(swatch(preset.color)) + '"'
        + ' title="' + escapeHtml(linePresetRowTitle(preset)) + '">'
        + linePresetPreviewSvg(preset.style)
        + '<span>' + escapeHtml(preset.name) + '</span>'
        + '</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="up" aria-label="Move up" title="Move up"' + first + '>&#9650;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="down" aria-label="Move down" title="Move down"' + last + '>&#9660;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="rename" aria-label="Rename" title="Rename">&#9998;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="delete" aria-label="Delete" title="Delete">&times;</button>'
        + '</div>';
    }).join('');
  }

  // The library has no dropdown of its own: it lives in the Stitches menu, whose
  // openLineStyleMenu calls this. US-082 caps how many units may sit on the
  // primary Board surface, and a preset IS a line look — the same thing the five
  // built-in rows above it are — so a second trigger would have spent a slot to
  // split one idea across two menus.
  function openLinePresetMenu() {
    openLineStyleMenu();
  }

  // Every library action ends in exactly one toast, worded for that action and
  // truthful about whether it will survive a reload. saveLinePresets is silent
  // precisely so this is the only message the TD sees.
  function linePresetToast(message) {
    showToast(linePresetsPersisted()
      ? message
      : message + ' (this session only — the browser refused to store it)');
  }

  // A one-field name prompt. Deliberately not window.prompt(): it is blocked in
  // headless Chrome (so no suite could drive this flow) and it cannot be
  // styled, focus-trapped, or dismissed with the same Escape contract as every
  // other dialog in the app.
  function openLinePresetNameDialog({ title, sub, value, confirmLabel, onConfirm }) {
    const dialog = buildDialog({ title, sub });
    const body = document.createElement('div');
    body.className = 'scale-body';
    body.innerHTML = '<div class="scale-field">'
      + '<input type="text" maxlength="60" aria-label="Preset name" placeholder="e.g. Zigzag 3 mm" />'
      + '</div>';
    dialog.panel.appendChild(body);
    const input = body.querySelector('input');
    input.value = value || '';

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'picker-btn primary';
    okBtn.textContent = confirmLabel;
    footer.appendChild(spacer);
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);
    dialog.panel.appendChild(footer);

    function confirm() {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        showToast('Give the preset a name first.');
        return;
      }
      dialog.close();
      onConfirm(name);
    }
    okBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', dialog.close);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); confirm(); }
    });
    dialog.open();
    input.focus();
    input.select();
  }

  function saveCurrentLookAsPreset() {
    const look = currentLineLook();
    openLinePresetNameDialog({
      title: 'Save line preset',
      sub: `${lineStyleLabel(look.style)}, ${look.color}, ${formatLineWidth(look.lineWidth)} px`,
      value: '',
      confirmLabel: 'Save preset',
      onConfirm: (name) => {
        const preset = addLinePreset(name);
        if (!preset) { showToast('Could not save that preset.'); return; }
        renderLinePresetList();
        linePresetToast(`Saved "${preset.name}" to the line presets.`);
      },
    });
  }

  function onLinePresetListClick(event) {
    const button = event.target.closest('[data-preset-action]');
    if (!button || button.disabled) return;
    const row = button.closest('[data-preset-id]');
    if (!row) return;
    event.stopPropagation();
    const id = row.dataset.presetId;
    const action = button.dataset.presetAction;
    const preset = getLinePresetById(id);
    if (!preset) return;

    if (action === 'apply') {
      applyLinePreset(id);
      closeLineStyleMenu();
      return;
    }
    if (action === 'up' || action === 'down') {
      moveLinePreset(id, action === 'up' ? -1 : 1);
      renderLinePresetList();
      refocusLibraryRowControl('linePresetList', id, { kind: 'preset', name: action });
      return;
    }
    if (action === 'rename') {
      openLinePresetNameDialog({
        title: 'Rename preset',
        sub: preset.name,
        value: preset.name,
        confirmLabel: 'Rename',
        onConfirm: (name) => {
          renameLinePreset(id, name);
          renderLinePresetList();
          refocusLibraryRowControl('linePresetList', id, { kind: 'preset', name: 'rename' });
        },
      });
      return;
    }
    if (action === 'delete') {
      const order = getLinePresets().map(p => p.id);
      const index = order.indexOf(id);
      deleteLinePreset(id);
      renderLinePresetList();
      const after = getLinePresets();
      const neighbour = after[Math.min(index, after.length - 1)];
      if (neighbour) refocusLibraryRowControl('linePresetList', neighbour.id, { kind: 'preset', name: 'delete' });
      linePresetToast(`Deleted "${preset.name}".`);
    }
  }

  function onLinePresetImportFile(event) {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const added = importLinePresetsFromJson(String(reader.result || ''));
      renderLinePresetList();
      if (!added) { showToast('That file held no line presets.'); return; }
      linePresetToast(`Imported ${added} preset${added > 1 ? 's' : ''}.`);
    };
    reader.onerror = () => showToast('Could not read that file.');
    reader.readAsText(file);
  }

  function bindLinePresetPanel() {
    if (!el.linePresetList) return;
    el.linePresetList.addEventListener('click', onLinePresetListClick);
    el.linePresetSaveBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      closeLineStyleMenu();
      saveCurrentLookAsPreset();
    });
    el.linePresetExportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      exportLinePresetsFile();
      closeLineStyleMenu();
    });
    el.linePresetImportBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      el.linePresetFileInput.click();
    });
    el.linePresetFileInput.addEventListener('change', onLinePresetImportFile);
    if (el.linePresetImportProjectBtn) {
      el.linePresetImportProjectBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const added = importPendingProjectLinePresets();
        el.linePresetImportProjectBtn.hidden = true;
        renderLinePresetList();
        if (!added) { showToast('Nothing to import.'); return; }
        linePresetToast(`Imported ${added} preset${added > 1 ? 's' : ''} from the project.`);
      });
    }
    el.linePresetResetBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      resetLinePresetsToBuiltins();
      renderLinePresetList();
      linePresetToast('Line presets reset to the built-in set.');
    });
    // Dismissal is the Stitches menu's: the document click handler and Escape
    // in bindings.js / keyboard-shortcuts.js already own it, and every control
    // here stops propagation so operating the library does not close the menu
    // under the TD's hand.
  }
