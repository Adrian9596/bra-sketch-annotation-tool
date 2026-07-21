// PowerPoint (.pptx) import: ZIP parsing, slide picture extraction, picker UI.
// Source part for app.js. Run `npm run build` after editing.
//
// A .pptx is a ZIP container with one xml per slide and embedded media under
// ppt/media/. extractSlidesFromPptx pulls the largest pictures from each
// slide (skipping tiny logo/icon art), groupEntriesBySlide collapses them
// into per-page rows, and openPptxPicker lets the TD choose which pages to
// import. The ZIP reader at the bottom is hand-rolled so the app stays
// dependency-free.

  async function onPptxFileChosen(e) {
    const input = e.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    await processPptxFile(file);
  }

  async function processPptxFile(file) {
    el.importPptxBtn.disabled = true;
    const prevLabel = el.importPptxBtn.textContent;
    el.importPptxBtn.textContent = 'Importing…';
    try {
      const buffer = await file.arrayBuffer();
      const entries = await extractSlidesFromPptx(buffer);
      if (!entries.length) {
        showToast('No usable sketch images were found in that deck.', 4200);
        return;
      }
      // Group images by their source slide so each picker choice is a whole
      // page: a slide with several pictures imports all of them together.
      const pages = groupEntriesBySlide(entries);
      if (pages.length === 1) {
        await addImagesFromDataURLs(pages[0].dataURLs);
        return;
      }
      openPptxPicker(pages);
    } catch (error) {
      console.error(error);
      showToast('Could not read that .pptx file. It may be corrupt or use an unsupported format.', 4600);
    } finally {
      el.importPptxBtn.disabled = false;
      el.importPptxBtn.textContent = prevLabel;
    }
  }

  // Collapse per-image entries [{slide, dataURL}] into per-page groups
  // [{slide, dataURLs:[...]}], preserving slide order, so a slide that holds
  // multiple pictures is presented (and imported) as a single page.
  function groupEntriesBySlide(entries) {
    const order = [];
    const bySlide = new Map();
    for (const entry of entries) {
      let page = bySlide.get(entry.slide);
      if (!page) {
        page = { slide: entry.slide, dataURLs: [] };
        bySlide.set(entry.slide, page);
        order.push(page);
      }
      page.dataURLs.push(entry.dataURL);
    }
    return order;
  }

  // Modal that previews every page found in a deck and lets the user import
  // only the ones they want, instead of dumping all slides onto the board.
  function openPptxPicker(pages) {
    const selected = new Set();

    const overlay = document.createElement('div');
    overlay.className = 'picker-overlay';

    const panel = document.createElement('div');
    panel.className = 'picker-panel';
    overlay.appendChild(panel);

    const header = document.createElement('div');
    header.className = 'picker-header';
    const title = document.createElement('h2');
    title.textContent = 'Import pages';
    const sub = document.createElement('span');
    sub.className = 'picker-sub';
    sub.textContent = pages.length + ' pages found — pick the ones to add.';
    header.appendChild(title);
    header.appendChild(sub);
    panel.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'picker-grid';
    panel.appendChild(grid);

    pages.forEach((page, index) => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'picker-cell';
      cell.setAttribute('aria-pressed', 'false');

      const thumb = document.createElement('img');
      thumb.className = 'picker-thumb';
      thumb.src = page.dataURLs[0];
      thumb.alt = 'Slide ' + page.slide;
      cell.appendChild(thumb);

      const cap = document.createElement('span');
      cap.className = 'picker-cap';
      cap.textContent = page.dataURLs.length > 1
        ? 'Slide ' + page.slide + ' · ' + page.dataURLs.length + ' images'
        : 'Slide ' + page.slide;
      cell.appendChild(cap);

      cell.addEventListener('click', () => {
        if (selected.has(index)) {
          selected.delete(index);
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
        updateFooter();
      });
      grid.appendChild(cell);
    });

    const footer = document.createElement('div');
    footer.className = 'picker-footer';
    const selectAllBtn = document.createElement('button');
    selectAllBtn.type = 'button';
    selectAllBtn.className = 'picker-link';
    const count = document.createElement('span');
    count.className = 'picker-count';
    const spacer = document.createElement('span');
    spacer.style.flex = '1';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'picker-btn';
    cancelBtn.textContent = 'Cancel';
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'picker-btn primary';
    footer.appendChild(selectAllBtn);
    footer.appendChild(spacer);
    footer.appendChild(count);
    footer.appendChild(cancelBtn);
    footer.appendChild(importBtn);
    panel.appendChild(footer);

    function updateFooter() {
      const n = selected.size;
      count.textContent = n + ' selected';
      importBtn.disabled = n === 0;
      importBtn.textContent = n === 0 ? 'Import' : 'Import ' + n;
      selectAllBtn.textContent = n === pages.length ? 'Clear all' : 'Select all';
    }

    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    }

    selectAllBtn.addEventListener('click', () => {
      const all = selected.size === pages.length;
      selected.clear();
      Array.from(grid.children).forEach((cell, index) => {
        if (all) {
          cell.classList.remove('selected');
          cell.setAttribute('aria-pressed', 'false');
        } else {
          selected.add(index);
          cell.classList.add('selected');
          cell.setAttribute('aria-pressed', 'true');
        }
      });
      updateFooter();
    });

    cancelBtn.addEventListener('click', close);
    overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);

    importBtn.addEventListener('click', async () => {
      if (!selected.size) return;
      const chosen = Array.from(selected)
        .sort((a, b) => a - b)
        .flatMap(i => pages[i].dataURLs);
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        await addImagesFromDataURLs(chosen);
        close();
      } catch (error) {
        console.error(error);
        showToast('Could not import the selected pages.', 4200);
        importBtn.disabled = false;
        updateFooter();
      }
    });

    updateFooter();
    document.body.appendChild(overlay);
  }

  // A .pptx is a ZIP container. Parse it natively and pull one or more
  // picture images per slide, in slide order, skipping tiny logo/icon art.
  // Returns slide-tagged entries [{slide, dataURL}] so the import picker can
  // show which page each image came from.
  async function extractSlidesFromPptx(buffer) {
    const zip = parseZip(buffer);
    const slideArea = await readSlideArea(zip);
    const minArea = slideArea ? slideArea * 0.03 : 0;

    const slideNames = Object.keys(zip.entries)
      .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => slideNumber(a) - slideNumber(b));

    const entries = [];
    const seenTargets = new Set();

    for (const slideName of slideNames) {
      const xmlText = await readZipEntryText(zip, slideName);
      if (!xmlText) continue;
      const relsName = slideName.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
      const relsText = await readZipEntryText(zip, relsName);
      const relMap = parseRels(relsText);
      const slide = slideNumber(slideName);

      const picks = pickSlidePictures(xmlText, relMap, slideName, minArea);
      for (const target of picks) {
        if (seenTargets.has(target)) continue;
        seenTargets.add(target);
        const dataURL = await mediaTargetToDataURL(zip, target);
        if (dataURL) entries.push({ slide, dataURL });
      }
    }

    // Fallback: deck stores images outside <p:pic> (e.g. backgrounds) — grab raw media.
    if (!entries.length) {
      const mediaNames = Object.keys(zip.entries)
        .filter(name => /^ppt\/media\/[^/]+\.(png|jpe?g|gif|bmp)$/i.test(name))
        .sort((a, b) => slideNumber(a) - slideNumber(b));
      let i = 1;
      for (const name of mediaNames) {
        const dataURL = await mediaTargetToDataURL(zip, name);
        if (dataURL) entries.push({ slide: i++, dataURL });
      }
    }
    return entries;
  }

  function slideNumber(name) {
    const m = name.match(/(\d+)\D*$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  async function readSlideArea(zip) {
    try {
      if (!zip.entries['ppt/presentation.xml']) return 0;
      const text = await readZipEntryText(zip, 'ppt/presentation.xml');
      if (!text) return 0;
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const sz = doc.getElementsByTagName('p:sldSz')[0] || doc.getElementsByTagName('sldSz')[0];
      if (!sz) return 0;
      const cx = parseFloat(sz.getAttribute('cx') || '0');
      const cy = parseFloat(sz.getAttribute('cy') || '0');
      return cx > 0 && cy > 0 ? cx * cy : 0;
    } catch (_) {
      return 0;
    }
  }

  function parseRels(relsText) {
    const map = {};
    if (!relsText) return map;
    const doc = new DOMParser().parseFromString(relsText, 'application/xml');
    const rels = doc.getElementsByTagName('Relationship');
    for (const rel of Array.from(rels)) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (id && target) map[id] = target;
    }
    return map;
  }

  function pickSlidePictures(xmlText, relMap, slideName, minArea) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const pics = Array.from(doc.getElementsByTagName('p:pic'));
    const results = [];
    let largest = null;
    let largestArea = -1;

    for (const pic of pics) {
      const blip = pic.getElementsByTagName('a:blip')[0];
      if (!blip) continue;
      const embed = blip.getAttribute('r:embed') || blip.getAttribute('embed');
      if (!embed || !relMap[embed]) continue;
      const target = resolveRelTarget(relMap[embed], slideName);
      if (!target) continue;

      let area = 0;
      for (const ext of Array.from(pic.getElementsByTagName('a:ext'))) {
        const cx = parseFloat(ext.getAttribute('cx') || '0');
        const cy = parseFloat(ext.getAttribute('cy') || '0');
        area = Math.max(area, cx * cy);
      }
      if (area > largestArea) { largestArea = area; largest = target; }
      if (minArea && area && area < minArea) continue;
      results.push(target);
    }

    // Never drop a slide entirely: if everything was filtered out, keep its biggest picture.
    if (!results.length && largest) results.push(largest);
    return results;
  }

  function resolveRelTarget(target, slideName) {
    if (/^https?:/i.test(target)) return null;
    const baseDir = slideName.replace(/\/[^/]*$/, '/');
    const parts = (baseDir + target).split('/');
    const stack = [];
    for (const part of parts) {
      if (part === '..') stack.pop();
      else if (part !== '.' && part !== '') stack.push(part);
    }
    return stack.join('/');
  }

  async function mediaTargetToDataURL(zip, target) {
    const ext = (target.split('.').pop() || '').toLowerCase();
    const mime = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', bmp: 'image/bmp',
    }[ext];
    if (!mime) return null; // emf/wmf/svg etc. can't be drawn to canvas reliably
    const bytes = await readZipEntryBytes(zip, target);
    if (!bytes) return null;
    return 'data:' + mime + ';base64,' + bytesToBase64(bytes);
  }

  // Minimal ZIP reader (central directory + DEFLATE via DecompressionStream).

  function parseZip(buffer) {
    const dv = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= 0; i -= 1) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid ZIP/.pptx file');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = {};
    for (let n = 0; n < count; n += 1) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8Decode(bytes.subarray(p + 46, p + 46 + nameLen));
      entries[name] = { method, compSize, localOffset };
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { dv, bytes, entries, _cache: {} };
  }

  function entryCompressedBytes(zip, name) {
    const e = zip.entries[name];
    if (!e) return null;
    const lo = e.localOffset;
    if (zip.dv.getUint32(lo, true) !== 0x04034b50) return null;
    const nameLen = zip.dv.getUint16(lo + 26, true);
    const extraLen = zip.dv.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    return { method: e.method, data: zip.bytes.subarray(start, start + e.compSize) };
  }

  async function readZipEntryBytes(zip, name) {
    const raw = entryCompressedBytes(zip, name);
    if (!raw) return null;
    if (raw.method === 0) return raw.data;
    if (raw.method === 8) return await inflateRaw(raw.data);
    throw new Error('Unsupported ZIP compression method ' + raw.method);
  }

  async function readZipEntryText(zip, name) {
    const bytes = await readZipEntryBytes(zip, name);
    return bytes ? utf8Decode(bytes) : '';
  }

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Response(bytes).body.pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8').decode(bytes);
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }
