// US-096 + US-098 / ADR 0060: Line Treatment Library and layer editor.
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

  function lineTreatmentPreviewSvg(preset) {
    if (!preset || preset.kind !== 'treatment' || !preset.treatment) {
      return linePresetPreviewSvg(preset && preset.style);
    }
    const layers = normalizeLineTreatmentLayers(preset.treatment.layers);
    const body = layers.map(layer => {
      const y = clamp(7 + layer.offset * 0.55, 1.5, 12.5);
      const color = LINE_COLORS[layer.color] || LINE_COLOR;
      const width = clamp(layer.width * 0.65, 0.7, 3.5);
      if (layer.pattern === 'zigzag') {
        const amp = clamp(layer.amplitude * 0.35, 1.5, 5);
        const pts = [];
        for (let x = 3, i = 0; x <= 33; x += 4, i += 1) pts.push(x + ',' + clamp(y + (i % 2 ? amp : -amp), 1, 13));
        return '<polyline points="' + pts.join(' ') + '" stroke="' + color + '" stroke-width="' + width + '"/>';
      }
      const dash = layer.pattern === 'dashed' ? ' stroke-dasharray="5 3"' : '';
      return '<line x1="3" y1="' + y + '" x2="33" y2="' + y + '" stroke="' + color + '" stroke-width="' + width + '"' + dash + '/>';
    }).join('');
    return '<svg class="style-preview" viewBox="0 0 36 14" fill="none" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  // What the row says it will do, spelled out because the consequence is not
  // obvious: picking a stitch preset takes the line OUT of the measurement
  // table (ADR 0055), and a TD should be able to read that before clicking.
  function linePresetRowTitle(preset) {
    if (preset.kind === 'treatment' && preset.treatment) {
      return `${preset.name} — ${preset.treatment.layers.length} editable layer${preset.treatment.layers.length === 1 ? '' : 's'}. Applies along the selected path without changing its geometry.`;
    }
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
    const rowHtml = (preset) => {
      const kind = preset.kind === 'treatment' ? 'treatment' : 'look';
      const siblings = presets.filter(item => (item.kind === 'treatment' ? 'treatment' : 'look') === kind);
      const index = siblings.findIndex(item => item.id === preset.id);
      const first = index === 0 ? ' disabled' : '';
      const last = index === siblings.length - 1 ? ' disabled' : '';
      return '<div class="preset-row" data-preset-id="' + escapeHtml(preset.id) + '">'
        + '<button type="button" role="menuitem" class="preset-apply" data-preset-action="apply"'
        + ' style="color:' + escapeHtml(swatch(preset.color)) + '"'
        + ' title="' + escapeHtml(linePresetRowTitle(preset)) + '">'
        + lineTreatmentPreviewSvg(preset)
        + '<span>' + escapeHtml(preset.name) + '</span>'
        + '</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="up" aria-label="Move up" title="Move up"' + first + '>&#9650;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="down" aria-label="Move down" title="Move down"' + last + '>&#9660;</button>'
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="rename" aria-label="Rename" title="Rename">&#9998;</button>'
        + (preset.kind === 'treatment' ? '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="edit" aria-label="Edit treatment" title="Edit layers">&#9881;</button>' : '')
        + '<button type="button" role="menuitem" class="preset-ctl" data-preset-action="delete" aria-label="Delete" title="Delete">&times;</button>'
        + '</div>';
    };
    const treatments = presets.filter(preset => preset.kind === 'treatment');
    const looks = presets.filter(preset => preset.kind !== 'treatment');
    el.linePresetList.innerHTML = (treatments.length
      ? '<div class="preset-subgroup">Construction treatments</div>' + treatments.map(rowHtml).join('') : '')
      + (looks.length
        ? '<div class="preset-subgroup">Saved line looks</div>' + looks.map(rowHtml).join('') : '');
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

  function treatmentLayerEditorRow(layer, index) {
    const patterns = lineTreatmentPatterns().map(pattern => '<option value="' + pattern + '"'
      + (layer.pattern === pattern ? ' selected' : '') + '>' + pattern + '</option>').join('');
    const colors = Object.keys(LINE_COLORS).map(color => '<option value="' + color + '"'
      + (layer.color === color ? ' selected' : '') + '>' + color + '</option>').join('');
    return '<div class="treatment-layer" data-layer-index="' + index + '">'
      + '<label>Pattern<select data-layer-field="pattern">' + patterns + '</select></label>'
      + '<label>Offset<input data-layer-field="offset" type="number" min="-40" max="40" step="0.5" value="' + layer.offset + '"></label>'
      + '<label>Width<input data-layer-field="width" type="number" min="0.5" max="16" step="0.5" value="' + layer.width + '"></label>'
      + '<label>Color<select data-layer-field="color">' + colors + '</select></label>'
      + '<label>Spacing<input data-layer-field="spacing" type="number" min="2" max="80" step="1" value="' + layer.spacing + '"></label>'
      + '<label>Amplitude<input data-layer-field="amplitude" type="number" min="1" max="40" step="0.5" value="' + layer.amplitude + '"></label>'
      + '<button type="button" class="treatment-layer-delete" data-delete-layer="' + index + '" aria-label="Delete layer" title="Delete layer">&times;</button>'
      + '</div>';
  }

  function openLineTreatmentEditor({ title, name, recipe, confirmLabel, onConfirm }) {
    const dialog = buildDialog({ title, sub: 'Layers follow the selected path. Offset moves a layer to either side; geometry and anchors stay unchanged.' });
    dialog.panel.classList.add('treatment-dialog');
    let layers = normalizeLineTreatmentLayers(recipe && recipe.layers);
    if (!layers.length) layers = legacyStyleTreatmentLayers('solid', 'black', 2);
    const body = document.createElement('div');
    body.className = 'treatment-editor';
    body.innerHTML = '<label class="scale-field">Treatment name<input data-treatment-name type="text" maxlength="60" placeholder="e.g. Binding 12 mm"></label>'
      + '<div class="treatment-preview" aria-label="Treatment preview"><svg data-treatment-preview viewBox="0 0 520 74" aria-hidden="true"></svg></div>'
      + '<div class="treatment-layers" data-treatment-layers></div>'
      + '<button type="button" class="picker-btn" data-add-treatment-layer>+ Add layer</button>';
    dialog.panel.appendChild(body);
    const nameInput = body.querySelector('[data-treatment-name]');
    const list = body.querySelector('[data-treatment-layers]');
    const preview = body.querySelector('[data-treatment-preview]');
    nameInput.value = name || (recipe && recipe.name) || '';

    function readLayers() {
      return Array.from(list.querySelectorAll('[data-layer-index]')).map(row => {
        const value = field => row.querySelector('[data-layer-field="' + field + '"]').value;
        return normalizeLineTreatmentLayer({
          id: layers[Number(row.dataset.layerIndex)] && layers[Number(row.dataset.layerIndex)].id,
          pattern: value('pattern'), offset: Number(value('offset')), width: Number(value('width')),
          color: value('color'), spacing: Number(value('spacing')), amplitude: Number(value('amplitude')),
        });
      }).filter(Boolean);
    }

    function paintPreview() {
      const rows = readLayers();
      const svg = rows.map(layer => {
        const y = clamp(37 + layer.offset * 1.7, 5, 69);
        const color = LINE_COLORS[layer.color] || LINE_COLOR;
        const width = clamp(layer.width, 0.5, 8);
        if (layer.pattern === 'zigzag') {
          const amp = clamp(layer.amplitude * 1.2, 2, 28);
          const step = clamp(layer.spacing * 1.4, 4, 60);
          const pts = [];
          let i = 0;
          for (let x = 18; x <= 502; x += step, i += 1) pts.push(x + ',' + clamp(y + (i % 2 ? amp : -amp), 3, 71));
          return '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round" stroke-linejoin="round"/>';
        }
        return '<line x1="18" y1="' + y + '" x2="502" y2="' + y + '" stroke="' + color + '" stroke-width="' + width + '" stroke-linecap="round"'
          + (layer.pattern === 'dashed' ? ' stroke-dasharray="' + Math.max(2, layer.spacing * 0.6) + ' ' + Math.max(2, layer.spacing * 0.4) + '"' : '') + '/>';
      }).join('');
      preview.innerHTML = svg;
    }

    function renderRows() {
      list.innerHTML = layers.map(treatmentLayerEditorRow).join('');
      list.querySelectorAll('input,select').forEach(input => input.addEventListener('input', paintPreview));
      list.querySelectorAll('[data-delete-layer]').forEach(button => button.addEventListener('click', () => {
        layers = readLayers();
        if (layers.length <= 1) { showToast('A Treatment needs at least one layer.'); return; }
        layers.splice(Number(button.dataset.deleteLayer), 1);
        renderRows();
      }));
      paintPreview();
    }

    body.querySelector('[data-add-treatment-layer]').addEventListener('click', () => {
      layers = readLayers();
      if (layers.length >= 8) { showToast('A Treatment can hold up to 8 layers.'); return; }
      layers.push(normalizeLineTreatmentLayer({ pattern: 'solid', offset: 0, width: 2, color: 'black', spacing: 10, amplitude: 4 }));
      renderRows();
    });

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    footer.innerHTML = '<span style="flex:1"></span>';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'picker-btn'; cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button'; okBtn.className = 'picker-btn primary'; okBtn.textContent = confirmLabel || 'Apply';
    footer.appendChild(cancelBtn); footer.appendChild(okBtn); dialog.panel.appendChild(footer);
    cancelBtn.addEventListener('click', dialog.close);
    okBtn.addEventListener('click', () => {
      const nextName = nameInput.value.trim();
      const nextLayers = readLayers();
      if (!nextName) { nameInput.focus(); showToast('Give the Treatment a name first.'); return; }
      if (!nextLayers.length) { showToast('Add at least one Treatment layer.'); return; }
      dialog.close();
      onConfirm({ name: nextName, layers: nextLayers });
    });
    renderRows();
    dialog.open();
    nameInput.focus();
    nameInput.select();
  }

  function saveSelectedTreatmentToLibrary() {
    const selected = getSelectedAnnotation();
    // Backward-compatible escape hatch for the old named-look workflow: with
    // no selected path, save the current draw defaults as a look. A real Line
    // Treatment still requires a selected path because its recipe belongs to
    // path depiction, not the next-line tool mode.
    if (!selected) { saveCurrentLookAsPreset(); return; }
    const recipe = currentLineTreatment();
    openLineTreatmentEditor({
      title: 'Save Line Treatment', name: recipe.name === 'Custom treatment' ? '' : recipe.name,
      recipe, confirmLabel: 'Save treatment',
      onConfirm: next => {
        const saved = addLineTreatment(next.name, next);
        renderLinePresetList();
        linePresetToast(saved ? `Saved "${saved.name}" to Line Treatments.` : 'Could not save that Treatment.');
      },
    });
  }

  function customizeSelectedTreatment() {
    const ann = getSelectedAnnotation();
    if (!ann) { showToast('Select a line first.'); return; }
    const recipe = currentLineTreatment();
    openLineTreatmentEditor({
      title: 'Customize selected line', name: recipe.name, recipe, confirmLabel: 'Apply to selected',
      onConfirm: next => {
        customizeSelectedLineTreatment(next);
        showToast(`${next.name} customized on the selected line.`);
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
      moveLinePresetWithinKind(id, action === 'up' ? -1 : 1);
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
    if (action === 'edit' && preset.treatment) {
      closeLineStyleMenu();
      openLineTreatmentEditor({
        title: 'Update Library Treatment', name: preset.name, recipe: preset.treatment,
        confirmLabel: 'Update treatment',
        onConfirm: next => {
          updateLineTreatment(id, next, next.name);
          renderLinePresetList();
          linePresetToast(`Updated "${next.name}". Existing drawings were not changed.`);
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
      saveSelectedTreatmentToLibrary();
    });
    if (el.lineTreatmentCustomizeBtn) {
      el.lineTreatmentCustomizeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        closeLineStyleMenu();
        customizeSelectedTreatment();
      });
    }
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
      linePresetToast('Line Treatments reset to the built-in set.');
    });
    // Dismissal is the Stitches menu's: the document click handler and Escape
    // in bindings.js / keyboard-shortcuts.js already own it, and every control
    // here stops propagation so operating the library does not close the menu
    // under the TD's hand.
  }
