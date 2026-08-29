// Context-aware command registry (US-094). Source part for app.js.
// Run `npm run build` after editing.
//
// Stable actions across all five tech-pack pages live here once. The keyboard
// router, Command Palette, shortcut hints, and Help dialog read this same
// registry so their labels and bindings cannot drift apart. Record-specific
// table actions stay on their native buttons and keyboard focus path.

  function appCommand(spec) {
    return Object.assign({
      category: 'General',
      keywords: '',
      page: null,
      mode: null,
      target: null,
      shortcut: null,
      shortcuts: null,
      allowInField: false,
      palette: true,
    }, spec);
  }

  function appCommandClick(selector) {
    const target = document.querySelector(selector);
    if (target) target.click();
  }

  function appCommandBlurField(event) {
    const target = event && event.target;
    if (target && typeof target.blur === 'function') target.blur();
  }

  function appCommandSelectedAnnotationReason() {
    return state.selection.kind === 'annotation' ? true : 'Select one Board line first.';
  }

  function appCommandSelectedAnnotationOrGraphicReason() {
    return (state.selection.kind === 'annotation' || state.selection.kind === 'graphic')
      ? true : 'Select one Board line or shape first.';
  }

  function appCommandSelectedImageReason() {
    return state.selection.kind === 'image' ? true : 'Select one Board image first.';
  }

  function appCommandSelectedConstructionImageReason() {
    return ccImageById(ccSelectedImageId, ccSheet, ccActiveView)
      ? true : 'Select one Construction image first.';
  }

  function appCommandSelectedConstructionCalloutReason() {
    return ccSelectedCallout() ? true : 'Select one Construction callout first.';
  }

  function appCommandSelectedBomImageReason() {
    return bmImageById(bmSelectedImageId, bmVariant)
      ? true : 'Select one BOM image first.';
  }

  function appCommandSelectedBomCalloutReason() {
    return bmSelectedCallout() ? true : 'Select one BOM callout first.';
  }

  function appCommandTogglePreviewSheet(key) {
    const input = document.querySelector('[data-pv-toggle="' + key + '"]');
    if (input) input.click();
  }

  const APP_COMMANDS = [
    appCommand({ id: 'palette.open', label: 'Open Command Palette', category: 'Global',
      keywords: 'search find commands actions', shortcut: { key: 'k', meta: true },
      allowInField: true, action: () => openCommandPalette() }),
    appCommand({ id: 'page.board', label: 'Go to Board', category: 'Navigate',
      keywords: 'page tab canvas', shortcut: { key: '1', meta: true }, allowInField: true,
      action: e => { appCommandBlurField(e); setActivePage('board'); } }),
    appCommand({ id: 'page.mainpage', label: 'Go to Main Page', category: 'Navigate',
      keywords: 'page tab style metadata', shortcut: { key: '2', meta: true }, allowInField: true,
      action: e => { appCommandBlurField(e); setActivePage('mainpage'); } }),
    appCommand({ id: 'page.construction', label: 'Go to Construction', category: 'Navigate',
      keywords: 'page tab operations sewing', shortcut: { key: '3', meta: true }, allowInField: true,
      action: e => { appCommandBlurField(e); setActivePage('construction'); } }),
    appCommand({ id: 'page.bom', label: 'Go to BOM', category: 'Navigate',
      keywords: 'page tab bill materials', shortcut: { key: '4', meta: true }, allowInField: true,
      action: e => { appCommandBlurField(e); setActivePage('bom'); } }),
    appCommand({ id: 'page.preview', label: 'Go to Preview & Export', category: 'Navigate',
      keywords: 'page tab workbook excel', shortcut: { key: '5', meta: true }, allowInField: true,
      action: e => { appCommandBlurField(e); setActivePage('preview'); } }),
    appCommand({ id: 'project.undo', label: 'Undo', category: 'Project',
      shortcut: { key: 'z', meta: true }, allowInField: true, target: '#undoBtn',
      action: e => { appCommandBlurField(e); flushLineNudgeSession(); void undo(); } }),
    appCommand({ id: 'project.redo', label: 'Redo', category: 'Project',
      shortcut: { key: 'z', meta: true, shift: true },
      shortcuts: [{ key: 'z', meta: true, shift: true }, { key: 'y', meta: true }],
      allowInField: true, target: '#redoBtn',
      action: e => { appCommandBlurField(e); flushLineNudgeSession(); void redo(); } }),
    appCommand({ id: 'project.save', label: 'Save Project', category: 'Project',
      keywords: 'download json', shortcut: { key: 's', meta: true }, allowInField: true,
      target: '#saveProjectBtn', action: e => { appCommandBlurField(e); appCommandClick('#saveProjectBtn'); } }),
    appCommand({ id: 'project.open', label: 'Open Project…', category: 'Project',
      keywords: 'load json', shortcut: { key: 'o', meta: true }, allowInField: true,
      target: '#openProjectBtn', action: e => { appCommandBlurField(e); appCommandClick('#openProjectBtn'); } }),
    appCommand({ id: 'help.open', label: 'Help & Shortcuts…', category: 'Global',
      keywords: 'keyboard reference question', shortcut: { key: '?', shift: true, display: '?' },
      action: () => openHelpDialog() }),

    appCommand({ id: 'board.mode.manual', label: 'Switch to Manual Mode', category: 'Board · Mode',
      page: 'board', target: '#modeManualBtn', action: () => appCommandClick('#modeManualBtn') }),
    appCommand({ id: 'board.mode.auto', label: 'Switch to Auto Mode', category: 'Board · Mode',
      page: 'board', target: '#modeAutoBtn', action: () => appCommandClick('#modeAutoBtn') }),
    appCommand({ id: 'board.auto.detect', label: 'Detect Sketch', category: 'Board · Auto',
      page: 'board', mode: 'auto', keywords: 'vision step 1', shortcut: { key: '1' },
      target: '#autoDetectBtn', action: () => appCommandClick('#autoDetectBtn') }),
    appCommand({ id: 'board.auto.anchors', label: 'Manage Anchors', category: 'Board · Auto',
      page: 'board', mode: 'auto', target: '#autoManageAnchorsBtn',
      action: () => appCommandClick('#autoManageAnchorsBtn') }),
    appCommand({ id: 'board.auto.anchors.hide', label: 'Hide All Anchors', category: 'Board · Auto',
      page: 'board', mode: 'auto', when: () => state.autoMode.anchors.length ? true : 'Detect a sketch first.',
      action: () => { hideAllAnchors(); renderAnchorManagerPanel(); } }),
    appCommand({ id: 'board.auto.anchors.show', label: 'Show All Anchors', category: 'Board · Auto',
      page: 'board', mode: 'auto', when: () => state.autoMode.anchors.length ? true : 'Detect a sketch first.',
      action: () => { showAllAnchors(); renderAnchorManagerPanel(); } }),
    appCommand({ id: 'board.auto.anchors.reset', label: 'Reset Anchors', category: 'Board · Auto',
      page: 'board', mode: 'auto', target: '#autoResetAnchorsBtn',
      action: () => appCommandClick('#autoResetAnchorsBtn') }),
    appCommand({ id: 'board.auto.generate', label: 'Generate Drafts', category: 'Board · Auto',
      page: 'board', mode: 'auto', keywords: 'POM step 2', shortcut: { key: '2' },
      target: '#autoGenerateBtn', action: () => appCommandClick('#autoGenerateBtn') }),
    appCommand({ id: 'board.auto.approve', label: 'Approve Selected Draft', category: 'Board · Auto',
      page: 'board', mode: 'auto', target: '#autoApproveBtn',
      action: () => appCommandClick('#autoApproveBtn') }),
    appCommand({ id: 'board.auto.review', label: 'Mark Selected Draft Review-Only', category: 'Board · Auto',
      page: 'board', mode: 'auto', target: '#autoReviewOnlyBtn',
      action: () => appCommandClick('#autoReviewOnlyBtn') }),
    appCommand({ id: 'board.auto.apply', label: 'Apply Lines', category: 'Board · Auto',
      page: 'board', mode: 'auto', keywords: 'POM step 3', shortcut: { key: '3' },
      target: '#autoApplyBtn', action: () => appCommandClick('#autoApplyBtn') }),
    appCommand({ id: 'board.auto.discard', label: 'Discard Drafts', category: 'Board · Auto',
      page: 'board', mode: 'auto', target: '#autoDiscardBtn',
      action: () => appCommandClick('#autoDiscardBtn') }),

    appCommand({ id: 'board.image.add', label: 'Add Image…', category: 'Board · Image',
      page: 'board', keywords: 'photo sketch upload', shortcut: { key: 'a' }, target: '#addImageBtn',
      action: () => appCommandClick('#addImageBtn') }),
    appCommand({ id: 'board.image.import', label: 'Import PowerPoint…', category: 'Board · Image',
      page: 'board', mode: 'manual', keywords: 'ppt pptx', shortcut: { key: 'i' },
      target: '#importPptxBtn', action: () => appCommandClick('#importPptxBtn') }),
    appCommand({ id: 'board.library.open', label: 'Open Project Library…', category: 'Board · Project',
      page: 'board', mode: 'manual', target: '#libraryBtn', action: () => appCommandClick('#libraryBtn') }),
    appCommand({ id: 'board.select.all', label: 'Select All on Board', category: 'Board · Edit',
      page: 'board', keywords: 'photos lines', shortcut: { key: 'a', meta: true },
      action: () => selectAllOnBoard() }),
    appCommand({ id: 'board.tool.select', label: 'Select Tool', category: 'Board · Tools',
      page: 'board', shortcut: { key: 's' }, target: '#toolSelect', action: () => setTool('select') }),
    appCommand({ id: 'board.tool.straight', label: 'Straight Line Tool', category: 'Board · Tools',
      page: 'board', mode: 'manual', shortcut: { key: '0' }, target: '#toolStraight',
      action: () => setTool('straight') }),
    appCommand({ id: 'board.tool.curved', label: 'Curved Line Tool', category: 'Board · Tools',
      page: 'board', mode: 'manual', shortcut: { key: 'c' },
      shortcuts: [{ key: 'c' }, { key: 'b' }], target: '#toolCurved', action: () => setTool('curved') }),
    appCommand({ id: 'board.tool.eraser', label: 'Eraser Tool', category: 'Board · Tools',
      page: 'board', mode: 'manual', shortcut: { key: 'x' }, target: '#toolEraser',
      when: () => state.images.length ? true : 'Add a Board image first.', action: () => setTool('eraser') }),
    appCommand({ id: 'board.tool.text', label: 'Text Note Tool', category: 'Board · Tools',
      page: 'board', mode: 'manual', shortcut: { key: 't' }, target: '#toolText', action: () => setTool('text') }),
    // Shape shortcuts: 4 = rectangle (4 sides), O = circle (round like an O),
    // 6 = hexagon (6 sides). Plain keys — page-nav uses ⌘4/⌘5, Open is ⌘O.
    ...[['rectangle', '4'], ['circle', 'o'], ['hexagon', '6']].map(([shape, key]) => appCommand({
      id:'board.tool.'+shape, label:shape[0].toUpperCase()+shape.slice(1)+' Tool', category:'Board · Tools',
      page:'board', mode:'manual', shortcut: { key }, target:'#tool'+shape[0].toUpperCase()+shape.slice(1), action:()=>setTool(shape),
    })),
    // Path editing shares one ⇧-letter family — ⇧P point, ⇧E edit, ⇧X cut. The
    // plain letters are taken (P export PDF, E export Excel, X eraser) and the
    // three read as one group rather than three leftovers.
    appCommand({ id: 'board.tool.add-point', label: 'Add Point to Selected Curve', category: 'Board · Tools',
      page: 'board', mode: 'manual', shortcut: { key: 'p', shift: true },
      target: '#toolAddPoint', action: () => appCommandClick('#toolAddPoint') }),
    appCommand({ id:'board.graphic.edit-path', label:'Edit Selected Graphic Path', category:'Board · Graphics',
      page:'board', mode:'manual', shortcut: { key: 'e', shift: true },
      target:'#editPathBtn', when:()=>getSelectedBoardGraphic()?true:'Select one Board Graphic first.', action:()=>bgEnterEdit(getSelectedBoardGraphic()) }),
    appCommand({ id:'board.graphic.cut-path', label:'Cut Selected Graphic Path', category:'Board · Graphics',
      page:'board', mode:'manual', shortcut: { key: 'x', shift: true },
      target:'#cutPathBtn', when:()=>state.graphicEdit&&state.graphicEdit.active?true:'Select a path node or segment first.', action:()=>cutSelectedBoardGraphicPath() }),
    appCommand({ id:'board.graphic.segment-straight', label:'Make Graphic Segment Straight', category:'Board · Graphics',
      page:'board', mode:'manual', target:'#segmentStraightBtn', action:()=>bgSetActiveSegmentType('line') }),
    appCommand({ id:'board.graphic.segment-curved', label:'Make Graphic Segment Curved', category:'Board · Graphics',
      page:'board', mode:'manual', target:'#segmentCurvedBtn', action:()=>bgSetActiveSegmentType('curve') }),
    ...['solid', 'dashed', 'zigzag', 'cover', 'bartack'].map(style => appCommand({
      id: 'board.style.' + style, label: 'Line Style: ' + style[0].toUpperCase() + style.slice(1),
      category: 'Board · Style', page: 'board', mode: 'manual',
      target: '[data-style="' + style + '"]', action: () => setLineStyle(style),
    })),
    ...['double', 'single', 'none'].map(type => appCommand({
      id: 'board.arrow.' + type, label: 'Arrowheads: ' + (type === 'none' ? 'None' : type[0].toUpperCase() + type.slice(1)),
      category: 'Board · Style', page: 'board', mode: 'manual',
      target: '#arrow' + type[0].toUpperCase() + type.slice(1) + 'Btn', action: () => setArrowType(type),
    })),
    // Shift+A cycles None -> Single -> Double -> None. The three commands
    // above jump straight to a named value (palette / click only, same as
    // every other per-value style picker — see ARCHITECTURE.md); this one
    // is the sole keyboard entry point, added because there was previously
    // no way to change arrow style without the mouse.
    appCommand({ id: 'board.arrow.cycle', label: 'Arrowheads: Cycle', category: 'Board · Style',
      page: 'board', mode: 'manual', shortcut: { key: 'a', shift: true },
      action: () => cycleArrowType() }),
    ...['red', 'blue', 'black', 'white'].map(color => appCommand({
      id: 'board.color.' + color, label: 'Line Color: ' + color[0].toUpperCase() + color.slice(1),
      category: 'Board · Style', page: 'board', mode: 'manual', target: '#color' + color[0].toUpperCase() + color.slice(1) + 'Btn',
      action: () => setDrawColor(color),
    })),
    appCommand({ id: 'board.focus.line-width', label: 'Focus Line Width', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#lineWidthInput', action: () => document.getElementById('lineWidthInput').focus() }),
    appCommand({ id: 'board.focus.note-size', label: 'Focus Note Font Size', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#fontSizeInput', action: () => document.getElementById('fontSizeInput').focus() }),
    ...[['text-only', 'Text only'], ['box', 'Box']].map(([appearance, label]) => appCommand({
      id: 'board.note.appearance.' + appearance, label: 'Note Appearance: ' + label,
      category: 'Board · Note', page: 'board', mode: 'manual',
      target: appearance === 'box' ? '#noteAppearanceBoxBtn' : '#noteAppearanceTextOnlyBtn',
      action: () => setNoteAppearance(appearance),
    })),
    ...['red', 'blue', 'black', 'white'].map(color => appCommand({
      id: 'board.note.text-color.' + color,
      label: 'Note Text Color: ' + color[0].toUpperCase() + color.slice(1),
      category: 'Board · Note', page: 'board', mode: 'manual',
      target: '.note-text-color-btn[data-color="' + color + '"]', action: () => setNoteTextColor(color),
    })),
    ...['red', 'blue', 'black', 'white'].map(color => appCommand({
      id: 'board.note.leader-color.' + color,
      label: 'Note Leader Color: ' + color[0].toUpperCase() + color.slice(1),
      category: 'Board · Note', page: 'board', mode: 'manual',
      target: '.note-leader-color-btn[data-color="' + color + '"]', action: () => setNoteLeaderColor(color),
    })),
    appCommand({ id: 'board.focus.brush-size', label: 'Focus Eraser Brush Size', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#brushSizeInput', action: () => document.getElementById('brushSizeInput').focus() }),
    // US-096 / ADR 0055: the preset library. Open + Save are the two actions
    // worth a palette entry; applying a specific preset is a click in the menu,
    // and registering one command per user-created preset would flood the
    // palette with rows that change under the TD's feet.
    appCommand({ id: 'board.presets.open', label: 'Open Line Library', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#stitchesBtn',
      action: () => openLinePresetMenu() }),
    appCommand({ id: 'board.presets.save', label: 'Save Selected Line as Treatment', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#linePresetSaveBtn',
      action: () => saveCurrentLookAsPreset() }),
    // US-097 / ADR 0056: the saved-shape library. Same reasoning as the presets
    // above — Save is worth a palette entry, and picking a specific shape is a
    // click in the Tools menu rather than one command per user-created stamp.
    appCommand({ id: 'board.shapes.save', label: 'Save Selection as Template', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#shapeStampSaveBtn',
      when: () => (typeof canSaveShapeStampReason === 'function' ? canSaveShapeStampReason() : true),
      action: () => saveSelectedLineAsShape() }),
    appCommand({ id: 'board.shapes.open', label: 'Open Templates', category: 'Board · Style',
      page: 'board', mode: 'manual', target: '#toolsMenuBtn',
      action: () => {
        const record = boardToolbarMenuRecords().find(r => r.list && r.list.id === 'toolsMenuList');
        if (record) openBoardToolbarMenu(record);
      } }),
    appCommand({ id: 'board.smart-align.toggle', label: 'Toggle Smart Align', category: 'Board · Edit',
      page: 'board', mode: 'manual', target: '#smartAlignToggleBtn',
      action: () => toggleSmartAlign() }),
    // US-102: POM Focus is the implicit default with no button of its own;
    // this single command (and the single #sketchFocusBtn toolbar toggle it
    // targets) is the only way to enter or leave the exceptional Sketch
    // Focus. No dedicated single-key shortcut (avoids a new collision risk,
    // matching board.smart-align.toggle's existing precedent).
    appCommand({ id: 'board.focus.sketch.toggle', label: 'Toggle Sketch Focus', category: 'Board · View',
      page: 'board', mode: 'manual', target: '#sketchFocusBtn',
      action: () => toggleSketchMode() }),
    appCommand({ id: 'board.copy.line', label: 'Copy Selected Line/Shape', category: 'Board · Edit',
      page: 'board', mode: 'manual', shortcut: { key: 'c', meta: true }, target: '#copyLineBtn',
      when: appCommandSelectedAnnotationOrGraphicReason, action: () => copySelectedLineOrGraphic() }),
    appCommand({ id: 'board.paste.line', label: 'Paste Copied Line/Shape', category: 'Board · Edit',
      page: 'board', mode: 'manual', shortcut: { key: 'v', meta: true }, target: '#pasteLineBtn',
      action: () => pasteFromClipboard(), keyboardEvent: false }),
    appCommand({ id: 'board.reflect.line', label: 'Reflect Selected Line', category: 'Board · Edit',
      page: 'board', mode: 'manual', shortcut: { key: 'm' }, target: '#reflectLineBtn',
      when: appCommandSelectedAnnotationReason, action: () => reflectSelectedAnnotation() }),
    appCommand({ id: 'board.delete.selected', label: 'Delete Selected', category: 'Board · Edit',
      page: 'board', shortcut: { key: 'Delete', display: 'Delete' },
      shortcuts: [{ key: 'Delete' }, { key: 'Backspace' }], target: '#deleteBtn',
      when: () => state.selection.kind == null
        ? 'Select a Board item first.'
        : (state.appMode === 'auto' && state.selection.kind !== 'image'
          ? 'Auto lines are locked; use draft review controls.' : true),
      action: () => deleteSelected() }),
    appCommand({ id: 'board.image.lock-selected', label: 'Lock / Unlock Selected Image', category: 'Board · Image',
      page: 'board', target: '#lockImageBtn', when: appCommandSelectedImageReason,
      action: () => toggleSelectedImageLock() }),
    appCommand({ id: 'board.image.lock-all', label: 'Lock / Unlock All Images', category: 'Board · Image',
      page: 'board', shortcut: { key: 'l' }, when: () => state.images.length ? true : 'Add a Board image first.',
      action: () => toggleAllImagesLock() }),
    appCommand({ id: 'board.fit', label: 'Fit Board', category: 'Board · View',
      page: 'board', shortcut: { key: 'f' }, shortcuts: [{ key: 'f' }, { key: '0', meta: true }],
      target: '#fitBtn', action: () => fitSelectionOrAll() }),
    appCommand({ id: 'board.panel.toggle', label: 'Hide / Show Measurements', category: 'Board · View',
      page: 'board', shortcut: { key: 'h' }, target: '#togglePanelBtn', action: () => toggleSpecPanel() }),
    appCommand({ id: 'board.labels.toggle', label: 'Hide / Show Numbers', category: 'Board · View',
      page: 'board', shortcut: { key: 'n' }, target: '#toggleLabelsBtn', action: () => toggleLabels() }),
    appCommand({ id: 'board.scale.set', label: 'Set Scale…', category: 'Board · Measurements',
      page: 'board', mode: 'manual', target: '#setScaleBtn',
      when: appCommandSelectedAnnotationReason, action: () => setScaleFromSelection() }),
    appCommand({ id: 'board.scale.clear', label: 'Clear Scale', category: 'Board · Measurements',
      page: 'board', mode: 'manual', target: '#clearScaleBtn',
      when: () => state.pixelsPerUnit ? true : 'No scale is currently set.', action: () => clearScale() }),
    appCommand({ id: 'board.size-run', label: 'Size Run…', category: 'Board · Measurements',
      page: 'board', mode: 'manual', target: '#sizeRunBtn', action: () => openSizeRunDialog() }),
    appCommand({ id: 'board.grading', label: 'Grading Rules…', category: 'Board · Measurements',
      page: 'board', shortcut: { key: 'g' }, target: '#gradingBtn', action: () => openGradingDialog() }),
    appCommand({ id: 'board.learning.toggle', label: 'Toggle Learning', category: 'Board · Learning',
      page: 'board', action: () => setLearningEnabled(!isLearningEnabled()) }),
    appCommand({ id: 'board.learning.view', label: 'View Learning Data…', category: 'Board · Learning',
      page: 'board', action: () => openLearningDataDialog() }),
    appCommand({ id: 'board.learning.reset', label: 'Reset Calibration Residuals…', category: 'Board · Learning',
      page: 'board', action: () => resetLearning() }),
    appCommand({ id: 'board.learning.forget-style', label: 'Forget POM Meanings for Current Style…', category: 'Board · Learning',
      page: 'board', action: () => resetPomMeanings('current') }),
    appCommand({ id: 'board.learning.forget-all', label: 'Forget POM Meanings for All Styles…', category: 'Board · Learning',
      page: 'board', action: () => resetPomMeanings('all') }),
    appCommand({ id: 'board.export.copy-image', label: 'Copy Board Image', category: 'Board · Export',
      page: 'board', mode: 'manual', shortcut: { key: 'c', meta: true, shift: true }, target: '#copyImageBtn',
      action: () => { void copyBoardImageToClipboard(); } }),
    appCommand({ id: 'board.export.pdf', label: 'Export Board PDF', category: 'Board · Export',
      page: 'board', mode: 'manual', shortcut: { key: 'p' }, target: '#exportPdfBtn', action: () => exportPdf() }),
    appCommand({ id: 'board.export.excel', label: 'Export Measurement Excel', category: 'Board · Export',
      page: 'board', mode: 'manual', shortcut: { key: 'e' }, target: '#exportExcelBtn',
      action: () => { void exportSpecXlsx(); } }),
    appCommand({ id: 'board.reset', label: 'Reset Board…', category: 'Board · Reset',
      page: 'board', shortcut: { key: 'r' }, action: () => resetWorkingBoard() }),
    appCommand({ id: 'board.lines.clear', label: 'Delete All Lines (Keep Images)', category: 'Board · Reset',
      page: 'board', shortcut: { key: 'd' }, action: () => clearAllLinesKeepImage() }),
    appCommand({ id: 'board.annotations.clear', label: 'Clear All Annotations…', category: 'Board · Reset',
      page: 'board', mode: 'manual', target: '#clearBtn', action: () => clearAllAnnotations() }),

    appCommand({ id: 'main.print', label: 'Print Main Page', category: 'Main Page',
      page: 'mainpage', target: '#mainPagePrintBtn', action: () => appCommandClick('#mainPagePrintBtn') }),
    appCommand({ id: 'main.color.add', label: 'Add Colour…', category: 'Main Page',
      page: 'mainpage', target: '#mainPageAddColorBtn', action: () => appCommandClick('#mainPageAddColorBtn') }),

    appCommand({ id: 'construction.sheet.solid', label: 'Construction Sheet: Solid', category: 'Construction · Sheet',
      page: 'construction', target: '[data-cc-sheet="solid"]', action: () => appCommandClick('[data-cc-sheet="solid"]') }),
    appCommand({ id: 'construction.sheet.lace', label: 'Construction Sheet: Lace', category: 'Construction · Sheet',
      page: 'construction', target: '[data-cc-sheet="lace"]', action: () => appCommandClick('[data-cc-sheet="lace"]') }),
    appCommand({ id: 'construction.view.outer', label: 'Construction Panel: Outer', category: 'Construction · View',
      page: 'construction', target: '[data-cc-active-view="outer"]', action: () => appCommandClick('[data-cc-active-view="outer"]') }),
    appCommand({ id: 'construction.view.inner', label: 'Construction Panel: Inner', category: 'Construction · View',
      page: 'construction', target: '[data-cc-active-view="inner"]', action: () => appCommandClick('[data-cc-active-view="inner"]') }),
    appCommand({ id: 'construction.image.add', label: 'Add Construction Images…', category: 'Construction · Image',
      page: 'construction', target: '#ccAddImageBtn', action: () => appCommandClick('#ccAddImageBtn') }),
    appCommand({ id: 'construction.image.paste', label: 'Paste Construction Image', category: 'Construction · Image',
      page: 'construction', target: '#ccPasteImageBtn', action: () => appCommandClick('#ccPasteImageBtn') }),
    appCommand({ id: 'construction.image.delete', label: 'Delete Selected Construction Image', category: 'Construction · Image',
      page: 'construction', target: '#ccDeleteImageBtn', when: appCommandSelectedConstructionImageReason,
      action: () => ccDeleteSelectedImage() }),
    appCommand({ id: 'construction.image.smaller', label: 'Make Construction Image Smaller', category: 'Construction · Image',
      page: 'construction', target: '#ccImageZoomOutBtn', when: appCommandSelectedConstructionImageReason,
      action: () => ccZoomSelectedImage(0.9) }),
    appCommand({ id: 'construction.image.larger', label: 'Make Construction Image Larger', category: 'Construction · Image',
      page: 'construction', target: '#ccImageZoomInBtn', when: appCommandSelectedConstructionImageReason,
      action: () => ccZoomSelectedImage(1.1) }),
    appCommand({ id: 'construction.tool.select', label: 'Construction Select Tool', category: 'Construction · Tools',
      page: 'construction', target: '#ccSelectToolBtn', action: () => ccSetTool('select') }),
    appCommand({ id: 'construction.tool.callout', label: 'Add Construction Callouts', category: 'Construction · Tools',
      page: 'construction', target: '#ccAddCalloutBtn',
      when: () => ccMissingRows().length ? true : 'Every Construction row already has a callout.',
      action: () => ccStartCalloutTool(ccSelectedRowId) }),
    appCommand({ id: 'construction.tool.leader', label: 'Add Construction Leaders', category: 'Construction · Tools',
      page: 'construction', target: '#ccAddLeaderBtn', when: appCommandSelectedConstructionCalloutReason,
      action: () => ccSetTool('leader') }),
    appCommand({ id: 'construction.callout.delete', label: 'Delete Selected Construction Callout', category: 'Construction · Tools',
      page: 'construction', target: '#ccDeleteCalloutBtn', when: appCommandSelectedConstructionCalloutReason,
      action: () => ccDeleteSelectedCallout() }),
    appCommand({ id: 'construction.row.add-outer', label: 'Add Construction Outer Row', category: 'Construction · Table',
      page: 'construction', action: () => ccAddRow('outer') }),
    appCommand({ id: 'construction.row.add-inner', label: 'Add Construction Inner Row', category: 'Construction · Table',
      page: 'construction', action: () => ccAddRow('inner') }),

    appCommand({ id: 'bom.variant.solid', label: 'BOM Variant: Solid', category: 'BOM · Variant',
      page: 'bom', target: '[data-bom-variant="solid"]', action: () => appCommandClick('[data-bom-variant="solid"]') }),
    appCommand({ id: 'bom.variant.lace', label: 'BOM Variant: Lace', category: 'BOM · Variant',
      page: 'bom', target: '[data-bom-variant="lace"]', action: () => appCommandClick('[data-bom-variant="lace"]') }),
    appCommand({ id: 'bom.image.add', label: 'Add BOM Images…', category: 'BOM · Image',
      page: 'bom', target: '#bomAddImageBtn', action: () => appCommandClick('#bomAddImageBtn') }),
    appCommand({ id: 'bom.image.paste', label: 'Paste BOM Image', category: 'BOM · Image',
      page: 'bom', target: '#bomPasteImageBtn', action: () => appCommandClick('#bomPasteImageBtn') }),
    appCommand({ id: 'bom.image.delete', label: 'Delete Selected BOM Image', category: 'BOM · Image',
      page: 'bom', target: '#bomDeleteImageBtn', when: appCommandSelectedBomImageReason,
      action: () => bmDeleteSelectedImage() }),
    appCommand({ id: 'bom.image.smaller', label: 'Make BOM Image Smaller', category: 'BOM · Image',
      page: 'bom', target: '#bomImageZoomOutBtn', when: appCommandSelectedBomImageReason,
      action: () => bmZoomSelectedImage(0.9) }),
    appCommand({ id: 'bom.image.larger', label: 'Make BOM Image Larger', category: 'BOM · Image',
      page: 'bom', target: '#bomImageZoomInBtn', when: appCommandSelectedBomImageReason,
      action: () => bmZoomSelectedImage(1.1) }),
    appCommand({ id: 'bom.image.fit', label: 'Fit BOM Images', category: 'BOM · Image',
      page: 'bom', target: '#bomFitImagesBtn', when: () => bmVariantImages().length ? true : 'Add a BOM image first.',
      action: () => appCommandClick('#bomFitImagesBtn') }),
    appCommand({ id: 'bom.tool.select', label: 'BOM Select Tool', category: 'BOM · Tools',
      page: 'bom', target: '#bomSelectToolBtn', action: () => appCommandClick('#bomSelectToolBtn') }),
    appCommand({ id: 'bom.tool.callout', label: 'Add BOM Callouts', category: 'BOM · Tools',
      page: 'bom', target: '#bomAddCalloutBtn',
      when: () => bmMissingCalloutRows(bmVariant).length ? true : 'Every visible BOM row already has a callout.',
      action: () => appCommandClick('#bomAddCalloutBtn') }),
    appCommand({ id: 'bom.tool.leader', label: 'Add BOM Leaders', category: 'BOM · Tools',
      page: 'bom', target: '#bomAddArrowBtn', when: appCommandSelectedBomCalloutReason,
      action: () => appCommandClick('#bomAddArrowBtn') }),
    appCommand({ id: 'bom.callout.delete', label: 'Delete Selected BOM Callout', category: 'BOM · Tools',
      page: 'bom', target: '#bomDeleteCalloutBtn', when: appCommandSelectedBomCalloutReason,
      action: () => bmDeleteSelectedCallout() }),
    appCommand({ id: 'bom.row.add-fabric', label: 'Add BOM Fabric Row', category: 'BOM · Table',
      page: 'bom', action: () => bmAddRow('FABRIC') }),
    appCommand({ id: 'bom.row.add-trim', label: 'Add BOM Trim Row', category: 'BOM · Table',
      page: 'bom', action: () => bmAddRow('TRIM') }),

    ...PV_SHEETS.map(sheet => appCommand({
      id: 'preview.sheet.' + sheet.key, label: 'Toggle Preview Sheet: ' + sheet.label,
      category: 'Preview · Sheets', page: 'preview', target: '[data-pv-toggle="' + sheet.key + '"]',
      action: () => appCommandTogglePreviewSheet(sheet.key),
    })),
    appCommand({ id: 'preview.export', label: 'Export Tech Pack Excel', category: 'Preview · Export',
      page: 'preview', target: '#pvExportXlsxBtn',
      when: () => pvEnabledSheets().length ? true : 'Select at least one sheet first.',
      action: () => { void exportTechPackXlsx(); } }),
  ];

  function getAppCommands() {
    return APP_COMMANDS.slice();
  }

  function getAppCommand(id) {
    return APP_COMMANDS.find(command => command.id === id) || null;
  }

  function appCommandTarget(command) {
    return command && command.target ? document.querySelector(command.target) : null;
  }

  function getAppCommandAvailability(command) {
    if (!command) return { enabled: false, reason: 'Unknown command.' };
    if (command.page && state.activePage !== command.page) {
      const page = TECH_PACK_PAGES.find(item => item.id === command.page);
      return { enabled: false, reason: 'Available on ' + (page ? page.label : command.page) + '.' };
    }
    if (command.mode && state.appMode !== command.mode) {
      return { enabled: false, reason: 'Available in ' + (command.mode === 'auto' ? 'Auto' : 'Manual') + ' Mode.' };
    }
    if (typeof command.when === 'function') {
      const result = command.when();
      if (result !== true) return { enabled: false, reason: String(result || 'Not available in the current state.') };
    }
    const target = appCommandTarget(command);
    if (command.target && !target) return { enabled: false, reason: 'This control is not available yet.' };
    if (target && target.disabled) return { enabled: false, reason: 'Not available in the current state.' };
    if (target && (target.hidden || (target.classList.contains('recovery-only') && target.offsetParent === null))) {
      return { enabled: false, reason: 'Not available in the current workflow step.' };
    }
    return { enabled: true, reason: '' };
  }

  function runAppCommand(id, event) {
    const command = getAppCommand(id);
    const availability = getAppCommandAvailability(command);
    if (!availability.enabled) {
      showToast(availability.reason);
      return false;
    }
    command.action(event || null);
    return true;
  }

  function appCommandShortcutList(command) {
    return command.shortcuts || (command.shortcut ? [command.shortcut] : []);
  }

  function appCommandShortcutMatches(event, shortcut) {
    if (!shortcut || shortcut.keyboardEvent === false) return false;
    const key = String(event.key || '').toLowerCase();
    const expected = String(shortcut.key || '').toLowerCase();
    if (key !== expected) return false;
    if (!!shortcut.meta !== !!(event.metaKey || event.ctrlKey)) return false;
    if (!!shortcut.shift !== !!event.shiftKey) return false;
    if (!!shortcut.alt !== !!event.altKey) return false;
    return true;
  }

  function dispatchAppCommandShortcut(event, inField) {
    for (const command of APP_COMMANDS) {
      if (inField && !command.allowInField) continue;
      if (command.keyboardEvent === false) continue;
      if (!appCommandShortcutList(command).some(shortcut => appCommandShortcutMatches(event, shortcut))) continue;
      const availability = getAppCommandAvailability(command);
      if (!availability.enabled) return false;
      event.preventDefault();
      runAppCommand(command.id, event);
      return true;
    }
    return false;
  }

  function appCommandIsMac() {
    return /Mac|iPhone|iPad|iPod/i.test((navigator && navigator.platform) || '');
  }

  function formatAppCommandShortcut(shortcut) {
    if (!shortcut) return '';
    if (shortcut.display) return shortcut.display;
    const parts = [];
    if (shortcut.meta) parts.push(appCommandIsMac() ? '⌘' : 'Ctrl');
    if (shortcut.alt) parts.push(appCommandIsMac() ? '⌥' : 'Alt');
    if (shortcut.shift) parts.push('⇧');
    const names = { 'arrowleft': '←', 'arrowright': '→', 'arrowup': '↑', 'arrowdown': '↓', 'delete': 'Delete', 'backspace': 'Backspace' };
    parts.push(names[String(shortcut.key).toLowerCase()] || String(shortcut.key).toUpperCase());
    return parts.join(appCommandIsMac() ? '' : '+');
  }

  function formatAppCommandShortcuts(command) {
    return appCommandShortcutList(command).map(formatAppCommandShortcut).join(' / ');
  }

  function appCommandAriaShortcut(shortcut) {
    if (!shortcut) return '';
    const parts = [];
    if (shortcut.meta) parts.push(appCommandIsMac() ? 'Meta' : 'Control');
    if (shortcut.alt) parts.push('Alt');
    if (shortcut.shift) parts.push('Shift');
    parts.push(String(shortcut.key));
    return parts.join('+');
  }

  function applyAppCommandShortcutHints() {
    APP_COMMANDS.forEach(command => {
      if (!command.shortcut || !command.target) return;
      const target = appCommandTarget(command);
      if (!target) return;
      const label = formatAppCommandShortcut(command.shortcut);
      target.dataset.key = label;
      target.setAttribute('aria-keyshortcuts', appCommandAriaShortcut(command.shortcut));
      const base = (target.dataset.commandBaseTitle || target.title || command.label).split(' · Shortcut:')[0];
      target.dataset.commandBaseTitle = base;
      target.title = base + ' · Shortcut: ' + label;
    });
  }

  function appCommandHelpRowsHtml() {
    return APP_COMMANDS.filter(command => command.shortcut && command.id !== 'palette.open')
      .map(command => '<div class="help-row"><span>' + escapeHtml(command.label)
        + '</span><span class="help-keys"><span class="kbd">'
        + escapeHtml(formatAppCommandShortcuts(command)) + '</span></span></div>')
      .join('');
  }
