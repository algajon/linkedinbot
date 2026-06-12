import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import { generate } from "../controllers/ai.controller.js";

const router = Router();

// Generation is an expensive external call — throttle per session.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many generation requests. Please wait a moment." },
});

router.post("/generate", requireAuth, aiLimiter, generate);

export default router;
