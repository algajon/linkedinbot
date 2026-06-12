import { toUtcFromLocalParts, isValidTimezone } from "./date.js";

// LinkedIn's documented limit for post commentary text.
// Best practices: 150-200 chars for optimal engagement; max 3000 technically supported.
// We use 1300 as a sweet spot: short enough for mobile readability, long enough for substance.
export const MAX_POST_LENGTH = 1300;

export function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// Validate post creation/edit input. `requireFuture` lets us skip the
// future-time check on edits that keep an already-past schedule (rare), but by
// default scheduled time must be in the future.
export function validatePostInput(input, { now = new Date() } = {}) {
  const errors = [];
  const body = (input.body ?? "").trim();
  const timezone = (input.timezone ?? "").trim();
  const date = (input.date ?? "").trim();
  const time = (input.time ?? "").trim();

  if (!body) {
    errors.push("Post body is required.");
  } else if (body.length > MAX_POST_LENGTH) {
    errors.push(`Post body must be ${MAX_POST_LENGTH} characters or fewer (currently ${body.length}).`);
  }

  if (!isValidTimezone(timezone)) {
    errors.push("A valid timezone is required.");
  }

  const scheduledAt = toUtcFromLocalParts(date, time, timezone);
  if (!scheduledAt) {
    errors.push("A valid date and time are required.");
  } else if (scheduledAt.getTime() <= now.getTime()) {
    errors.push("Scheduled time must be in the future.");
  }

  return {
    valid: errors.length === 0,
    errors,
    value: { body, timezone, scheduledAt },
  };
}
