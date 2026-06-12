import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { startOAuth, handleCallback, disconnect } from "../controllers/linkedin.controller.js";

const router = Router();

router.get("/linkedin", requireAuth, startOAuth);
router.get("/linkedin/callback", requireAuth, handleCallback);
router.post("/linkedin/disconnect", requireAuth, disconnect);

export default router;
