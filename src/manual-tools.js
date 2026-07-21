// Manual mode: the remaining utilities that the extracted UI / interactions /
// annotation / project / import / render modules depend on. The pure
// format / style / viewport / image-record helper groups now live alongside
// in src/manual/{format,style,viewport,image-records}.js; what remains here
// is the big UI status updater plus paste / drag-drop wiring and a handful
// of POM/annotation helpers that still touch global state directly.
// Source part for app.js. Run `npm run build` after editing.


  function updateUI() {
    el.toolSelect.classList.toggle('active', state.tool === 'select');
    el.toolStraight.classList.toggle('active', state.tool === 'straight');
    el.toolCurved.classList.toggle('active', state.tool === 'curved');
    el.toolEraser.classList.toggle('active', state.tool === 'eraser');
    el.toolEraser.disabled = state.images.length === 0;
    el.lineStyleControl.hidden = state.tool === 'eraser';
    el.lineWidthChip.hidden = state.tool === 'eraser';
    el.brushSizeChip.hidden = state.tool !== 'eraser';
    if (el.brushSizeInput && document.activeElement !== el.brushSizeInput) {
      el.brushSizeInput.value = String(state.brushSize);
    }
    if (el.styleIdInput && document.activeElement !== el.styleIdInput) {
      el.styleIdInput.value = state.styleId || '';
    }
    const annotationCount = state.annotations.length;
    const imageCount = state.images.length;
    const selectedAnnotation = getSelectedAnnotation();
    const selectedImage = getSelectedImage();
    const activeStyle = selectedAnnotation ? getLineStyle(selectedAnnotation) : state.drawStyle;
    const activeColor = selectedAnnotation ? normalizeColorKey(selectedAnnotation.color) : state.drawColor;
    const activeArrowType = selectedAnnotation ? getArrowType(selectedAnnotation) : state.arrowType;
    const activeLineWidth = getActiveLineWidth();
    updateLineStyleControl(activeStyle);
    if (el.lineWidthInput && document.activeElement !== el.lineWidthInput) {
      el.lineWidthInput.value = formatLineWidth(activeLineWidth);
    }
    el.arrowDoubleBtn.classList.toggle('active', activeArrowType === 'double');
    el.arrowSingleBtn.classList.toggle('active', activeArrowType === 'single');
    el.arrowNoneBtn.classList.toggle('active', activeArrowType === 'none');
    el.colorRedBtn.classList.toggle('active', activeColor === 'red');
    el.colorBlueBtn.classList.toggle('active', activeColor === 'blue');
    el.colorBlackBtn.classList.toggle('active', activeColor === 'black');
    el.colorWhiteBtn.classList.toggle('active', activeColor === 'white');

    el.stitchesBtn.disabled = false;
    el.arrowDoubleBtn.disabled = false;
    el.arrowSingleBtn.disabled = false;
    el.arrowNoneBtn.disabled = false;

    let toolText = '';
    if (state.tool === 'select') {
      if (selectedAnnotation) {
        toolText = 'Select – Drag line, endpoints, curve shape handle, or label. <span class="kbd">Tab</span> picks a point, arrow keys nudge it (<span class="kbd">⇧</span> = 10 px).';
      } else if (selectedImage) {
        toolText = 'Select – Drag the image to move it, drag a corner handle to resize, use wheel to zoom, or hold <span class="kbd">Space</span> to pan.';
      } else {
        toolText = 'Select – Click an image, line, or label to select. Use wheel to zoom, double-click to fit, or hold <span class="kbd">Space</span> to pan.';
      }
    } else if (state.tool === 'straight') {
      toolText = state.drawSession
        ? 'Straight Line – Click second point to finish.'
        : 'Straight Line – Click first point.';
    } else if (state.tool === 'curved') {
      toolText = !state.drawSession
        ? 'Curved Line – Click the start point.'
        : (state.drawSession.mid == null
            ? 'Curved Line – Click the middle point the curve passes through.'
            : 'Curved Line – Click the end point to finish.');
    } else {
      toolText = imageCount === 0
        ? 'Eraser – Paste or import an image first, then drag to paint white over unwanted lines.'
        : (state.eraseSession
            ? 'Eraser – Release to commit. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.'
            : 'Eraser – Drag on the image to paint white over unwanted lines. <span class="kbd">[</span>/<span class="kbd">]</span> resize brush.');
    }
    el.toolStatus.innerHTML = '<strong>Tool:</strong> ' + toolText;

    const modeTitle = isStitchMode()
      ? 'Stitch mode: callout numbers are hidden so the stitch styles read clearly.'
      : 'POM mode (Point of Measure): each callout is numbered and linked to the measurement table.';
    const modeTag = '<strong>Mode:</strong> <span class="mode-tag" title="' + modeTitle + '">' + (isStitchMode() ? 'Stitch' : 'POM') + '</span> &nbsp;•&nbsp; ';
    let boardHtml;
    if (imageCount > 0) {
      boardHtml = '<strong>Board:</strong> ' + imageCount + ' image' + (imageCount === 1 ? '' : 's') + ' • ' + annotationCount + ' line' + (annotationCount === 1 ? '' : 's');
      el.boardCard.classList.remove('no-image');
    } else {
      boardHtml = annotationCount > 0
        ? '<strong>Board:</strong> <span class="muted">No image loaded • Press <span class="kbd">Ctrl/Cmd + V</span> to paste</span> • ' + annotationCount + ' line' + (annotationCount === 1 ? '' : 's')
        : '<strong>Board:</strong> <span class="muted">No image loaded • Press <span class="kbd">Ctrl/Cmd + V</span> to paste</span>';
      el.boardCard.classList.add('no-image');
    }
    el.boardCard.classList.toggle('is-empty', imageCount === 0 && annotationCount === 0);
    el.imageStatus.innerHTML = modeTag + boardHtml;

    el.countStatus.innerHTML = '<strong>Images:</strong> ' + imageCount + ' &nbsp;•&nbsp; <strong>Annotations:</strong> ' + annotationCount;
    el.deleteBtn.disabled = !(selectedAnnotation || (selectedImage && !selectedImage.locked));
    const lineActionsEnabled = state.appMode !== 'auto';
    el.copyLineBtn.disabled = !(selectedAnnotation && lineActionsEnabled);
    el.reflectLineBtn.disabled = !(selectedAnnotation && lineActionsEnabled);
    el.pasteLineBtn.disabled = !(hasLineClipboard() && lineActionsEnabled);
    el.saveProjectBtn.disabled = annotationCount === 0 && imageCount === 0;
    el.clearBtn.disabled = annotationCount === 0;
    el.fitBtn.disabled = imageCount === 0;
    // Lock toggle reflects the selected image's state. Without a selection
    // the button is disabled (no image to lock); with one, the label flips
    // between "Lock" and "Unlock" and the icon swaps closed/open.
    el.lockImageBtn.disabled = !selectedImage;
    if (selectedImage) {
      const locked = !!selectedImage.locked;
      el.lockImageLabel.textContent = locked ? 'Unlock' : 'Lock';
      el.lockImageBtn.title = locked
        ? 'Unlock the selected image so it can be moved, resized, or deleted again'
        : 'Lock the selected image so it can\'t be moved, resized, or deleted accidentally';
      el.lockImageBtn.classList.toggle('active', locked);
      // Swap the lock icon glyph: closed (default) vs open (shows when locked).
      el.lockImageIco.innerHTML = locked
        ? '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" />'
        : '<rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" />';
    } else {
      el.lockImageLabel.textContent = 'Lock';
      el.lockImageBtn.classList.remove('active');
    }
    el.undoBtn.disabled = state.history.past.length <= 1;
    el.redoBtn.disabled = state.history.future.length === 0;
    el.setScaleBtn.disabled = !selectedAnnotation;
    el.setScaleBtn.classList.toggle('active', state.calibration.unitsPerPx != null);
    el.clearScaleBtn.disabled = state.calibration.unitsPerPx == null;
    el.toggleLabelsBtn.textContent = state.showLabels ? 'Hide Numbers' : 'Show Numbers';
    el.toggleLabelsBtn.classList.toggle('active', !state.showLabels);
    // In Stitch mode numbers are hidden by the mode itself, so the manual
    // toggle has nothing to act on.
    el.toggleLabelsBtn.disabled = isStitchMode();

    updateAutoModeUI();
    renderSpecPanel();
    // US-038: keep the floating anchor panel in sync (fresh detect, mode
    // switch, canvas pin selection). renderAnchorManagerPanel auto-closes it
    // when we leave Auto Mode or lose anchors.
    if (isAnchorManagerOpen()) renderAnchorManagerPanel();
  }

  // U4: friendly copy for the raw auto.status machine states shown in the
  // toolbar chip. The raw value stays on dataset.status and in
  // state.autoMode.status (CSS hooks + __braAutoModeDebug.getState()), so
  // tests and styling are untouched — only the visible text is humanized.
  const AUTO_STATUS_COPY = {
    idle: 'Add a sketch to start',
    ready: 'Sketch ready — click Detect',
    loading: 'Loading…',
    detecting: 'Detecting sketch…',
    detected: 'Check the pins, then Generate',
    reviewing: 'Drafts waiting — review below',
    applying: 'Applying lines…',
    error: 'Needs attention',
  };

  // U4: which of the three pass steps is done / active for a given status.
  // 'active' means "this is your next step", so idle/ready point at Detect.
  function autoStepStates(status) {
    switch (status) {
      case 'detecting':
        return { detect: 'active', generate: 'todo', review: 'todo' };
      case 'detected':
        return { detect: 'done', generate: 'active', review: 'todo' };
      case 'reviewing':
      case 'applying':
      case 'error':
        return { detect: 'done', generate: 'done', review: 'active' };
      default: // idle / ready / loading
        return { detect: 'active', generate: 'todo', review: 'todo' };
    }
  }

  function updateAutoModeUI() {
    const isAuto = state.appMode === 'auto';
    // Mode switch buttons
    el.modeManualBtn.classList.toggle('active', !isAuto);
    el.modeAutoBtn.classList.toggle('active', isAuto);

    // Lock manual creation/edit tools while in Auto Mode.
    el.toolStraight.disabled = isAuto;
    el.toolCurved.disabled = isAuto;
    if (isAuto) {
      el.toolEraser.disabled = true;
      // US-052: Delete in Auto Mode removes a selected PHOTO only (annotations/
      // drafts use Discard Drafts / Review-Only). Enable it when a non-locked
      // image is selected so an added photo can be removed without Reset Board.
      const selImg = getSelectedImage();
      el.deleteBtn.disabled = !(selImg && !selImg.locked);
      el.clearBtn.disabled = true;
    }

    if (!isAuto) {
      el.autoStatusChip.dataset.status = 'idle';
      el.autoStatusChip.textContent = AUTO_STATUS_COPY.idle;
      return;
    }

    const auto = state.autoMode;
    const draftCount = auto.draftAnnotations.length;
    const approvedCount = auto.draftAnnotations.filter(d => d.tdApproved && !isReviewOnlyDraft(d)).length;
    const hasSource = !!pickAutoSourceImage();

    el.autoStatusChip.dataset.status = auto.status;
    el.autoStatusChip.textContent = AUTO_STATUS_COPY[auto.status] || auto.status;
    el.autoStatusChip.title = auto.status === 'error' && auto.lastError
      ? auto.lastError
      : 'Auto Mode status';

    // U4: reflect the pass position in the Detect → Generate → Review steps.
    if (el.autoStepIndicator) {
      const stepStates = autoStepStates(auto.status);
      for (const stepEl of el.autoStepIndicator.children) {
        stepEl.dataset.state = stepStates[stepEl.dataset.step] || 'todo';
      }
    }

    // S1: vision-engine readiness chip (OpenCV WASM warm-up watcher).
    if (el.visionEngineChip) {
      const engine = state.visionEngine || 'warming';
      el.visionEngineChip.dataset.engine = engine;
      el.visionEngineChip.textContent =
        engine === 'ready' ? '✓ vision ready'
          : engine === 'warming' ? 'vision warming…'
            : 'basic vision';
      el.visionEngineChip.title =
        engine === 'ready'
          ? 'OpenCV vision engine compiled — Detect uses the highest-quality backend.'
          : engine === 'warming'
            ? 'The OpenCV vision engine is still compiling in the background. Keep working — Detect will use the best engine available when clicked.'
            : 'OpenCV engine unavailable — Detect uses the built-in fallback detector.';
    }

    // U5: reveal the Approve / Review-Only / Apply / Discard controls only
    // when they are actionable — a failed apply (status 'error') or drafts
    // lingering in the Auto layer (e.g. REVIEW_ONLY rows after returning
    // from Manual). The happy path auto-applies inside Generate and never
    // needs them.
    if (el.autoModeBar) {
      el.autoModeBar.classList.toggle('recovery', auto.status === 'error' || draftCount > 0);
    }

    const busy = auto.status === 'loading' || auto.status === 'applying' || auto.status === 'detecting';
    const hasAnchors = auto.anchors.length > 0;

    el.autoDetectBtn.disabled = busy;
    el.autoDetectBtn.title = hasSource
      ? 'Run local offline vision on the source sketch to estimate view, landmarks, and anchors'
      : 'No image on the board — add or select an image first, then click Detect Sketch';

    el.autoResetAnchorsBtn.disabled = busy || !auto.detection;
    el.autoResetAnchorsBtn.title = auto.detection
      ? 'Re-seed anchors from the current detection (discards manual anchor edits)'
      : 'Run Detect Sketch first';

    el.autoGenerateBtn.disabled = busy || !hasAnchors;
    el.autoGenerateBtn.title = hasAnchors
      ? 'Generate 18 POM drafts from the current anchor positions'
      : 'Detect Sketch + place anchors first';

    const selectedDraft = getSelectedDraft();
    el.autoApproveBtn.disabled = !selectedDraft || isReviewOnlyDraft(selectedDraft) || selectedDraft.tdApproved;
    el.autoReviewOnlyBtn.disabled = !selectedDraft || isReviewOnlyDraft(selectedDraft);
    el.autoApplyBtn.disabled = approvedCount === 0 || auto.status === 'applying';
    el.autoDiscardBtn.disabled = draftCount === 0;
    el.autoResetBoardBtn.disabled = busy || isWorkingBoardEmpty();

    // Learning loop controls: toggle reflects the persisted flag, chip
    // exposes the running sample count (the "measurable" property),
    // reset is only enabled when there is something to clear.
    const learningOn = isLearningEnabled();
    const learningSamples = getLearningSampleCount();
    el.autoLearnToggleBtn.classList.toggle('active', learningOn);
    el.autoLearnToggleBtn.title = learningOn
      ? 'Learning is ON — applies median calibration after Detect Sketch. Click to turn off.'
      : 'Learning is OFF — Detect Sketch uses pure geometric rules. Click to turn on.';
    el.autoLearnChip.textContent = learningSamples + ' sample' + (learningSamples === 1 ? '' : 's');
    el.autoLearnChip.dataset.status = learningOn && learningSamples >= 5 ? 'detected' : 'idle';
    if (el.learningToolbarBtn) {
      el.learningToolbarBtn.classList.toggle('active', learningOn);
      el.learningToolbarBtn.textContent = learningOn ? 'Learning On' : 'Learning Off';
      el.learningToolbarBtn.title = learningOn
        ? 'Learning is ON — click to view learning data. Correct Auto lines, then Save project + evidence.'
        : 'Click to turn learning on before correcting Auto lines.';
    }
    if (el.learningToolbarChip) {
      el.learningToolbarChip.textContent = learningSamples + ' sample' + (learningSamples === 1 ? '' : 's');
      el.learningToolbarChip.dataset.status = learningOn && learningSamples >= 5 ? 'detected' : 'idle';
      el.learningToolbarChip.title = learningOn
        ? 'Recorded TD correction samples used by learning.'
        : 'Learning is off. Click Learning Off to start collecting corrections.';
    }
    if (el.autoAcceptanceChip) {
      const acceptance = getAutoAcceptanceStats();
      const accepted = acceptance.acceptedWithoutEdit || 0;
      const total = acceptance.totalApplied || 0;
      const rate = total > 0 ? Math.round(accepted / total * 100) : 0;
      el.autoAcceptanceChip.textContent = accepted + '/' + total + ' accepted';
      el.autoAcceptanceChip.title = total > 0
        ? 'Auto-applied POM lines accepted without edit: ' + accepted + ' of ' + total + ' (' + rate + '%).'
        : 'No Auto-applied POM lines have been tracked yet.';
    }

    // Menu items reflect what is actually present.
    const styleId = currentStyleId();
    const currentMeaningCount = listConfirmedMeanings(styleId).length;
    let totalMeaningCount = 0;
    for (const sid of listKnownStyleIds()) {
      totalMeaningCount += listConfirmedMeanings(sid).length;
    }
    if (el.resetResidualsItem) {
      el.resetResidualsItem.disabled = learningSamples === 0;
      el.resetResidualsItem.textContent = 'Reset calibration residuals (' + learningSamples + ')';
    }
    if (el.resetMeaningsCurrentItem) {
      el.resetMeaningsCurrentItem.disabled = currentMeaningCount === 0;
      const styleLabel = styleId === '__default__' ? 'default bucket' : 'style "' + styleId + '"';
      el.resetMeaningsCurrentItem.textContent = 'Forget POM meanings — ' + styleLabel + ' (' + currentMeaningCount + ')';
    }
    if (el.resetMeaningsAllItem) {
      el.resetMeaningsAllItem.disabled = totalMeaningCount === 0;
      el.resetMeaningsAllItem.textContent = 'Forget POM meanings — all styles (' + totalMeaningCount + ')';
    }
    if (el.manageMeaningsItem) {
      el.manageMeaningsItem.disabled = currentMeaningCount === 0;
    }
  }

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function inferNextIdCounter() {
    let max = 0;
    for (const ann of state.annotations) max = Math.max(max, Number(ann.id) || 0);
    for (const image of state.images) max = Math.max(max, Number(image.id) || 0);
    for (const draft of state.autoMode.draftAnnotations) max = Math.max(max, Number(draft.id) || 0);
    return max + 1;
  }


  async function onPasteEvent(e) {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type && item.type.startsWith('image/'));
    if (!imageItems.length) return;
    e.preventDefault();
    const dataURLs = [];
    for (const imageItem of imageItems) {
      const blob = imageItem.getAsFile();
      if (!blob) continue;
      dataURLs.push(await blobToDataURL(blob));
    }
    if (dataURLs.length) {
      await addImagesFromDataURLs(dataURLs);
    }
  }

  async function addImagesFromDataURLs(dataURLs) {
    const baseCount = state.images.length;
    let added = 0;

    for (let batchIndex = 0; batchIndex < dataURLs.length; batchIndex += 1) {
      const dataURL = dataURLs[batchIndex];
      const img = await loadImageFromDataURL(dataURL);
      const imageRecord = createImageRecord(img, dataURL, baseCount + batchIndex);
      state.images.push(imageRecord);
      state.selection = { kind: 'image', id: imageRecord.id };
      recordAutoTelemetryEvent('image_loaded', {
        sourceImageId: imageRecord.id,
        sketch_id: imageRecord.id,
        image_width: img.width,
        image_height: img.height,
      });
      added += 1;
    }

    // Adding a source image changes the Auto Mode status preconditions
    // (idle -> ready). updateUI only RENDERS state.autoMode.status; it does
    // not derive it, so recompute here — the same settled-transition
    // treatment discard / reset-board / open-project already get. Without
    // this the chip stays 'idle' until Detect jumps it straight to
    // 'detected', so 'ready' is never shown on the normal path.
    ensureAutoModeStatus();

    // Re-fit the board to frame ALL images after any add (not just the first),
    // so a newly added second/third sketch is guaranteed visible beside the
    // others rather than sitting off-screen or under the existing view.
    if (added > 0 && state.images.length > 0) {
      fitImagesToBoard();
    } else {
      updateUI();
      requestRender();
    }

    pushHistoryIfChanged();
    updateUI();
    requestRender();
    showToast(added === 1 ? '1 image added to the board.' : added + ' images added to the board.');
  }

  async function onImageFileChosen(e) {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = '';
    const imageFiles = files.filter((f) => f.type && f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    await addImagesFromDataURLs(dataURLs);
  }

  // ---- Drag & drop import ----
  function setupDragAndDrop() {
    const card = el.boardCard;
    if (!card) return;
    let dragDepth = 0;

    const draggingFiles = (e) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

    card.addEventListener('dragenter', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      card.classList.add('drag-over');
    });
    card.addEventListener('dragover', (e) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    card.addEventListener('dragleave', (e) => {
      if (!draggingFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) card.classList.remove('drag-over');
    });
    card.addEventListener('drop', async (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepth = 0;
      card.classList.remove('drag-over');
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) await handleDroppedFiles(files);
    });
  }

  async function handleDroppedFiles(files) {
    const imageFiles = files.filter((f) => f.type && f.type.startsWith('image/'));
    const pptxFiles = files.filter((f) =>
      /\.pptx$/i.test(f.name || '') ||
      f.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );

    if (imageFiles.length) {
      const dataURLs = [];
      for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
      await addImagesFromDataURLs(dataURLs);
    }
    // Import the first dropped deck (the picker handles one deck at a time).
    if (pptxFiles.length) await processPptxFile(pptxFiles[0]);

    if (!imageFiles.length && !pptxFiles.length) {
      showToast('Drop an image or a .pptx file to add it to the board.', 3600);
    }
  }

  // True when start/end land in different detected view boxes (front vs back).
  // POM 16 (apex distance) can span the gap between sketches; rendering those
  // cross-view lines dashed prevents misreading them as measurements inside a
  // single view.
  function annotationCrossesViews(ann) {
    if (!ann || !ann.sourceImageId || !ann.start || !ann.end) return false;
    const det = state.autoMode && state.autoMode.detection;
    if (!det || det.sourceImageId !== ann.sourceImageId) return false;
    const boxes = det.viewBoxes;
    if (!Array.isArray(boxes) || boxes.length < 2) return false;
    const image = getImageById(ann.sourceImageId);
    if (!image || !image.width || !image.height) return false;
    const findViewIdx = (p) => {
      const nx = (p.x - image.x) / image.width;
      const ny = (p.y - image.y) / image.height;
      let best = -1;
      let bestArea = Infinity;
      for (let i = 0; i < boxes.length; i += 1) {
        const b = boxes[i];
        if (b == null) continue;
        if (nx >= b.x && nx <= b.x + b.width && ny >= b.y && ny <= b.y + b.height) {
          const area = b.width * b.height;
          if (area < bestArea) { bestArea = area; best = i; }
        }
      }
      return best;
    };
    const a = findViewIdx(ann.start);
    const b = findViewIdx(ann.end);
    if (a < 0 || b < 0) return false;
    return a !== b;
  }

  function getLabelText(ann) {
    if (ann && ann.text != null && String(ann.text).trim() !== '') return String(ann.text);
    return String(ann.seq);
  }

  function lineLength(ann) {
    if (ann.type === 'straight') return distance(ann.start, ann.end);
    return polylineLength(getAnnotationPolyline(ann, BEZIER_SAMPLES * 2));
  }

  // Map a callout label ("8", "1,2") to POM standard info. Joins descriptions for
  // multi-POM labels; returns a reference value only when a single POM is matched.
  function getPomInfo(labelText) {
    const text = String(labelText == null ? '' : labelText).trim();
    if (!text) return { desc: '', refL: null, zh: '' };
    const nums = text.split(/[,\s]+/).filter(Boolean);
    // Custom POMs (17+, US-011) resolve from the project registry with the
    // same shape as template entries; refL stays null (no standard value).
    const infoFor = (n) => {
      if (POM_TEMPLATE[n]) return POM_TEMPLATE[n];
      const custom = customPomEntry(n);
      return custom ? { desc: custom.en || '', zh: custom.zh || '', refL: null } : null;
    };
    const descs = [];
    const zhs = [];
    for (const n of nums) {
      const info = infoFor(n);
      if (info) {
        descs.push(info.desc);
        if (info.zh) zhs.push(info.zh);
      }
    }
    const single = nums.length === 1 ? infoFor(nums[0]) : null;
    return {
      desc: descs.join('; '),
      refL: single ? single.refL : null,
      zh: zhs.join('；'),
    };
  }

  function getAnnotationById(id) {
    const hit = state.annotations.find(a => a.id === id);
    if (hit) return hit;
    // Draft annotations live outside state.annotations but share the same id
    // space, so drag/handle interaction handlers can look them up too.
    const draft = state.autoMode.draftAnnotations.find(a => a.id === id);
    return draft || null;
  }

  function isAutoDraft(ann) {
    return !!(ann && ann.auto === true && ann.sourceMode === 'auto-mode' && ann.autoRunId);
  }

  function isReviewOnlyDraft(ann) {
    return !!(ann && ann.drawability === 'REVIEW_ONLY');
  }

  function createUniqueAnnotationId() {
    return state.idCounter++;
  }

  function getImageById(id) {
    return state.images.find(image => image.id === id) || null;
  }
