import { Router } from "express";
import { requireCronSecret } from "../middleware/requireCronSecret.js";
import { runPublishDuePosts } from "../services/postScheduler.service.js";

const router = Router();

// Called every minute by the Render Cron Job (endpoint-based execution option).
// Protected by the x-internal-cron-secret header.
router.post("/publish-due-posts", requireCronSecret, async (req, res, next) => {
  try {
    const summary = await runPublishDuePosts();
    res.json({ ok: true, ...summary });
  } catch (err) {
    next(err);
  }
});

export default router;
