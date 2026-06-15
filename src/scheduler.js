// In-process publish scheduler. Runs the same `runPublishDuePosts` work the
// standalone cron script uses, on an hourly timer inside the web service — so
// no separate Render Cron Job is required. Concurrent/duplicate runs are safe
// because publishing locks each row (SCHEDULED -> PUBLISHING) atomically.

import { runPublishDuePosts } from "./services/postScheduler.service.js";

let timer = null;
let initialTimer = null;

// Enabled when PUBLISH_SCHEDULER is on/true/1, disabled when off/false/0.
// Defaults to ON in production, OFF elsewhere (so local dev stays quiet).
export function isSchedulerEnabled() {
  const v = (process.env.PUBLISH_SCHEDULER || "").trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  return process.env.NODE_ENV === "production";
}

// Interval in minutes (default 60). Accepts fractional values for testing.
export function getIntervalMs() {
  const mins = parseFloat(process.env.PUBLISH_INTERVAL_MINUTES || "60");
  const safe = Number.isFinite(mins) && mins > 0 ? mins : 60;
  return Math.round(safe * 60 * 1000);
}

async function runOnce() {
  try {
    const summary = await runPublishDuePosts();
    // eslint-disable-next-line no-console
    console.log(
      `[scheduler] reclaimed=${summary.reclaimed} attempted=${summary.attempted} ` +
        `published=${summary.published} failed=${summary.failed}`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[scheduler] run failed:", err.message);
  }
}

export function startPublishScheduler({ intervalMs = getIntervalMs(), initialDelayMs = 10000 } = {}) {
  stopPublishScheduler();
  // eslint-disable-next-line no-console
  console.log(`[scheduler] in-process publisher enabled — running every ${Math.round(intervalMs / 60000)} min`);
  // One run shortly after boot (catches anything already due), then on interval.
  initialTimer = setTimeout(runOnce, initialDelayMs);
  timer = setInterval(runOnce, intervalMs);
  return { initialTimer, timer };
}

export function stopPublishScheduler() {
  if (timer) clearInterval(timer);
  if (initialTimer) clearTimeout(initialTimer);
  timer = null;
  initialTimer = null;
}
