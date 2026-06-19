(function (global) {
  'use strict';

  const VERSION = 'free-opencv-api-20260617';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function imreadFromImage(image, options) {
    const opts = options || {};
    const naturalW = image.naturalWidth || image.width || 0;
    const naturalH = image.naturalHeight || image.height || 0;
    if (!naturalW || !naturalH) throw new Error('image has zero size');

    const targetWidth = Number(opts.targetWidth) || 480;
    const minSize = Number(opts.minSize) || 32;
    const scale = Math.min(1, targetWidth / naturalW);
    const width = Math.max(minSize, Math.round(naturalW * scale));
    const height = Math.max(minSize, Math.round(naturalH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('offscreen canvas unavailable');
    ctx.drawImage(image, 0, 0, width, height);

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (err) {
      throw new Error('cannot read pixels (tainted canvas)');
    }

    return {
      width,
      height,
      scale,
      data: imageData.data,
    };
  }

  function estimateBorderBackground(pixels, width, height) {
    const samples = [];
    const step = Math.max(1, Math.floor(Math.min(width, height) / 40));
    const add = (x, y) => {
      const i = (y * width + x) * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      samples.push({ r, g, b, lum });
    };

    for (let x = 0; x < width; x += step) {
      add(x, 0);
      add(x, height - 1);
    }
    for (let y = 0; y < height; y += step) {
      add(0, y);
      add(width - 1, y);
    }

    if (!samples.length) return { r: 255, g: 255, b: 255, lum: 255 };
    samples.sort((a, b) => a.lum - b.lum);
    const bright = samples.slice(Math.floor(samples.length * 0.60));
    const source = bright.length ? bright : samples;
    let r = 0;
    let g = 0;
    let b = 0;
    let lum = 0;
    for (const s of source) {
      r += s.r;
      g += s.g;
      b += s.b;
      lum += s.lum;
    }
    const n = source.length || 1;
    return { r: r / n, g: g / n, b: b / n, lum: lum / n };
  }

  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let i = 0; i < 256; i += 1) sum += i * hist[i];

    let sumB = 0;
    let wB = 0;
    let maxVar = -1;
    let bestT = 128;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (wB === 0) continue;
      const wF = total - wB;
      if (wF === 0) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const diff = mB - mF;
      const variance = wB * wF * diff * diff;
      if (variance > maxVar) {
        maxVar = variance;
        bestT = t;
      }
    }
    return bestT;
  }

  function buildMaskStats(mask, width, height, bounds) {
    const x0 = bounds ? clamp(Math.floor(bounds.minX), 0, width - 1) : 0;
    const y0 = bounds ? clamp(Math.floor(bounds.minY), 0, height - 1) : 0;
    const x1 = bounds ? clamp(Math.ceil(bounds.maxX), 0, width - 1) : width - 1;
    const y1 = bounds ? clamp(Math.ceil(bounds.maxY), 0, height - 1) : height - 1;
    const colDark = new Uint32Array(width);
    const rowDark = new Uint32Array(height);
    let count = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = y0; y <= y1; y += 1) {
      const rowBase = y * width;
      for (let x = x0; x <= x1; x += 1) {
        if (!mask[rowBase + x]) continue;
        colDark[x] += 1;
        rowDark[y] += 1;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    return { count, minX, minY, maxX, maxY, colDark, rowDark };
  }

  function connectedComponentsWithStats(mask, width, height, minCount) {
    const total = width * height;
    const visited = new Uint8Array(total);
    const output = new Uint8Array(total);
    const queue = new Int32Array(total);
    const components = [];
    let componentCount = 0;

    for (let start = 0; start < total; start += 1) {
      if (!mask[start] || visited[start]) continue;
      componentCount += 1;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let count = 0;
      let minX = width;
      let minY = height;
      let maxX = -1;
      let maxY = -1;
      let sumX = 0;
      let sumY = 0;
      let touches = 0;

      while (head < tail) {
        const idx = queue[head++];
        const x = idx % width;
        const y = Math.floor(idx / width);
        count += 1;
        sumX += x;
        sumY += y;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;

        for (let yy = y - 1; yy <= y + 1; yy += 1) {
          if (yy < 0 || yy >= height) continue;
          const rowBase = yy * width;
          for (let xx = x - 1; xx <= x + 1; xx += 1) {
            if (xx < 0 || xx >= width || (xx === x && yy === y)) continue;
            const next = rowBase + xx;
            if (visited[next] || !mask[next]) continue;
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }

      if (minX === 0) touches += 1;
      if (maxX === width - 1) touches += 1;
      if (minY === 0) touches += 1;
      if (maxY === height - 1) touches += 1;

      const compWidth = maxX - minX + 1;
      const compHeight = maxY - minY + 1;
      const area = Math.max(1, compWidth * compHeight);
      const density = count / area;
      const longStroke = Math.max(compWidth, compHeight) >= Math.min(width, height) * 0.08
        && count >= minCount * 0.45;
      const likelyFrame = touches >= 2 && compWidth > width * 0.82 && compHeight > height * 0.82 && density < 0.10;
      const keep = !likelyFrame && (count >= minCount || longStroke);
      if (!keep) continue;

      for (let i = 0; i < tail; i += 1) output[queue[i]] = 1;
      components.push({
        count,
        minX,
        minY,
        maxX,
        maxY,
        width: compWidth,
        height: compHeight,
        area,
        density,
        cx: sumX / count,
        cy: sumY / count,
        touches,
      });
    }

    return { mask: output, components, componentCount };
  }

  function createInkMaskFromImage(image, options) {
    const sample = imreadFromImage(image, options);
    const { width, height, data } = sample;
    const total = width * height;
    const lumGrid = new Uint8ClampedArray(total);
    const inkGrid = new Uint8ClampedArray(total);
    const lumHist = new Uint32Array(256);
    const inkHist = new Uint32Array(256);
    const background = estimateBorderBackground(data, width, height);

    for (let i = 0, p = 0; p < total; i += 4, p += 1) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const chroma = maxC - minC;
      const bgDiff = Math.max(0, background.lum - lum);
      const colorDiff = Math.hypot(r - background.r, g - background.g, b - background.b);
      const chromaInk = chroma > 18 && lum < background.lum - 6 ? chroma * 0.7 : 0;
      const ink = clamp(Math.round(Math.max(bgDiff, colorDiff * 0.78, chromaInk)), 0, 255);
      lumGrid[p] = lum;
      inkGrid[p] = ink;
      lumHist[lum] += 1;
      inkHist[ink] += 1;
    }

    const otsuInk = otsuThreshold(inkHist, total);
    const otsuLum = otsuThreshold(lumHist, total);
    const threshold = Math.max(22, Math.min(96, otsuInk));
    const luminanceThreshold = Math.max(55, Math.min(190, otsuLum - 8));
    const mask = new Uint8Array(total);

    for (let p = 0; p < total; p += 1) {
      const ink = inkGrid[p];
      const lum = lumGrid[p];
      const localInk = ink >= threshold;
      const darkByLum = lum < luminanceThreshold && background.lum - lum > 18;
      if (localInk || darkByLum || ink > threshold * 1.45) mask[p] = 1;
    }

    return {
      engine: VERSION,
      width,
      height,
      total,
      scale: sample.scale,
      mask,
      stats: buildMaskStats(mask, width, height),
      threshold,
      luminanceThreshold,
      background,
      backgroundLum: Math.round(background.lum),
    };
  }

  global.FreeOpenCVAPI = {
    version: VERSION,
    imreadFromImage,
    estimateBorderBackground,
    otsuThreshold,
    buildMaskStats,
    connectedComponentsWithStats,
    createInkMaskFromImage,
  };
})(window);
