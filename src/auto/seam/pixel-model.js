// US-109 Auto Seam — pixel model shared by both lanes: background estimate,
// foreground mask, luma, gradients, the quantized foreground colour
// histogram the input classifier reads, garment eligibility (coverage, box,
// trusted center axis), and the small point/sampling helpers built on it.
// Pure: image in, plain objects out. Source part for app.js.

  function autoSeamQuantileFromHistogram(histogram, total, quantile) {
    const target = Math.max(0, Math.min(total - 1, Math.floor(total * quantile)));
    let seen = 0;
    for (let index = 0; index < histogram.length; index += 1) {
      seen += histogram[index];
      if (seen > target) return index;
    }
    return histogram.length - 1;
  }

  function autoSeamPercentile(values, fraction) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  }

  // US-120: this part runs in two places — app.js on the main thread and
  // auto-seam-worker.js inside a Web Worker, where there is no document. Use
  // the DOM canvas whenever one exists so the main-thread path draws exactly
  // as it did before the worker existed; only a worker gets OffscreenCanvas.
  function autoSeamCreateCanvas(width, height) {
    if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    }
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
    throw new Error('no canvas implementation available for the Auto Seam pixel model');
  }

  // US-120: the two scaled reads the pipeline performs — router.js builds the
  // coarse 640 px model, lanes/technical-flat.js the 1600 px native model.
  // The worker client pre-reads exactly these on the main thread; a new
  // dimension added elsewhere without updating this list makes the worker
  // throw (no decoded image to draw), which the client reports as
  // `worker-failed` and auto-seam-worker-check turns into a hard failure.
  var AUTO_SEAM_WORKER_PIXEL_DIMENSIONS = [640, 1600];

  // Scaled RGBA of the source at `maxDimension`, either pre-read
  // (sourceImage.pixels[maxDimension], produced by THIS function on the main
  // thread and transferred to the worker) or drawn now from sourceImage.img.
  // Pre-read pixels win, so the worker never resamples: resampling an
  // ImageBitmap on an OffscreenCanvas was measured to differ from the DOM
  // canvas draw by ~1e-3 in every 640 px feature (see US-120 execplan note),
  // which would break the byte-identical contract with the main thread.
  function autoSeamReadPixels(sourceImage, maxDimension) {
    const pre = sourceImage && sourceImage.pixels && sourceImage.pixels[maxDimension];
    if (pre && pre.rgba && pre.width > 0 && pre.height > 0) return pre;
    const img = sourceImage && sourceImage.img;
    if (!img) throw new Error('source image is not decoded');
    const naturalWidth = img.naturalWidth || img.width;
    const naturalHeight = img.naturalHeight || img.height;
    if (!(naturalWidth > 0 && naturalHeight > 0)) throw new Error('source image has no usable dimensions');
    const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(48, Math.round(naturalWidth * scale));
    const height = Math.max(48, Math.round(naturalHeight * scale));
    const canvas = autoSeamCreateCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(img, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    return { maxDimension, naturalWidth, naturalHeight, width, height, rgba };
  }

  function autoSeamPixelModel(sourceImage, maxDimension = 640) {
    const { naturalWidth, naturalHeight, width, height, rgba } = autoSeamReadPixels(sourceImage, maxDimension);
    const luma = new Float32Array(width * height);

    const corner = Math.max(3, Math.round(Math.min(width, height) * 0.045));
    const cornerSamples = [];
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (!((x < corner || x >= width - corner) && (y < corner || y >= height - corner))) continue;
        const offset = (y * width + x) * 4;
        cornerSamples.push([rgba[offset], rgba[offset + 1], rgba[offset + 2]]);
      }
    }
    const bg = [0, 1, 2].map(channel => cornerSamples.reduce((sum, rgb) => sum + rgb[channel], 0) / Math.max(1, cornerSamples.length));
    const bgLuma = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2];
    const backgroundSpread = Math.sqrt(cornerSamples.reduce((sum, rgb) => {
      const dr = rgb[0] - bg[0], dg = rgb[1] - bg[1], db = rgb[2] - bg[2];
      return sum + (dr * dr + dg * dg + db * db) / 3;
    }, 0) / Math.max(1, cornerSamples.length));
    const distanceThreshold = Math.max(26, Math.min(72, backgroundSpread * 3.2));

    const mask = new Uint8Array(width * height);
    const xHist = new Uint32Array(width);
    const yHist = new Uint32Array(height);
    // Quantized (5 bits/channel) colour histogram of the foreground. A vector
    // fill lands almost entirely in one bin; photographed fabric never does.
    const colourHistogram = new Uint32Array(32768);
    let maskCount = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        const offset = index * 4;
        const r = rgba[offset], g = rgba[offset + 1], b = rgba[offset + 2];
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        luma[index] = lum;
        const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
        const distanceFromBackground = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
        const foreground = distanceFromBackground > distanceThreshold
          || (bgLuma > 215 && lum < bgLuma - 34);
        if (!foreground) continue;
        mask[index] = 1;
        xHist[x] += 1;
        yHist[y] += 1;
        maskCount += 1;
        colourHistogram[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)] += 1;
      }
    }
    let dominantColourCount = 0;
    for (let bin = 0; bin < colourHistogram.length; bin += 1) {
      if (colourHistogram[bin] > dominantColourCount) dominantColourCount = colourHistogram[bin];
    }
    const dominantForegroundColourShare = maskCount ? dominantColourCount / maskCount : 0;

    const gradient = new Float32Array(width * height);
    const gradientX = new Float32Array(width * height);
    const gradientY = new Float32Array(width * height);
    const garmentGradients = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        const gx = luma[index + 1] - luma[index - 1];
        const gy = luma[index + width] - luma[index - width];
        const magnitude = Math.hypot(gx, gy);
        gradientX[index] = gx;
        gradientY[index] = gy;
        gradient[index] = magnitude;
        if (mask[index] && (x + y) % 3 === 0) garmentGradients.push(magnitude);
      }
    }
    return { naturalWidth, naturalHeight, width, height, luma, gradient, gradientX, gradientY, mask, maskCount, xHist, yHist, bgLuma, backgroundSpread, garmentGradients, dominantForegroundColourShare };
  }

  function autoSeamEligibility(model, options = {}) {
    const { width, height, maskCount, xHist, yHist } = model;
    const coverage = maskCount / (width * height);
    const minimumCoverage = options.minimumCoverage ?? 0.055;
    if (coverage < minimumCoverage) return { eligible: false, code: 'insufficient_garment_mask', coverage };
    if (coverage > 0.78) return { eligible: false, code: 'background_not_separable', coverage };
    const left = autoSeamQuantileFromHistogram(xHist, maskCount, 0.015);
    const right = autoSeamQuantileFromHistogram(xHist, maskCount, 0.985);
    const top = autoSeamQuantileFromHistogram(yHist, maskCount, 0.015);
    const bottom = autoSeamQuantileFromHistogram(yHist, maskCount, 0.985);
    const boxWidth = right - left;
    const boxHeight = bottom - top;
    if (boxWidth < width * 0.36 || boxHeight < height * 0.28) {
      return { eligible: false, code: 'materially_cropped_or_incomplete', coverage };
    }

    const lowerStart = Math.round(top + boxHeight * 0.42);
    const lowerEnd = Math.min(height, Math.round(top + boxHeight * 0.88));
    let weightedX = 0, weightedCount = 0;
    for (let y = lowerStart; y < lowerEnd; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (!model.mask[y * width + x]) continue;
        weightedX += x;
        weightedCount += 1;
      }
    }
    const boxCenter = (left + right) / 2;
    const axis = weightedCount ? boxCenter * 0.65 + (weightedX / weightedCount) * 0.35 : boxCenter;
    let leftMass = 0, rightMass = 0;
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) {
        if (!model.mask[y * width + x]) continue;
        if (x < axis) leftMass += 1;
        else rightMass += 1;
      }
    }
    const symmetryRatio = Math.max(leftMass, rightMass) / Math.max(1, Math.min(leftMass, rightMass));
    if (axis / width < 0.34 || axis / width > 0.66 || symmetryRatio > 2.6) {
      return { eligible: false, code: 'untrusted_center_axis_or_oblique_view', coverage, symmetryRatio };
    }
    return {
      eligible: true,
      coverage,
      symmetryRatio,
      centerAxisX: axis / width,
      bounds: { left: left / width, right: right / width, top: top / height, bottom: bottom / height },
      pixelBounds: { left, right, top, bottom, width: boxWidth, height: boxHeight },
    };
  }

  function autoSeamLocalPoint(bounds, x, y) {
    return { x: bounds.left + x * bounds.width, y: bounds.top + y * bounds.height };
  }

  function autoSeamSampleAt(array, width, height, point) {
    const x = Math.max(0, Math.min(width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(point.y)));
    return array[y * width + x];
  }

  function autoSeamNormalizePoint(model, point) {
    return { x: autoSeamClamp01(point.x / model.width), y: autoSeamClamp01(point.y / model.height) };
  }
