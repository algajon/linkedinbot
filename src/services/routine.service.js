import { DateTime } from "luxon";
import { prisma } from "../lib/prisma.js";
import { isValidTimezone } from "../utils/date.js";

export const CADENCES = ["EVERY_12H", "EVERY_24H", "WEEKLY"];

// Ready-made cadences based on widely-cited LinkedIn best practices: post on
// weekdays, mid-morning, and above all consistently. Tue–Thu draw the most
// engagement; weekends are weakest. Weekday is 0=Sun..6=Sat.
export const ROUTINE_PRESETS = [
  {
    key: "weekday_mornings",
    name: "Weekday mornings (Tue–Thu)",
    description: "3 posts a week on the highest-engagement days, 8am. The LinkedIn sweet spot.",
    cadence: "WEEKLY",
    slots: [{ weekday: 2, time: "08:00" }, { weekday: 3, time: "08:00" }, { weekday: 4, time: "08:00" }],
  },
  {
    key: "twice_weekly",
    name: "Steady 2×/week (Tue + Thu)",
    description: "A sustainable, consistent cadence at 10am. Easy to keep up long term.",
    cadence: "WEEKLY",
    slots: [{ weekday: 2, time: "10:00" }, { weekday: 4, time: "10:00" }],
  },
  {
    key: "every_weekday",
    name: "Every weekday at 9am",
    description: "Daily weekday presence. Best when you have a steady stream of ideas.",
    cadence: "WEEKLY",
    slots: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, time: "09:00" })),
  },
  {
    key: "daily_9am",
    name: "Once a day, 9am",
    description: "Simple daily cadence (includes weekends). One slot per day.",
    cadence: "EVERY_24H",
    anchorTime: "09:00",
  },
];

function parseHM(hm, fallbackHour = 9) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.min(23, +m[1]), minute: Math.min(59, +m[2]) };
}

// Normalize/validate routine input from a form or API body.
export function normalizeRoutineInput(body = {}) {
  const errors = [];
  const name = (body.name || "").trim() || "My routine";
  const cadence = CADENCES.includes(body.cadence) ? body.cadence : "EVERY_24H";
  const timezone = isValidTimezone(body.timezone) ? body.timezone : "UTC";
  if (!isValidTimezone(body.timezone)) errors.push("A valid timezone is required.");

  let anchorTime = null;
  let slots = null;

  if (cadence === "WEEKLY") {
    // Accept slots as array of {weekday, time} or parallel arrays from a form.
    let raw = body.slots;
    if (!Array.isArray(raw)) {
      const weekdays = [].concat(body.weekday || []);
      const times = [].concat(body.slotTime || []);
      raw = weekdays.map((w, i) => ({ weekday: w, time: times[i] }));
    }
    slots = raw
      .map((s) => ({ weekday: Number(s.weekday), time: String(s.time || "").trim() }))
      .filter((s) => s.weekday >= 0 && s.weekday <= 6 && /^\d{1,2}:\d{2}$/.test(s.time));
    if (!slots.length) errors.push("Pick at least one weekday and time for a weekly routine.");
  } else {
    anchorTime = /^\d{1,2}:\d{2}$/.test((body.anchorTime || "").trim())
      ? body.anchorTime.trim()
      : "09:00";
  }

  return { valid: errors.length === 0, errors, value: { name, cadence, timezone, anchorTime, slots } };
}

// CRUD ---------------------------------------------------------------------

export function listRoutines(userId) {
  return prisma.postingRoutine.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export function getActiveRoutine(userId) {
  return prisma.postingRoutine.findFirst({
    where: { userId, active: true },
    orderBy: { createdAt: "desc" },
  });
}

export function createRoutine(userId, value) {
  return prisma.postingRoutine.create({ data: { userId, ...value } });
}

// Create a routine from a ROUTINE_PRESETS entry, in the chosen timezone.
export function createRoutineFromPreset(userId, key, timezone) {
  const preset = ROUTINE_PRESETS.find((p) => p.key === key);
  if (!preset) return null;
  const tz = isValidTimezone(timezone) ? timezone : "UTC";
  return prisma.postingRoutine.create({
    data: {
      userId,
      name: preset.name,
      cadence: preset.cadence,
      timezone: tz,
      anchorTime: preset.anchorTime || null,
      slots: preset.slots || null,
    },
  });
}

export async function deleteRoutine(id, userId) {
  const r = await prisma.postingRoutine.deleteMany({ where: { id, userId } });
  return r.count === 1;
}

// Slot computation ---------------------------------------------------------

// Return the next `count` publish datetimes (UTC Date[]) implied by a routine,
// strictly after `from`. `taken` is a Set of ISO strings already in use, which
// are skipped so successive approvals don't collide.
export function computeUpcomingSlots(routine, count = 5, { from = new Date(), taken = new Set() } = {}) {
  if (!routine) return [];
  const zone = isValidTimezone(routine.timezone) ? routine.timezone : "UTC";
  const start = DateTime.fromJSDate(from, { zone });
  const out = [];

  if (routine.cadence === "WEEKLY") {
    const slots = Array.isArray(routine.slots) ? routine.slots : [];
    if (!slots.length) return [];
    // Walk forward day by day for up to 8 weeks, collecting matching slots.
    for (let day = 0; day < 56 && out.length < count; day++) {
      const d = start.plus({ days: day });
      for (const slot of slots) {
        // luxon weekday: 1=Mon..7=Sun; our stored weekday: 0=Sun..6=Sat.
        const luxonWeekday = slot.weekday === 0 ? 7 : slot.weekday;
        if (d.weekday !== luxonWeekday) continue;
        const { hour, minute } = parseHM(slot.time);
        const cand = d.set({ hour, minute, second: 0, millisecond: 0 });
        if (cand <= start) continue;
        const utc = cand.toUTC().toJSDate();
        if (taken.has(utc.toISOString())) continue;
        out.push(utc);
      }
    }
    return out.sort((a, b) => a - b).slice(0, count);
  }

  // EVERY_12H / EVERY_24H: step from the next anchor occurrence.
  const stepHours = routine.cadence === "EVERY_12H" ? 12 : 24;
  const { hour, minute } = parseHM(routine.anchorTime);
  let cand = start.set({ hour, minute, second: 0, millisecond: 0 });
  while (cand <= start) cand = cand.plus({ hours: stepHours });
  let guard = 0;
  while (out.length < count && guard++ < 500) {
    const utc = cand.toUTC().toJSDate();
    if (!taken.has(utc.toISOString())) out.push(utc);
    cand = cand.plus({ hours: stepHours });
  }
  return out;
}
