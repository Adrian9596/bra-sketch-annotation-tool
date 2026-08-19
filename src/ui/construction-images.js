// Construction working sheets (US-078, ADR 0045) — working-board image
// management: lookup, reflow, upload/paste, zoom, delete, and the bitmap
// stores that live outside history state.
// Source part for app.js. Run `npm run build` after editing.
//
// Image bytes live outside history state (ccImageDataById/ccImageElementById)
// and are injected only for save/autosave, matching BOM's image ownership
// model. See construction-state.js for the state.construction schema and the
// serialize/load round trip that reads these maps.

  const ccImageDataById = new Map();
  const ccImageElementById = new Map();

  function ccImages(sheet, view) {
    return ensureConstruction().images[ccSheetKey(sheet)][ccViewKey(view)];
  }

  function ccImageById(id, sheet, view) {
    const views = view ? [ccViewKey(view)] : CC_VIEWS;
    for (const candidate of views) {
      const found = ccImages(sheet, candidate).find(image => image.id === id);
      if (found) return found;
    }
    return null;
  }

  function ccImageRuntime(id) {
    return ccImageElementById.get(id) || null;
  }

  function ccReflowImagesIn(model, sheet, view) {
    const images = model.images[sheet][view];
    const commonHeight = 300;
    const gap = 28;
    let x = 0;
    images.forEach(image => {
      image.height = commonHeight;
      image.width = commonHeight * (image.aspect || 1);
      image.x = x;
      image.y = 0;
      x += image.width + gap;
    });
  }

  function ccReflowImages(sheet, view) {
    ccReflowImagesIn(ensureConstruction(), ccSheetKey(sheet), ccViewKey(view));
  }

  async function ccAddImagesFromDataURLs(dataURLs, sheet, view) {
    const sheetKey = ccSheetKey(sheet);
    const viewKey = ccViewKey(view);
    const images = ccImages(sheetKey, viewKey);
    let added = 0;
    for (const dataURL of dataURLs || []) {
      if (!dataURL) continue;
      const img = await loadImageFromDataURL(dataURL);
      const id = state.idCounter++;
      const aspect = img.height > 0 ? img.width / img.height : 1;
      images.push({ id, x: 0, y: 0, width: 300 * aspect, height: 300, aspect, locked: false });
      ccImageDataById.set(id, dataURL);
      ccImageElementById.set(id, img);
      added += 1;
    }
    if (!added) return 0;
    ccReflowImages(sheetKey, viewKey);
    ccActiveView = viewKey;
    ccSelectedImageId = null;
    ccSelectedCalloutId = null;
    ccSetTool('select');
    renderConstruction();
    pushHistoryIfChanged();
    showToast(added + ' image' + (added === 1 ? '' : 's') + ' added to ' + sheetKey.toUpperCase() + ' · ' + viewKey.toUpperCase());
    return added;
  }

  async function ccAddImageFiles(files, sheet, view) {
    const imageFiles = Array.from(files || []).filter(file => file && /^image\//i.test(file.type || ''));
    if (!imageFiles.length) {
      showToast('Add PNG, JPEG, or WebP images to the Construction working board.');
      return 0;
    }
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    return ccAddImagesFromDataURLs(dataURLs, sheet, view);
  }

  function ccDeleteSelectedImage() {
    const image = ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    if (!image) { showToast('Select an image in the active Construction panel first.'); return; }
    const linked = ccVisibleCallouts().filter(callout => callout.imageId === image.id);
    if (linked.length && !window.confirm('Delete this image and its ' + linked.length + ' linked callout(s)?\n\nUndo restores both.')) return;
    const images = ccImages(ccSheet, ccActiveView);
    images.splice(images.indexOf(image), 1);
    if (linked.length) {
      const ids = new Set(linked.map(callout => callout.id));
      state.construction.callouts = state.construction.callouts.filter(callout => !ids.has(callout.id));
    }
    ccSelectedImageId = null;
    ccSelectedCalloutId = null;
    ccReflowImages(ccSheet, ccActiveView);
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccZoomSelectedImage(factor) {
    const image = ccImageById(ccSelectedImageId, ccSheet, ccActiveView);
    if (!image) { showToast('Select an image in the active Construction panel first.'); return; }
    const nextWidth = clamp(image.width * factor, 60, 1800);
    const nextHeight = nextWidth / (image.aspect || 1);
    const cx = image.x + image.width / 2, cy = image.y + image.height / 2;
    image.width = nextWidth;
    image.height = nextHeight;
    image.x = cx - nextWidth / 2;
    image.y = cy - nextHeight / 2;
    renderConstruction();
    pushHistoryIfChanged();
  }

  function ccImageBounds(sheet, view) {
    const images = ccImages(sheet, view);
    if (!images.length) return { x: 0, y: 0, width: 1, height: 1 };
    const minX = Math.min(...images.map(image => image.x));
    const minY = Math.min(...images.map(image => image.y));
    const maxX = Math.max(...images.map(image => image.x + image.width));
    const maxY = Math.max(...images.map(image => image.y + image.height));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  function ccImageAt(view, worldPoint) {
    const images = ccImages(ccSheet, view);
    for (let i = images.length - 1; i >= 0; i -= 1) {
      const image = images[i];
      if (worldPoint.x >= image.x && worldPoint.x <= image.x + image.width
        && worldPoint.y >= image.y && worldPoint.y <= image.y + image.height) return image;
    }
    return null;
  }
