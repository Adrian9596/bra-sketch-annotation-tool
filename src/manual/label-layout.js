// Label-collision-avoidance physics loop for numbered callouts. Called from
// the manual annotation flow and also from src/auto/drafts/generate-pom-fixture.js
// and draft-actions.js, so nudgeAutoLabelsToAvoidCollisions must keep its name
// exactly. Sibling files: annotation builders live in
// src/manual/annotation-factory.js; delete/clear lifecycle lives in
// src/manual/annotation-lifecycle.js; copy/paste/reflect lives in
// src/manual/annotation-clipboard.js.
// Source part for app.js. Run `npm run build` after editing.

  // Numbered callouts cluster at the bra center-front: POMs 1, 5, 6, 7, 8 all
  // fall in the same vertical strip. Nudge labels apart along each line's
  // perpendicular so the numbers stay readable. Skips manually-placed labels.
  function nudgeAutoLabelsToAvoidCollisions(anns) {
    if (!anns || anns.length < 2) return;
    const items = anns.filter(a => a && a.label && !a.labelManual && a.start && a.end);
    if (items.length < 2) return;
    const minGap = 24 / Math.max(state.zoom || 1, 0.15);
    const perp = items.map((a) => {
      let dx, dy;
      if (a.type === 'curved' && a.control1 && a.control2) {
        const t = bezierTangent(a.start, a.control1, a.control2, a.end, 0.5);
        dx = t.x; dy = t.y;
      } else {
        dx = a.end.x - a.start.x;
        dy = a.end.y - a.start.y;
      }
      const len = Math.hypot(dx, dy) || 1;
      return { x: -dy / len, y: dx / len };
    });
    const labelBox = (ann) => {
      const text = String(getLabelText(ann) || '');
      const width = Math.max(22, text.length * 9 + 14) / Math.max(state.zoom || 1, 0.15);
      const height = 24 / Math.max(state.zoom || 1, 0.15);
      return {
        x1: ann.label.x - width / 2,
        y1: ann.label.y - height / 2,
        x2: ann.label.x + width / 2,
        y2: ann.label.y + height / 2,
      };
    };
    const overlapAmount = (a, b) => {
      const ax = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
      const ay = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      return ax > 0 && ay > 0 ? Math.min(ax, ay) : 0;
    };
    for (let iter = 0; iter < 36; iter += 1) {
      let moved = false;
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const ai = items[i], bj = items[j];
          const a = ai.label, b = bj.label;
          const dx = a.x - b.x, dy = a.y - b.y;
          const d = Math.hypot(dx, dy);
          const overlap = overlapAmount(labelBox(ai), labelBox(bj));
          if (d >= minGap && overlap <= 0) continue;
          const step = Math.max(minGap - d, overlap + 2 / Math.max(state.zoom || 1, 0.15)) * 0.55;
          const sameSpot = d < 0.001;
          const sep = sameSpot ? perp[i] : { x: dx / d, y: dy / d };
          const aiDir = {
            x: (perp[i].x * 0.68 + sep.x * 0.32),
            y: (perp[i].y * 0.68 + sep.y * 0.32),
          };
          const bjDir = {
            x: (perp[j].x * 0.68 - sep.x * 0.32),
            y: (perp[j].y * 0.68 - sep.y * 0.32),
          };
          a.x += aiDir.x * step;
          a.y += aiDir.y * step;
          b.x -= bjDir.x * step;
          b.y -= bjDir.y * step;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
