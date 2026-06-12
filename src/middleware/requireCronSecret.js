import crypto from "node:crypto";

// Protect the internal publish endpoint with a shared secret header.
export function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "CRON_SECRET is not configured." });
  }
  const provided = req.get("x-internal-cron-secret") || "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid cron secret." });
  }
  next();
}
