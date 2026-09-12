// Mind Map notes → .xlsx outline.
//
// The Mind Map (vendor/mindmap.html, "Atlas") already exports itself as JSON,
// PNG, SVG and an HTML snapshot. What it has no way to produce is the thing a
// TD actually loses track of: the NOTES. A note lives on a node, is only
// visible after selecting that node and opening the properties panel, and a
// map with sixty notes is therefore sixty hidden documents. This turns the
// whole map into one flat, readable outline — every node in tree order, each
// with its own note, tags and link — in the format this product already
// speaks.
//
// It reads the tool's saved document straight out of localStorage. The
// overlay's iframe uses a relative src and sets no sandbox attribute, so it
// is same-origin and the key is simply shared; nothing here reaches into the
// frame, and the Mind Map does not have to be open. This layer only ever
// READS that key — the tool owns it and autosaves over it every 700 ms, so
// writing behind its back would be a race.
//
// Source part for app.js. Run `npm run build` after editing.

  const MINDMAP_DOC_KEY = 'atlas.mindmap.document.v2';
  const MINDMAP_NOTES_COLS = [7, 46, 20, 72, 30];

  function readMindMapDocument() {
    let raw = null;
    try { raw = localStorage.getItem(MINDMAP_DOC_KEY); } catch (error) { return null; }
    if (!raw) return null;
    let doc = null;
    try { doc = JSON.parse(raw); } catch (error) { return null; }
    if (!doc || !Array.isArray(doc.nodes) || !doc.nodes.length) return null;
    return doc;
  }

  // Depth-first over parentId, in the order the TD sees on the canvas: each
  // sibling group top-to-bottom, then left-to-right, with the node id as the
  // last tie-break so the same map always exports the same rows.
  //
  // Two defences, because this is user data that has been through a JSON
  // round-trip: a node whose parentId names a node that is not in the file is
  // treated as a root rather than silently dropped, and a parent cycle is
  // stopped by the visited set instead of hanging the export.
  function mindMapOutlineRows(doc) {
    const byId = new Map();
    for (const node of doc.nodes) {
      if (node && typeof node.id === 'string') byId.set(node.id, node);
    }
    const children = new Map();
    const roots = [];
    for (const node of byId.values()) {
      const parent = node.parentId && byId.has(node.parentId) ? node.parentId : null;
      if (!parent) { roots.push(node); continue; }
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(node);
    }
    const order = (list) => list.sort((a, b) =>
      (Number(a.y) || 0) - (Number(b.y) || 0)
      || (Number(a.x) || 0) - (Number(b.x) || 0)
      || String(a.id).localeCompare(String(b.id)));
    order(roots);
    for (const list of children.values()) order(list);
    const rows = [];
    const visited = new Set();
    const walk = (node, depth) => {
      if (visited.has(node.id)) return;
      visited.add(node.id);
      rows.push({ depth, node });
      for (const child of (children.get(node.id) || [])) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 1);
    // A pure cycle has no root to enter from; emit whatever is left so the
    // outline can never be quietly shorter than the map.
    for (const node of byId.values()) if (!visited.has(node.id)) walk(node, 1);
    return rows;
  }

  // Atlas's own rule, copied exactly (store.isTreeEdge): an edge is part of
  // the tree when the target's parent IS the source. Everything else is a
  // connection the TD drew on purpose, and it would be lost if the outline
  // only walked the tree.
  function mindMapCrossLinks(doc) {
    const byId = new Map();
    for (const node of doc.nodes) {
      if (node && typeof node.id === 'string') byId.set(node.id, node);
    }
    const out = [];
    for (const edge of (Array.isArray(doc.edges) ? doc.edges : [])) {
      if (!edge) continue;
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      if (!source || !target) continue;
      if (target.parentId === edge.source) continue;
      out.push({ source, target });
    }
    return out;
  }

  function mindMapNodeText(node) {
    return String(node && node.text != null ? node.text : '').replace(/\s+/g, ' ').trim();
  }

  function buildMindMapNotesSheetXml(doc, rows, crossLinks, now) {
    const title = String(doc.title || 'Mind Map').trim() || 'Mind Map';
    const noted = rows.filter(row => String(row.node.note || '').trim()).length;
    const data = [];
    let r = 1;
    const push = (cells, ht) => { data.push({ r, cells, ht }); r += 1; };
    const cell = (col, style, text) => specInlineStrCell(specColLetter(col) + r, style, text);

    push([cell(0, SPEC_XF.title, title + ' — mind map notes')]);
    push([cell(0, SPEC_XF.text, 'Exported ' + formatSpecDate(now)
      + '  ·  ' + rows.length + ' nodes  ·  ' + noted + ' with notes'
      + (crossLinks.length ? '  ·  ' + crossLinks.length + ' extra connections' : ''))]);
    push([]);
    push(['Level', 'Node', 'Tags', 'Note', 'Link'].map((head, i) => cell(i, SPEC_XF.headLabel, head)));

    for (const row of rows) {
      const node = row.node;
      const tags = Array.isArray(node.tags) ? node.tags.filter(Boolean).join(', ') : '';
      const note = String(node.note == null ? '' : node.note).trim();
      const link = String(node.link == null ? '' : node.link).trim();
      // Indent carries the shape of the tree into a flat grid; the Level
      // column keeps the depth sortable/filterable once it is in Excel.
      const label = '    '.repeat(Math.max(0, row.depth - 1)) + (mindMapNodeText(node) || '(empty node)');
      push([
        cell(0, SPEC_XF.textCenter, String(row.depth)),
        cell(1, SPEC_XF.text, label),
        cell(2, SPEC_XF.text, tags),
        cell(3, SPEC_XF.text, note),
        cell(4, SPEC_XF.text, link),
      ]);
    }

    if (crossLinks.length) {
      push([]);
      push([cell(0, SPEC_XF.headLabel, ''), cell(1, SPEC_XF.headLabel, 'Extra connections (not parent → child)')]);
      for (const link of crossLinks) {
        push([
          cell(0, SPEC_XF.textCenter, ''),
          cell(1, SPEC_XF.text, (mindMapNodeText(link.source) || '(empty node)')
            + '  →  ' + (mindMapNodeText(link.target) || '(empty node)')),
        ]);
      }
    }
    return buildTechPackSheetXml(data, MINDMAP_NOTES_COLS, false);
  }

  function makeMindMapNotesFileName(doc, now) {
    const pad = (v) => String(v).padStart(2, '0');
    const slug = (String(doc.title || 'mind-map').trim() || 'mind-map')
      .replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'mind-map';
    return 'mindmap-notes-' + slug + '-'
      + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '.xlsx';
  }

  function buildMindMapNotesXlsxBytes(doc, now) {
    const rows = mindMapOutlineRows(doc);
    const crossLinks = mindMapCrossLinks(doc);
    const sheetXml = buildMindMapNotesSheetXml(doc, rows, crossLinks, now);
    return assembleTechPackZip([{ name: 'MIND MAP NOTES', sheetXml, images: [] }], now);
  }

  function exportMindMapNotes() {
    const doc = readMindMapDocument();
    if (!doc) {
      showToast('No mind map saved on this browser yet — open Mind Map and add a node first.');
      return false;
    }
    const now = new Date();
    const bytes = buildMindMapNotesXlsxBytes(doc, now);
    downloadBlob(new Blob([bytes], { type: SPEC_XLSX_MIME }), makeMindMapNotesFileName(doc, now));
    const count = mindMapOutlineRows(doc).length;
    showToast('Exported ' + count + ' mind map node' + (count === 1 ? '' : 's') + ' with their notes.');
    return true;
  }
