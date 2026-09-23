// Manual mode image import pipeline: clipboard paste (onPasteEvent),
// addImagesFromDataURLs, the file-input picker (onImageFileChosen), and
// drag-and-drop (setupDragAndDrop, handleDroppedFiles). Must load after
// src/manual/image-records.js (uses createImageRecord, blobToDataURL,
// loadImageFromDataURL). Sibling files: the big UI status updater lives in
// src/manual/ui-status.js; POM/annotation lookup helpers live in
// src/manual/annotation-lookup.js.
// Source part for app.js. Run `npm run build` after editing.

  async function onPasteEvent(e) {
    // Text fields keep native text paste. BOM photo popovers handle their own
    // image paste and stop propagation before this document-level router.
    const target = e.target;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (inField) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter(item => item.type && item.type.startsWith('image/'));
    if (imageItems.length) {
      e.preventDefault();
      const dataURLs = [];
      for (const imageItem of imageItems) {
        const blob = imageItem.getAsFile();
        if (!blob) continue;
        dataURLs.push(await blobToDataURL(blob));
      }
      if (dataURLs.length && state.activePage === 'bom' && typeof bmAddImagesFromDataURLs === 'function') {
        await bmAddImagesFromDataURLs(dataURLs, bmVariant);
      } else if (dataURLs.length) {
        await addImagesFromDataURLs(dataURLs);
      }
      return;
    }
    // No image on the OS clipboard — fall back to the internal board
    // clipboard (a copied line or a copied shape). copySelectedAnnotation /
    // copySelectedGraphic both claim the OS clipboard with a text marker, so
    // whichever was copied LAST wins here, like a real clipboard; between
    // the two internal ones, pasteFromClipboard reads lastBoardClipboardKind
    // to decide. Never hijack a paste aimed at a text field.
    if (inField || state.appMode === 'auto' || (!hasLineClipboard() && !hasGraphicClipboard())) return;
    e.preventDefault();
    pasteFromClipboard();
  }

  async function addImagesFromDataURLs(dataURLs) {
    const baseCount = state.images.length;
    let added = 0;

    for (let batchIndex = 0; batchIndex < dataURLs.length; batchIndex += 1) {
      const dataURL = dataURLs[batchIndex];
      const img = await loadImageFromDataURL(dataURL);
      const imageRecord = createImageRecord(img, dataURL, baseCount + batchIndex);
      state.images.push(imageRecord);
      // Select the new photo as the sole selection. This assigns directly
      // (rather than setSelection, which would updateUI/render every loop
      // iteration), so it must also reset the multi-selection set — otherwise a
      // previously-clicked photo lingers in selectedImageIds and a later plain
      // drag of the new photo moves both together.
      state.selection = { kind: 'image', id: imageRecord.id };
      state.selectedImageIds = [imageRecord.id];
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
