// Manual mode: pure image-record helpers. createImageRecord turns a
// loaded Image into the state.images shape (size, world position, id) and
// stashes the data URL by id; blobToDataURL / loadImageFromDataURL are
// promise wrappers around the matching browser APIs.
// Source part for app.js. Run `npm run build` after editing.

  function createImageRecord(img, dataURL, stackIndex) {
    const rect = state.lastCanvasRect || el.canvas.getBoundingClientRect();
    const aspect = img.height > 0 ? img.width / img.height : 1; // keep proportions

    let width;
    let height;
    let x;
    let y;
    if (state.images.length) {
      // Additional sketch: match the HEIGHT of the photo already on the board
      // (the one this sketch lines up beside) so front / back / side read as
      // one even-height row, regardless of each source photo's native pixel
      // size. Width follows the new photo's own aspect so it is never stretched.
      // Then place it to the RIGHT of everything already on the board (with a
      // gap) — a cascade offset used to drop a 2nd image almost on top of the
      // 1st, which read as "you can't add a second photo."
      const prev = state.images[state.images.length - 1];
      height = prev.height;
      width = height * aspect;
      const bounds = getImagesBounds();
      const gap = Math.max(24, width * 0.12);
      x = bounds.x + bounds.width + gap;
      y = bounds.y; // top-align with the existing row
    } else {
      // First image sets the reference size: fit it to ~42% of the board from
      // its own pixels (never upscaled), centered on the viewport. Later
      // sketches match this height.
      const maxW = Math.max(180, rect.width * 0.42);
      const maxH = Math.max(180, rect.height * 0.42);
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      width = Math.max(60, img.width * scale);
      height = Math.max(60, img.height * scale);
      const centerWorld = screenToWorld(rect.width / 2, rect.height / 2);
      x = centerWorld.x - width / 2;
      y = centerWorld.y - height / 2;
    }

    const id = state.idCounter++;
    imageDataById.set(id, dataURL);
    return { id, dataURL, img, width, height, x, y, locked: false };
  }

  function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  function loadImageFromDataURL(dataURL) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = dataURL;
    });
  }
