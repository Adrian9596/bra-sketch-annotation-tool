// PowerPoint (.pptx) OOXML/slide-XML parsing: pulls picture entries out of
// the slide and relationship XML. Source part for app.js. Run
// `npm run build` after editing.
//
// Split out of src/import/pptx.js. Domain logic specific to PowerPoint's
// XML schema, distinct from the generic ZIP layer below it
// (src/import/zip-reader.js, which it calls into) and the picker UI above
// it (src/ui/dialogs/pptx-picker-dialog.js). Must load after
// src/import/zip-reader.js.

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
