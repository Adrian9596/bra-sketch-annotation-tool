// Lightweight on-screen toast helper.
// Source part for app.js. Run `npm run build` after editing.
//
// US-032: one visible toast plus a short queue. A toast that arrives while
// the current one hasn't had a fair reading window queues instead of
// overwriting, then the queue drains on an early-advance cadence. Callers
// whose messages are a live STATUS (Tab part-cycling, brush size) pass
// { replace: true } — latest wins there, since replaying stale states after
// a keyboard burst would be worse than the old overwrite behaviour.
// The second positional argument still accepts a number (duration in ms)
// for the existing long-error call sites.

  const TOAST_DEFAULT_MS = 2600;
  const TOAST_MIN_VISIBLE_MS = 900; // fair reading window before a swap
  const TOAST_QUEUE_MAX = 3;
  let toastQueue = [];
  let toastShownAt = 0;
  let toastAdvanceTimer = null;

  function showToast(message, opts) {
    const options = typeof opts === 'number' ? { duration: opts } : (opts || {});
    const entry = { message, duration: options.duration || TOAST_DEFAULT_MS };
    const visible = el.toast.classList.contains('show');
    if (options.replace) {
      toastQueue = [];
      displayToast(entry);
      return;
    }
    if (visible && el.toast.textContent === message) {
      displayToast(entry); // same message again — extend, don't queue
      return;
    }
    const shownFor = performance.now() - toastShownAt;
    if (visible && shownFor < TOAST_MIN_VISIBLE_MS) {
      if (!toastQueue.some(q => q.message === message)) {
        toastQueue.push(entry);
        if (toastQueue.length > TOAST_QUEUE_MAX) toastQueue.shift();
        scheduleToastAdvance(TOAST_MIN_VISIBLE_MS - shownFor);
      }
      return;
    }
    displayToast(entry);
  }

  function displayToast(entry) {
    if (toastAdvanceTimer) {
      clearTimeout(toastAdvanceTimer);
      toastAdvanceTimer = null;
    }
    el.toast.textContent = entry.message;
    el.toast.classList.add('show');
    toastShownAt = performance.now();
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      el.toast.classList.remove('show');
      advanceToastQueue();
    }, entry.duration);
    if (toastQueue.length) scheduleToastAdvance(TOAST_MIN_VISIBLE_MS);
  }

  function scheduleToastAdvance(delay) {
    if (toastAdvanceTimer) return; // an advance is already on its way
    toastAdvanceTimer = setTimeout(() => {
      toastAdvanceTimer = null;
      advanceToastQueue();
    }, Math.max(0, delay));
  }

  function advanceToastQueue() {
    const next = toastQueue.shift();
    if (next) displayToast(next);
  }
