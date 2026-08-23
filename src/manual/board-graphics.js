// US-095 / ADR 0054: non-measurement Board Graphics and path topology.
// Board Graphics deliberately live outside state.annotations: nothing in the
// POM/spec/grading/learning/Excel path reads this collection.

  const BG_MIN_CREATE_SCREEN_PX = 8;
  const BG_KAPPA = 0.5522847498307936;

  function bgPoint(x, y) { return { x: Number(x) || 0, y: Number(y) || 0 }; }
  function bgClonePoint(p) { return bgPoint(p && p.x, p && p.y); }
  function bgNextId(prefix) { return prefix + '-' + (state.idCounter++); }

  function getBoardGraphicById(id) {
    return (state.graphics || []).find(g => g.id === id) || null;
  }

  function getSelectedBoardGraphic() {
    return state.selection.kind === 'graphic' ? getBoardGraphicById(state.selection.id) : null;
  }

  function bgNormalizeNode(raw) {
    const point = bgClonePoint(raw && raw.point);
    return {
      id: String(raw && raw.id || bgNextId('bgn')),
      point,
      handleIn: bgClonePoint(raw && raw.handleIn || point),
      handleOut: bgClonePoint(raw && raw.handleOut || point),
      segmentType: raw && raw.segmentType === 'curve' ? 'curve' : 'line',
    };
  }

  function normalizeBoardGraphic(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = ['rectangle', 'circle', 'hexagon'].includes(raw.shapeKind) ? raw.shapeKind : 'rectangle';
    const mode = raw.mode === 'path' ? 'path' : 'live';
    const live = raw.live || {};
    const graphic = {
      id: raw.id != null ? raw.id : bgNextId('bg'),
      shapeKind: kind,
      mode,
      color: normalizeColorKey(raw.color || 'red'),
      lineWidth: normalizeLineWidth(raw.lineWidth),
      sourceImageId: raw.sourceImageId == null ? null : raw.sourceImageId,
      live: mode === 'live' ? {
        center: bgClonePoint(live.center),
        width: Math.max(1, Number(live.width) || 1),
        height: Math.max(1, Number(live.height) || 1),
      } : null,
      subpaths: [],
    };
    if (mode === 'path') {
      graphic.subpaths = (Array.isArray(raw.subpaths) ? raw.subpaths : []).map(sp => ({
        id: String(sp && sp.id || bgNextId('bgsp')),
        closed: !!(sp && sp.closed),
        nodes: (Array.isArray(sp && sp.nodes) ? sp.nodes : []).map(bgNormalizeNode),
      })).filter(sp => sp.nodes.length >= 2);
    }
    return graphic;
  }

  function normalizeBoardGraphics(list) {
    return (Array.isArray(list) ? list : []).map(normalizeBoardGraphic).filter(Boolean);
  }

  function bgBoxFromDrag(kind, start, current, shiftKey, altKey) {
    let dx = current.x - start.x;
    let dy = current.y - start.y;
    if (shiftKey || kind === 'circle' || kind === 'hexagon') {
      const side = Math.min(Math.abs(dx), Math.abs(dy));
      dx = (dx < 0 ? -1 : 1) * side;
      dy = (dy < 0 ? -1 : 1) * side;
    }
    let x1 = start.x, y1 = start.y, x2 = start.x + dx, y2 = start.y + dy;
    if (altKey) { x1 = start.x - dx; y1 = start.y - dy; }
    return {
      x: Math.min(x1, x2), y: Math.min(y1, y2),
      width: Math.abs(x2 - x1), height: Math.abs(y2 - y1),
    };
  }

  function bgTopImageAt(point) {
    for (let i = state.images.length - 1; i >= 0; i -= 1) {
      const im = state.images[i];
      if (point.x >= im.x && point.x <= im.x + im.width && point.y >= im.y && point.y <= im.y + im.height) return im;
    }
    return null;
  }

  function createBoardGraphicFromDrag(kind, start, current, shiftKey, altKey) {
    const box = bgBoxFromDrag(kind, start, current, shiftKey, altKey);
    if (Math.max(box.width, box.height) * state.zoom < BG_MIN_CREATE_SCREEN_PX) return null;
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const owner = bgTopImageAt(center);
    return normalizeBoardGraphic({
      id: bgNextId('bg'), shapeKind: kind, mode: 'live', color: state.drawColor,
      lineWidth: state.lineWidth, sourceImageId: owner ? owner.id : null,
      live: { center, width: box.width, height: box.height },
    });
  }

  function bgNode(point, segmentType, handleIn, handleOut) {
    return bgNormalizeNode({ id: bgNextId('bgn'), point, segmentType, handleIn: handleIn || point, handleOut: handleOut || point });
  }

  function convertBoardGraphicToPath(graphic) {
    if (!graphic || graphic.mode === 'path' || !graphic.live) return false;
    const c = graphic.live.center, w = graphic.live.width, h = graphic.live.height;
    const rx = w / 2, ry = h / 2;
    let nodes;
    if (graphic.shapeKind === 'circle') {
      nodes = [
        bgNode({ x: c.x, y: c.y - ry }, 'curve', { x: c.x - BG_KAPPA * rx, y: c.y - ry }, { x: c.x + BG_KAPPA * rx, y: c.y - ry }),
        bgNode({ x: c.x + rx, y: c.y }, 'curve', { x: c.x + rx, y: c.y - BG_KAPPA * ry }, { x: c.x + rx, y: c.y + BG_KAPPA * ry }),
        bgNode({ x: c.x, y: c.y + ry }, 'curve', { x: c.x + BG_KAPPA * rx, y: c.y + ry }, { x: c.x - BG_KAPPA * rx, y: c.y + ry }),
        bgNode({ x: c.x - rx, y: c.y }, 'curve', { x: c.x - rx, y: c.y + BG_KAPPA * ry }, { x: c.x - rx, y: c.y - BG_KAPPA * ry }),
      ];
    } else if (graphic.shapeKind === 'hexagon') {
      nodes = [];
      const radius = Math.min(rx, ry);
      for (let i = 0; i < 6; i += 1) {
        const a = -Math.PI / 2 + i * Math.PI / 3;
        const p = { x: c.x + Math.cos(a) * radius, y: c.y + Math.sin(a) * radius };
        nodes.push(bgNode(p, 'line'));
      }
    } else {
      nodes = [
        bgNode({ x: c.x - rx, y: c.y - ry }, 'line'),
        bgNode({ x: c.x + rx, y: c.y - ry }, 'line'),
        bgNode({ x: c.x + rx, y: c.y + ry }, 'line'),
        bgNode({ x: c.x - rx, y: c.y + ry }, 'line'),
      ];
    }
    graphic.mode = 'path';
    graphic.live = null;
    graphic.subpaths = [{ id: bgNextId('bgsp'), closed: true, nodes }];
    return true;
  }

  function bgSegments(graphic) {
    const out = [];
    if (!graphic) return out;
    if (graphic.mode === 'live') {
      const pathCopy = normalizeBoardGraphic(clone(graphic));
      convertBoardGraphicToPath(pathCopy);
      graphic = pathCopy;
    }
    for (const subpath of graphic.subpaths || []) {
      const nodes = subpath.nodes || [];
      const count = subpath.closed ? nodes.length : nodes.length - 1;
      for (let i = 0; i < count; i += 1) {
        const a = nodes[i], b = nodes[(i + 1) % nodes.length];
        if (!a || !b) continue;
        out.push({ subpath, index: i, a, b, type: a.segmentType === 'curve' ? 'curve' : 'line' });
      }
    }
    return out;
  }

  function bgBezierPoint(seg, t) {
    if (seg.type !== 'curve') return { x: seg.a.point.x + (seg.b.point.x - seg.a.point.x) * t, y: seg.a.point.y + (seg.b.point.y - seg.a.point.y) * t };
    return bezierPoint(seg.a.point, seg.a.handleOut, seg.b.handleIn, seg.b.point, t);
  }

  function bgNearestOnSegment(seg, world) {
    const samples = seg.type === 'curve' ? 48 : 1;
    let best = null, prev = seg.a.point;
    for (let i = 1; i <= samples; i += 1) {
      const next = bgBezierPoint(seg, i / samples);
      const dx = next.x - prev.x, dy = next.y - prev.y, l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((world.x - prev.x) * dx + (world.y - prev.y) * dy) / l2)) : 0;
      const q = { x: prev.x + dx * u, y: prev.y + dy * u };
      const d = Math.hypot(world.x - q.x, world.y - q.y);
      if (!best || d < best.distance) best = { distance: d, t: (i - 1 + u) / samples, point: bgBezierPoint(seg, (i - 1 + u) / samples) };
      prev = next;
    }
    return best;
  }

  function hitTestBoardGraphics(world) {
    const tolerance = 9 / state.zoom;
    const graphics = state.graphics || [];
    for (let i = graphics.length - 1; i >= 0; i -= 1) {
      const graphic = graphics[i];
      for (const seg of bgSegments(graphic)) {
        if (bgNearestOnSegment(seg, world).distance <= tolerance) return { id: graphic.id };
      }
    }
    return null;
  }

  function hitTestGraphicEdit(world, graphic) {
    if (!graphic || graphic.mode !== 'path') return null;
    const nodeRadius = 9 / state.zoom, handleRadius = 8 / state.zoom;
    const active = state.graphicEdit && state.graphicEdit.active;
    if (active && active.kind === 'segment') {
      const sp = (graphic.subpaths || []).find(x => x.id === active.subpathId);
      const node = sp && sp.nodes.find(n => n.id === active.startNodeId);
      const next = sp && sp.nodes[(sp.nodes.indexOf(node) + 1) % sp.nodes.length];
      if (node && next && node.segmentType === 'curve') {
        if (Math.hypot(world.x - node.handleOut.x, world.y - node.handleOut.y) <= handleRadius) return { kind: 'handleOut', subpathId: sp.id, nodeId: node.id };
        if (Math.hypot(world.x - next.handleIn.x, world.y - next.handleIn.y) <= handleRadius) return { kind: 'handleIn', subpathId: sp.id, nodeId: next.id };
      }
    }
    for (const sp of graphic.subpaths || []) for (const node of sp.nodes || []) {
      if (Math.hypot(world.x - node.point.x, world.y - node.point.y) <= nodeRadius) return { kind: 'node', subpathId: sp.id, nodeId: node.id };
    }
    let best = null;
    for (const seg of bgSegments(graphic)) {
      const near = bgNearestOnSegment(seg, world);
      if ((!best || near.distance < best.distance) && near.distance <= 9 / state.zoom) {
        best = { kind: 'segment', subpathId: seg.subpath.id, startNodeId: seg.a.id, t: near.t, distance: near.distance };
      }
    }
    return best;
  }

  function bgBounds(graphic) {
    if (!graphic) return null;
    if (graphic.mode === 'live' && graphic.live) return { x: graphic.live.center.x - graphic.live.width / 2, y: graphic.live.center.y - graphic.live.height / 2, width: graphic.live.width, height: graphic.live.height };
    const pts = [];
    for (const sp of graphic.subpaths || []) for (const n of sp.nodes || []) pts.push(n.point, n.handleIn, n.handleOut);
    if (!pts.length) return null;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, width: Math.max(1, Math.max(...xs) - x), height: Math.max(1, Math.max(...ys) - y) };
  }

  function bgHitResizeHandle(world, graphic) {
    const b = bgBounds(graphic); if (!b) return null;
    const corners = [
      { name:'nw', x:b.x, y:b.y }, { name:'ne', x:b.x+b.width, y:b.y },
      { name:'se', x:b.x+b.width, y:b.y+b.height }, { name:'sw', x:b.x, y:b.y+b.height },
    ];
    return corners.find(p => Math.hypot(world.x-p.x, world.y-p.y) <= 9/state.zoom) || null;
  }

  function bgOppositeCorner(bounds, name) {
    return {
      x: name.includes('w') ? bounds.x + bounds.width : bounds.x,
      y: name.includes('n') ? bounds.y + bounds.height : bounds.y,
    };
  }

  function bgResizeFromCorner(graphic, interaction, world, shiftKey, altKey) {
    const start = interaction.startBounds, origin = interaction.origin;
    if (!graphic || !start || !origin) return;
    let sx = Math.abs(world.x-origin.x) / Math.max(1,start.width);
    let sy = Math.abs(world.y-origin.y) / Math.max(1,start.height);
    if (graphic.mode === 'live' && (shiftKey || graphic.shapeKind !== 'rectangle')) sx = sy = Math.min(sx, sy);
    if (shiftKey && graphic.mode === 'path') sx = sy = Math.min(sx, sy);
    sx = Math.max(0.05, sx); sy = Math.max(0.05, sy);
    const source = normalizeBoardGraphic(interaction.startGraphic);
    Object.assign(graphic, source);
    const scaleOrigin = altKey ? {x:start.x+start.width/2,y:start.y+start.height/2} : origin;
    bgScaleAbout(graphic, scaleOrigin, sx, sy);
  }

  function bgMoveEditPart(graphic, hit, target) {
    if (!graphic || !hit) return false;
    const sp = (graphic.subpaths || []).find(x => x.id === hit.subpathId);
    const node = sp && sp.nodes.find(n => n.id === hit.nodeId);
    if (!node) return false;
    if (hit.kind === 'node') {
      const dx=target.x-node.point.x, dy=target.y-node.point.y;
      node.point=bgClonePoint(target); node.handleIn.x+=dx;node.handleIn.y+=dy;node.handleOut.x+=dx;node.handleOut.y+=dy;
    } else if (hit.kind === 'handleIn') node.handleIn=bgClonePoint(target);
    else if (hit.kind === 'handleOut') node.handleOut=bgClonePoint(target);
    else return false;
    return true;
  }

  function bgMove(graphic, dx, dy) {
    if (!graphic || (!dx && !dy)) return;
    if (graphic.mode === 'live') { graphic.live.center.x += dx; graphic.live.center.y += dy; return; }
    for (const sp of graphic.subpaths || []) for (const n of sp.nodes || []) for (const key of ['point', 'handleIn', 'handleOut']) { n[key].x += dx; n[key].y += dy; }
  }

  function bgScaleAbout(graphic, origin, sx, sy) {
    if (!graphic || !origin || !Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const scale = p => { p.x = origin.x + (p.x - origin.x) * sx; p.y = origin.y + (p.y - origin.y) * sy; };
    if (graphic.mode === 'live') {
      scale(graphic.live.center);
      graphic.live.width = Math.max(1, graphic.live.width * Math.abs(sx));
      graphic.live.height = Math.max(1, graphic.live.height * Math.abs(sy));
      if (graphic.shapeKind !== 'rectangle') {
        const side = Math.min(graphic.live.width, graphic.live.height);
        graphic.live.width = side; graphic.live.height = side;
      }
      return;
    }
    for (const sp of graphic.subpaths || []) for (const n of sp.nodes || []) for (const key of ['point', 'handleIn', 'handleOut']) scale(n[key]);
  }

  function bgOwnedByImage(imageId) { return (state.graphics || []).filter(g => g.sourceImageId === imageId); }

  function scaleOwnedGraphicsForImageResize(imageId, origin, factor) {
    if (!Number.isFinite(factor) || factor <= 0 || Math.abs(factor-1)<1e-9) return;
    for (const graphic of bgOwnedByImage(imageId)) bgScaleAbout(graphic, origin, factor, factor);
  }

  function bgEnterEdit(graphic) {
    if (!graphic) return false;
    const changed = convertBoardGraphicToPath(graphic);
    state.graphicEdit = { graphicId: graphic.id, active: null };
    if (changed) pushHistoryIfChanged();
    updateUI(); requestRender();
    return true;
  }

  function bgExitEdit() {
    if (!state.graphicEdit) return false;
    state.graphicEdit = null; updateUI(); requestRender(); return true;
  }

  function bgFindActive(graphic) {
    const active = state.graphicEdit && state.graphicEdit.graphicId === graphic.id ? state.graphicEdit.active : null;
    if (!active) return null;
    const subpath = (graphic.subpaths || []).find(sp => sp.id === active.subpathId);
    if (!subpath) return null;
    const nodeIndex = active.nodeId ? subpath.nodes.findIndex(n => n.id === active.nodeId) : -1;
    const segmentIndex = active.startNodeId ? subpath.nodes.findIndex(n => n.id === active.startNodeId) : -1;
    return { active, subpath, nodeIndex, segmentIndex };
  }

  function bgInsertNodeOnSegment(subpath, segmentIndex, t) {
    const nodes = subpath.nodes, a = nodes[segmentIndex], b = nodes[(segmentIndex + 1) % nodes.length];
    if (!a || !b) return -1;
    const safe = Math.max(0.001, Math.min(0.999, Number(t) || 0.5));
    let node;
    if (a.segmentType === 'curve') {
      const split = subdivideCubicBezier(a.point, a.handleOut, b.handleIn, b.point, safe);
      a.handleOut = bgClonePoint(split.left[1]);
      b.handleIn = bgClonePoint(split.right[2]);
      node = bgNode(split.left[3], 'curve', split.left[2], split.right[1]);
    } else {
      const p = { x: a.point.x + (b.point.x - a.point.x) * safe, y: a.point.y + (b.point.y - a.point.y) * safe };
      node = bgNode(p, 'line');
    }
    nodes.splice(segmentIndex + 1, 0, node);
    return segmentIndex + 1;
  }

  function bgCutNode(graphic, subpath, index) {
    const nodes = subpath.nodes;
    if (!nodes[index]) return false;
    if (!subpath.closed && (index === 0 || index === nodes.length - 1)) return false;
    if (subpath.closed) {
      const rotated = nodes.slice(index).concat(nodes.slice(0, index));
      const first = rotated[0];
      const last = bgNormalizeNode({ id: bgNextId('bgn'), point: first.point, handleIn: first.handleIn, handleOut: first.point, segmentType: 'line' });
      first.handleIn = bgClonePoint(first.point);
      rotated.push(last);
      subpath.nodes = rotated;
      subpath.closed = false;
      state.graphicEdit.active = { kind: 'node', subpathId: subpath.id, nodeId: last.id };
      return true;
    }
    const left = nodes.slice(0, index + 1).map(n => bgNormalizeNode(clone(n)));
    const right = nodes.slice(index).map(n => bgNormalizeNode(clone(n)));
    right[0].id = bgNextId('bgn');
    left[left.length - 1].handleOut = bgClonePoint(left[left.length - 1].point);
    left[left.length - 1].segmentType = 'line';
    right[0].handleIn = bgClonePoint(right[0].point);
    subpath.nodes = left;
    const newSubpath = { id: bgNextId('bgsp'), closed: false, nodes: right };
    const at = graphic.subpaths.indexOf(subpath);
    graphic.subpaths.splice(at + 1, 0, newSubpath);
    state.graphicEdit.active = { kind: 'node', subpathId: newSubpath.id, nodeId: right[0].id };
    return true;
  }

  function cutSelectedBoardGraphicPath() {
    const graphic = getSelectedBoardGraphic();
    const found = graphic && bgFindActive(graphic);
    if (!found || !['node', 'segment'].includes(found.active.kind)) { showToast('Select a path node or segment first.'); return false; }
    let index = found.nodeIndex;
    if (found.active.kind === 'segment') index = bgInsertNodeOnSegment(found.subpath, found.segmentIndex, found.active.t);
    if (index < 0 || !bgCutNode(graphic, found.subpath, index)) { showToast('That point is already an open endpoint.'); return false; }
    pushHistoryIfChanged(); updateUI(); requestRender(); showToast('Path cut — subpaths remain one Board Graphic.');
    return true;
  }

  function bgSetActiveSegmentType(type) {
    const graphic = getSelectedBoardGraphic(), found = graphic && bgFindActive(graphic);
    if (!found || found.active.kind !== 'segment' || found.segmentIndex < 0) return false;
    const node = found.subpath.nodes[found.segmentIndex];
    if (node.segmentType === type) return false;
    const next = found.subpath.nodes[(found.segmentIndex + 1) % found.subpath.nodes.length];
    node.segmentType = type;
    if (type === 'line') { node.handleOut = bgClonePoint(node.point); next.handleIn = bgClonePoint(next.point); }
    else {
      node.handleOut = { x: node.point.x + (next.point.x - node.point.x) / 3, y: node.point.y + (next.point.y - node.point.y) / 3 };
      next.handleIn = { x: next.point.x - (next.point.x - node.point.x) / 3, y: next.point.y - (next.point.y - node.point.y) / 3 };
    }
    pushHistoryIfChanged(); updateUI(); requestRender(); return true;
  }

  function drawBoardGraphicPath(graphic) {
    for (const sp of (graphic.mode === 'path' ? graphic.subpaths : [])) {
      const nodes = sp.nodes || []; if (nodes.length < 2) continue;
      ctx.beginPath(); ctx.moveTo(nodes[0].point.x, nodes[0].point.y);
      const count = sp.closed ? nodes.length : nodes.length - 1;
      for (let i = 0; i < count; i += 1) {
        const a = nodes[i], b = nodes[(i + 1) % nodes.length];
        if (a.segmentType === 'curve') ctx.bezierCurveTo(a.handleOut.x, a.handleOut.y, b.handleIn.x, b.handleIn.y, b.point.x, b.point.y);
        else ctx.lineTo(b.point.x, b.point.y);
      }
      ctx.stroke();
    }
  }

  function drawBoardGraphic(graphic, alpha) {
    if (!graphic) return;
    ctx.save(); ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.strokeStyle = LINE_COLORS[normalizeColorKey(graphic.color)] || LINE_COLOR;
    ctx.lineWidth = normalizeLineWidth(graphic.lineWidth) / featureZoom();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash([]);
    if (graphic.mode === 'live') {
      const b = bgBounds(graphic); ctx.beginPath();
      if (graphic.shapeKind === 'circle') ctx.arc(b.x + b.width / 2, b.y + b.height / 2, Math.min(b.width, b.height) / 2, 0, Math.PI * 2);
      else if (graphic.shapeKind === 'hexagon') {
        const c = graphic.live.center, r = Math.min(graphic.live.width, graphic.live.height) / 2;
        for (let i = 0; i < 6; i += 1) { const a = -Math.PI / 2 + i * Math.PI / 3, p = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }; if (!i) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); } ctx.closePath();
      } else ctx.rect(b.x, b.y, b.width, b.height);
      ctx.stroke();
    } else drawBoardGraphicPath(graphic);
    ctx.restore();
  }

  function drawBoardGraphics() { for (const graphic of (state.graphics || [])) drawBoardGraphic(graphic); }

  function bgDrawHandle(p, active, square) {
    const r = (active ? 5 : 4) / state.zoom;
    ctx.save(); ctx.fillStyle = active ? '#356dff' : '#fff'; ctx.strokeStyle = '#356dff'; ctx.lineWidth = 1.5 / state.zoom; ctx.beginPath();
    if (square) ctx.rect(p.x - r, p.y - r, r * 2, r * 2); else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke(); ctx.restore();
  }

  function drawBoardGraphicSelection(graphic) {
    if (!graphic) return;
    const editing = state.graphicEdit && state.graphicEdit.graphicId === graphic.id;
    if (!editing) {
      const b = bgBounds(graphic); if (!b) return;
      ctx.save(); ctx.strokeStyle = 'rgba(53,109,255,.75)'; ctx.lineWidth = 1.2 / state.zoom; ctx.setLineDash([5 / state.zoom, 4 / state.zoom]); ctx.strokeRect(b.x, b.y, b.width, b.height); ctx.restore();
      for (const p of [{x:b.x,y:b.y},{x:b.x+b.width,y:b.y},{x:b.x+b.width,y:b.y+b.height},{x:b.x,y:b.y+b.height}]) bgDrawHandle(p, false, true);
      return;
    }
    const active = state.graphicEdit.active;
    for (const sp of graphic.subpaths || []) for (const node of sp.nodes || []) bgDrawHandle(node.point, !!(active && active.kind === 'node' && active.nodeId === node.id), true);
    const found = bgFindActive(graphic);
    if (found && found.active.kind === 'segment' && found.segmentIndex >= 0) {
      const a = found.subpath.nodes[found.segmentIndex], b = found.subpath.nodes[(found.segmentIndex + 1) % found.subpath.nodes.length];
      if (a.segmentType === 'curve') {
        ctx.save(); ctx.strokeStyle = 'rgba(53,109,255,.5)'; ctx.lineWidth = 1 / state.zoom; ctx.setLineDash([5/state.zoom,4/state.zoom]); ctx.beginPath(); ctx.moveTo(a.point.x,a.point.y);ctx.lineTo(a.handleOut.x,a.handleOut.y);ctx.moveTo(b.point.x,b.point.y);ctx.lineTo(b.handleIn.x,b.handleIn.y);ctx.stroke();ctx.restore();
        bgDrawHandle(a.handleOut, false, false); bgDrawHandle(b.handleIn, false, false);
      }
    }
  }

  function drawBoardGraphicPreview() {
    const inter = state.interaction;
    if (!inter || inter.type !== 'draw-graphic') return;
    const box = bgBoxFromDrag(inter.kind, inter.startWorld, inter.currentWorld, inter.shiftKey, inter.altKey);
    const temp = normalizeBoardGraphic({ id: 'preview', shapeKind: inter.kind, mode:'live', color:state.drawColor, lineWidth:state.lineWidth, live:{center:{x:box.x+box.width/2,y:box.y+box.height/2},width:box.width,height:box.height} });
    drawBoardGraphic(temp, 0.65);
  }
