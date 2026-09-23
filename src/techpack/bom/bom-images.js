// BOM page — Material Key image board: the per-variant image records, their
// bitmap-byte stores, and upload/paste/reflow/zoom/delete (US-072, ADR
// 0041). Source part for app.js. Run `npm run build` after editing. Loads
// after bom-state.js (ensureBom/bmVariantImages) and before bom-canvas.js,
// which draws these images and hit-tests against them. Mirrors
// construction-images.js one-for-one — the two boards are a deliberate fork,
// not shared code.

  // Bitmap bytes deliberately live outside state.bom. History snapshots clone
  // state.bom frequently; embedding base64 there would duplicate every BOM
  // image for every cell edit. Project save injects the bytes, project load
  // extracts them again (the same split used by Board images/imageDataById).
  const bmImageDataById = new Map();
  const bmImageElementById = new Map();

  function bmImageById(id, variant) {
    return bmVariantImages(variant).find(im => im.id === id) || null;
  }

  function bmImageBounds(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return { x: 0, y: 0, width: 1, height: 1 };
    const minX = Math.min(...images.map(im => im.x));
    const minY = Math.min(...images.map(im => im.y));
    const maxX = Math.max(...images.map(im => im.x + im.width));
    const maxY = Math.max(...images.map(im => im.y + im.height));
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }

  function bmReflowImages(variant) {
    const images = bmVariantImages(variant);
    if (!images.length) return;
    const commonHeight = 300;
    const gap = 30;
    let x = 0;
    images.forEach(image => {
      image.height = commonHeight;
      image.width = commonHeight * (image.aspect || 1);
      image.x = x;
      image.y = 0;
      x += image.width + gap;
    });
  }

  async function bmAddImagesFromDataURLs(dataURLs, variant) {
    const key = bmVariantKey(variant);
    const images = bmVariantImages(key);
    let added = 0;
    for (const dataURL of dataURLs || []) {
      if (!dataURL) continue;
      const img = await loadImageFromDataURL(dataURL);
      const id = state.idCounter++;
      const aspect = img.height > 0 ? img.width / img.height : 1;
      images.push({ id, x: 0, y: 0, width: 300 * aspect, height: 300, aspect, locked: false });
      bmImageDataById.set(id, dataURL);
      bmImageElementById.set(id, img);
      added += 1;
    }
    if (!added) return 0;
    bmReflowImages(key);
    bmSelectedImageId = null;
    bmSelectedCalloutId = null;
    if (bmTool === 'leader') bmTool = 'select';
    renderBom();
    pushHistoryIfChanged();
    showToast(added === 1
      ? '1 image added to the ' + key.toUpperCase() + ' Material Key.'
      : added + ' images added to the ' + key.toUpperCase() + ' Material Key.');
    return added;
  }

  async function bmAddImageFiles(files, variant) {
    const imageFiles = Array.from(files || []).filter(file => file && /^image\//i.test(file.type || ''));
    if (!imageFiles.length) {
      showToast('Add PNG, JPEG, or WebP images to the Material Key.');
      return 0;
    }
    const dataURLs = [];
    for (const file of imageFiles) dataURLs.push(await blobToDataURL(file));
    return bmAddImagesFromDataURLs(dataURLs, variant);
  }

  function bmDeleteSelectedImage() {
    const image = bmImageById(bmSelectedImageId);
    if (!image) { showToast('Select a Material Key image first.'); return; }
    const linked = bmVisibleCallouts().filter(callout => callout.imageId === image.id);
    if (linked.length && !window.confirm(
      'Delete this image and its ' + linked.length + ' linked material callout(s)?\n\nUndo restores both.'
    )) return;
    const images = bmVariantImages();
    images.splice(images.indexOf(image), 1);
    if (linked.length) {
      const ids = new Set(linked.map(callout => callout.id));
      state.bom.callouts = state.bom.callouts.filter(callout => !ids.has(callout.id));
    }
    bmSelectedImageId = null;
    bmSelectedCalloutId = null;
    bmReflowImages();
    renderBom();
    pushHistoryIfChanged();
  }

  function bmZoomSelectedImage(factor) {
    const image = bmImageById(bmSelectedImageId);
    if (!image) { showToast('Select a Material Key image first.'); return; }
    const nextWidth = clamp(image.width * factor, 60, 1800);
    const nextHeight = nextWidth / (image.aspect || (image.width / image.height) || 1);
    const cx = image.x + image.width / 2;
    const cy = image.y + image.height / 2;
    image.width = nextWidth;
    image.height = nextHeight;
    image.x = cx - nextWidth / 2;
    image.y = cy - nextHeight / 2;
    renderBom();
    pushHistoryIfChanged();
  }
