// Pure telemetry summarizer for Detect-to-POM speed sessions.
// Source part for app.js. Run `npm run build` after editing.

  function summarizeAutoTelemetryEvents(events) {
    const rows = Array.isArray(events)
      ? events.slice().filter(e => e && typeof e.event === 'string')
      : [];
    rows.sort((a, b) => eventTime(a) - eventTime(b));

    const first = (name) => rows.find(e => e.event === name) || null;
    const last = (name) => {
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        if (rows[i].event === name) return rows[i];
      }
      return null;
    };

    const imageLoaded = first('image_loaded');
    const detectClicked = first('detect_clicked');
    const detectFinished = last('detect_finished');
    const applyStarted = first('apply_started');
    const sessionDone = last('auto_session_done') || last('apply_finished') || last('draft_applied');

    const draggedAnchors = new Set();
    const editedDrafts = new Set();
    let discardedDrafts = 0;
    let appliedDrafts = 0;
    let approvedDrafts = 0;

    for (const row of rows) {
      if (row.event === 'anchor_dragged') {
        draggedAnchors.add(row.anchor_id || row.anchor_kind || String(eventTime(row)));
      } else if (row.event === 'draft_edited') {
        editedDrafts.add(row.draft_id || row.pom_id || String(eventTime(row)));
      } else if (row.event === 'draft_review_only') {
        editedDrafts.add(row.draft_id || row.pom_id || String(eventTime(row)));
        discardedDrafts += 1;
      } else if (row.event === 'draft_discarded') {
        discardedDrafts += Math.max(1, Number(row.count) || 0);
      } else if (row.event === 'draft_applied') {
        appliedDrafts += Math.max(1, Number(row.count) || 1);
      } else if (row.event === 'draft_approved') {
        approvedDrafts += 1;
      }
    }

    const detectMs = durationBetween(detectClicked, detectFinished);
    const loadToDetectMs = durationBetween(imageLoaded, detectFinished);
    const editMs = durationBetween(detectFinished, sessionDone);
    const applyMs = durationBetween(applyStarted, sessionDone);
    const anchorsDragged = draggedAnchors.size;
    const draftsEdited = editedDrafts.size;
    const touchless = !!sessionDone
      && anchorsDragged === 0
      && draftsEdited === 0
      && discardedDrafts === 0;

    return {
      detect_ms: detectMs,
      load_to_detect_ms: loadToDetectMs,
      edit_ms: editMs,
      apply_ms: applyMs,
      anchors_dragged: anchorsDragged,
      drafts_edited: draftsEdited,
      drafts_discarded: discardedDrafts,
      drafts_approved: approvedDrafts,
      drafts_applied: appliedDrafts,
      touchless,
      completed: !!sessionDone,
    };
  }

  function summarizeAutoTelemetrySessions(sessions) {
    const rows = Array.isArray(sessions)
      ? sessions.slice().filter(Boolean)
      : [];
    const normalized = rows.map(session => {
      const summary = session.summary || summarizeAutoTelemetryEvents(session.events || []);
      return Object.assign({}, session, { summary });
    });
    const summaries = normalized.map(s => s.summary || {});
    return {
      sessions: normalized,
      count: normalized.length,
      medians: {
        detect_ms: telemetryMedian(summaries.map(s => s.detect_ms)),
        edit_ms: telemetryMedian(summaries.map(s => s.edit_ms)),
        apply_ms: telemetryMedian(summaries.map(s => s.apply_ms)),
        anchors_dragged: telemetryMedian(summaries.map(s => s.anchors_dragged)),
        drafts_edited: telemetryMedian(summaries.map(s => s.drafts_edited)),
        drafts_discarded: telemetryMedian(summaries.map(s => s.drafts_discarded)),
      },
      touchlessCount: summaries.filter(s => s.touchless).length,
    };
  }

  function eventTime(event) {
    const t = Number(event && event.timestamp);
    return Number.isFinite(t) ? t : 0;
  }

  function durationBetween(startEvent, endEvent) {
    if (!startEvent || !endEvent) return null;
    const start = eventTime(startEvent);
    const end = eventTime(endEvent);
    if (!start || !end || end < start) return null;
    return Math.round(end - start);
  }

  function telemetryMedian(values) {
    const nums = values
      .map(v => Number(v))
      .filter(v => Number.isFinite(v));
    if (!nums.length) return null;
    nums.sort((a, b) => a - b);
    const mid = Math.floor(nums.length / 2);
    return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  }
