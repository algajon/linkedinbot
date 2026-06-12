import { DateTime } from "luxon";

// Common IANA timezones offered in the UI. Not exhaustive — users can rely on
// their browser-detected zone too.
export const COMMON_TIMEZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Helsinki",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

export function isValidTimezone(tz) {
  if (!tz || typeof tz !== "string") return false;
  return DateTime.local().setZone(tz).isValid;
}

// Combine a local date (YYYY-MM-DD), time (HH:mm) and IANA timezone into an
// absolute UTC Date. Returns null if any part is invalid.
export function toUtcFromLocalParts(dateStr, timeStr, timezone) {
  if (!dateStr || !timeStr || !isValidTimezone(timezone)) return null;
  const dt = DateTime.fromISO(`${dateStr}T${timeStr}`, { zone: timezone });
  if (!dt.isValid) return null;
  return dt.toUTC().toJSDate();
}

// Format a stored UTC Date back into the post's timezone for display.
export function formatInZone(date, timezone, fmt = "ccc, LLL d yyyy, HH:mm") {
  if (!date) return "";
  const dt = DateTime.fromJSDate(date, { zone: "utc" }).setZone(
    isValidTimezone(timezone) ? timezone : "utc"
  );
  return dt.isValid ? dt.toFormat(fmt) : "";
}

// Default form values: today and one hour from now, in the given zone.
export function defaultLocalParts(timezone = "UTC") {
  const zone = isValidTimezone(timezone) ? timezone : "UTC";
  const dt = DateTime.now().setZone(zone).plus({ hours: 1 }).startOf("minute");
  return {
    date: dt.toFormat("yyyy-LL-dd"),
    time: dt.toFormat("HH:mm"),
    timezone: zone,
  };
}
