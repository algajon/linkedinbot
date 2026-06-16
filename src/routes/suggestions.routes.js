import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import * as suggestions from "../controllers/suggestions.controller.js";

// Idea generation + one-click drafting both call the LLM, so rate-limit them.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});

export const suggestionsApiRouter = Router();
suggestionsApiRouter.use(requireAuth);
suggestionsApiRouter.post("/", limiter, suggestions.suggest);
suggestionsApiRouter.post("/draft", limiter, suggestions.draftFromSuggestion);
