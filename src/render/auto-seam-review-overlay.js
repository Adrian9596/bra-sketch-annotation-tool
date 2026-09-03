// US-121 — TD Review overlay for Auto Detect Seam: draws every Automatic ROI
// from the last analysis, color-coded by the TD's verdict, with draggable
// vertex handles on the ROI currently being corrected. Read-only over the
// detector's own output — see src/manual/auto-seam-review.js for the state
// this reads and the drag handlers that write `correctedPolygon`, which is
// TD truth, never fed back into the detector.
// Source part for app.js. Run `npm run build` after editing.

  const AUTO_SEAM_REVIEW_COLORS = Object.freeze({
    unreviewed: { stroke: 'rgba(100, 116, 139, 0.85)', fill: 'rgba(100, 116, 139, 0.07)' },
    correct: { stroke: 'rgba(22, 163, 74, 0.9)', fill: 'rgba(22, 163, 74, 0.10)' },
    wrong: { stroke: 'rgba(234, 88, 12, 0.9)', fill: 'rgba(234, 88, 12, 0.10)' },
    corrected: { stroke: 'rgba(124, 58, 237, 0.95)', fill: 'rgba(124, 58, 237, 0.12)' },
  });

  function autoSeamReviewStrokePolygon(points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.stroke();
  }

  function autoSeamReviewFillPolygon(points) {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
    ctx.fill();
  }

  function drawAutoSeamReviewOverlay() {
    if (!isAutoSeamReviewOpen()) return;
    const image = autoSeamReviewSourceImage();
    if (!image) return;
    const rows = autoSeamReviewRows();
    if (!rows.length) return;
    const px = 1 / Math.max(state.zoom, 0.1);
    const review = autoSeamReviewState();

    ctx.save();
    for (const row of rows) {
      const polygonNorm = row.correctedPolygon || row.roi.polygon;
      const polygon = polygonNorm.map(p => worldFromNormalized(p, image));
      const isSelected = row.roi.id === review.selectedRoiId;
      const isEditing = row.roi.id === review.editingRoiId;
      const style = row.correctedPolygon ? AUTO_SEAM_REVIEW_COLORS.corrected
        : row.verdict === 'correct' ? AUTO_SEAM_REVIEW_COLORS.correct
        : row.verdict === 'wrong' ? AUTO_SEAM_REVIEW_COLORS.wrong
        : AUTO_SEAM_REVIEW_COLORS.unreviewed;

      // Corrected rows also show the ORIGINAL detected polygon, thin and
      // dashed, so the TD can see exactly how far they moved it.
      if (row.correctedPolygon) {
        const detected = row.roi.polygon.map(p => worldFromNormalized(p, image));
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';
        ctx.lineWidth = 1 * px;
        ctx.setLineDash([3 * px, 3 * px]);
        autoSeamReviewStrokePolygon(detected);
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = style.stroke;
      ctx.fillStyle = style.fill;
      ctx.lineWidth = (isSelected || isEditing ? 2.4 : 1.4) * px;
      autoSeamReviewFillPolygon(polygon);
      autoSeamReviewStrokePolygon(polygon);

      // Zone/side label at the polygon's topmost point.
      const top = polygon.reduce((a, b) => (b.y < a.y ? b : a), polygon[0]);
      const label = autoSeamReviewZoneLabel(row.roi.zone) + ' · ' + autoSeamReviewSideLabel(row.roi.side);
      ctx.font = '700 ' + (11 * px).toFixed(1) + 'px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';
      const textW = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(255,255,255,0.88)';
      ctx.fillRect(top.x - 2 * px, top.y - 16 * px, textW + 6 * px, 14 * px);
      ctx.fillStyle = style.stroke;
      ctx.fillText(label, top.x + px, top.y - 3 * px);

      // Draggable vertex handles only for the ROI currently being edited.
      if (isEditing) {
        ctx.fillStyle = style.stroke;
        for (const point of polygon) {
          ctx.beginPath();
          ctx.arc(point.x, point.y, 4.5 * px, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }
