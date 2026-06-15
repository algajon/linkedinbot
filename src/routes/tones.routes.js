import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import { learnTone, listTones, createTone, deleteTone } from "../controllers/tones.controller.js";

const router = Router();
router.use(requireAuth);

// Tone learning is an external OpenAI call — throttle it.
const learnLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many tone-analysis requests. Please wait a moment." },
});

router.get("/", listTones);
router.post("/", createTone);
router.post("/learn", learnLimiter, learnTone);
router.delete("/:id", deleteTone);

export default router;
