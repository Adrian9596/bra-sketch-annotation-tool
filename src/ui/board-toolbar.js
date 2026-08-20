// US-082: Contextual Board toolbar. This module owns only presentation and
// menu behavior; the original command buttons and their existing bindings
// remain the single execution path for every action.

  const BOARD_TOOLBAR_MENUS = [
    ['fileMenuWrap', 'fileMenuBtn', 'fileMenuList'],
    ['exportMenuWrap', 'exportMenuBtn', 'exportMenuList'],
    ['moreMenuWrap', 'moreMenuBtn', 'moreMenuList'],
    ['arrowMenuWrap', 'arrowMenuBtn', 'arrowMenuList'],
    ['colorMenuWrap', 'colorMenuBtn', 'colorMenuList'],
  ];

  function boardToolbarMenuRecords() {
    return BOARD_TOOLBAR_MENUS.map(([wrapId, buttonId, listId]) => ({
      wrap: document.getElementById(wrapId),
      button: document.getElementById(buttonId),
      list: document.getElementById(listId),
    })).filter(record => record.wrap && record.button && record.list);
  }

  function closeBoardToolbarMenus(exceptList, restoreFocus) {
    for (const record of boardToolbarMenuRecords()) {
      if (record.list === exceptList) continue;
      const wasOpen = !record.list.hidden;
      record.list.hidden = true;
      record.button.setAttribute('aria-expanded', 'false');
      if (wasOpen && restoreFocus) record.button.focus();
    }
  }

  function openBoardToolbarMenu(record) {
    closeLineStyleMenu();
    closeBoardToolbarMenus(record.list, false);
    record.list.hidden = false;
    record.button.setAttribute('aria-expanded', 'true');
    const first = Array.from(record.list.querySelectorAll('[role="menuitem"]'))
      .find(item => !item.disabled && !item.hidden && item.offsetParent !== null);
    if (first) first.focus();
  }

  function toggleBoardToolbarMenu(event, record) {
    event.stopPropagation();
    if (record.list.hidden) openBoardToolbarMenu(record);
    else closeBoardToolbarMenus(null, true);
  }

  function moveBoardMenuFocus(event, list) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(list.querySelectorAll('[role="menuitem"]'))
      .filter(item => !item.disabled && !item.hidden && item.offsetParent !== null);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    let next = 0;
    if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'ArrowUp') next = current <= 0 ? items.length - 1 : current - 1;
    else if (event.key === 'ArrowDown') next = current < 0 || current === items.length - 1 ? 0 : current + 1;
    items[next].focus();
  }

  function initBoardToolbar() {
    const records = boardToolbarMenuRecords();
    for (const record of records) {
      record.button.addEventListener('click', event => toggleBoardToolbarMenu(event, record));
      record.list.addEventListener('keydown', event => moveBoardMenuFocus(event, record.list));
      record.list.addEventListener('click', event => {
        if (event.target.closest('[role="menuitem"]')) closeBoardToolbarMenus();
      });
    }

    document.addEventListener('click', event => {
      if (!event.target.closest('.toolbar-menu')) closeBoardToolbarMenus();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const openRecord = boardToolbarMenuRecords().find(record => !record.list.hidden);
      if (!openRecord) return;
      event.preventDefault();
      closeBoardToolbarMenus(null, true);
    });
    const addImageMenuBtn = document.getElementById('addImageMenuBtn');
    if (addImageMenuBtn) addImageMenuBtn.addEventListener('click', () => el.addImageBtn.click());
  }

  function setBoardToolbarHidden(node, hidden) {
    if (node) node.hidden = !!hidden;
  }

  function updateBoardToolbarUI() {
    const boardGroups = document.getElementById('boardToolbarGroups');
    if (!boardGroups) return;
    if (state.activePage && state.activePage !== 'board') closeBoardToolbarMenus();

    const isAuto = state.appMode === 'auto';
    const imageCount = state.images.length;
    const annotationCount = state.annotations.length;
    const empty = imageCount === 0 && annotationCount === 0;
    const selectedAnnotation = getSelectedAnnotation();
    const selectedImage = getSelectedImage();
    const selectedNote = getSelectedNote();
    const auto = state.autoMode;
    const hasSource = !!pickAutoSourceImage();
    const hasAnchors = auto.anchors.length > 0;
    const recovery = auto.status === 'error' || auto.draftAnnotations.length > 0;

    boardGroups.dataset.mode = isAuto ? 'auto' : 'manual';
    boardGroups.dataset.empty = empty ? 'true' : 'false';

    // Empty Auto boards do not show a disabled workflow. Once an image exists,
    // exactly one next-step action receives the primary treatment.
    el.autoModeBar.classList.toggle('workflow-empty', isAuto && !hasSource && !recovery);
    setBoardToolbarHidden(el.autoDetectBtn, !isAuto || !hasSource || recovery);
    setBoardToolbarHidden(el.autoManageAnchorsBtn, !isAuto || !hasAnchors || recovery);
    setBoardToolbarHidden(el.autoGenerateBtn, !isAuto || !hasAnchors || recovery);
    el.autoDetectBtn.classList.toggle('context-primary', isAuto && hasSource && !hasAnchors && !recovery);
    el.autoGenerateBtn.classList.toggle('context-primary', isAuto && hasAnchors && !recovery);
    el.addImageBtn.classList.toggle('primary-btn', empty);
    setBoardToolbarHidden(el.addImageBtn, !isAuto && !empty);

    setBoardToolbarHidden(el.autoResetAnchorsBtn, !isAuto || !auto.detection);
    setBoardToolbarHidden(el.autoResetBoardBtn, !isAuto || isWorkingBoardEmpty());

    // Manual selection actions occupy the toolbar only when actionable.
    const selectionMode = !isAuto && state.tool === 'select';
    setBoardToolbarHidden(el.undoBtn, !selectionMode || el.undoBtn.disabled);
    setBoardToolbarHidden(el.redoBtn, !selectionMode || el.redoBtn.disabled);
    setBoardToolbarHidden(el.copyLineBtn, !selectionMode || !selectedAnnotation);
    setBoardToolbarHidden(el.reflectLineBtn, !selectionMode || !selectedAnnotation);
    setBoardToolbarHidden(el.pasteLineBtn, !selectionMode || el.pasteLineBtn.disabled);
    // US-092: Delete is the note's only toolbar action — Copy / Reflect / Paste
    // are line operations and stay hidden for a selected note.
    setBoardToolbarHidden(el.deleteBtn, !selectionMode || !(selectedAnnotation || selectedImage || selectedNote));
    setBoardToolbarHidden(el.lockImageBtn, !selectionMode || !selectedImage);
    const contextGroup = document.getElementById('boardContextActions');
    if (contextGroup) {
      const actionable = Array.from(contextGroup.querySelectorAll('button'))
        .some(button => !button.hidden);
      contextGroup.hidden = !selectionMode || !actionable;
    }

    // Empty Manual boards need authoring entry points, not line styling or
    // exporters. Those controls return as soon as there is Board content.
    const lineSettings = document.querySelector('.board-line-settings');
    if (lineSettings) lineSettings.hidden = isAuto || empty || (!!selectedImage && state.tool === 'select');
    setBoardToolbarHidden(el.toolEraser, isAuto || imageCount === 0);
    const exportWrap = document.getElementById('exportMenuWrap');
    if (exportWrap) exportWrap.hidden = isAuto || empty;

    const activeArrow = selectedAnnotation ? getArrowType(selectedAnnotation) : state.arrowType;
    const arrowButton = document.getElementById('arrowMenuBtn');
    if (arrowButton) {
      const label = activeArrow === 'single' ? 'Single' : activeArrow === 'none' ? 'None' : 'Double';
      arrowButton.textContent = 'Arrow: ' + label;
    }
    const activeColor = selectedAnnotation ? normalizeColorKey(selectedAnnotation.color) : state.drawColor;
    const colorButton = document.getElementById('colorMenuBtn');
    const colorLabel = document.getElementById('colorMenuLabel');
    if (colorButton) colorButton.dataset.color = activeColor;
    if (colorLabel) colorLabel.textContent = activeColor.charAt(0).toUpperCase() + activeColor.slice(1);

    // A mode/page transition never leaves a detached popup floating over the
    // newly active controls.
    for (const record of boardToolbarMenuRecords()) {
      if (record.wrap.hidden || record.wrap.offsetParent === null) {
        record.list.hidden = true;
        record.button.setAttribute('aria-expanded', 'false');
      }
    }
  }
