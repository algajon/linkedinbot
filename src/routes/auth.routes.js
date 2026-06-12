import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  renderRegister,
  renderLogin,
  register,
  login,
  logout,
  me,
} from "../controllers/auth.controller.js";

const router = Router();

// Throttle credential endpoints against brute force.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

router.get("/register", renderRegister);
router.post("/register", authLimiter, register);
router.get("/login", renderLogin);
router.post("/login", authLimiter, login);
router.post("/logout", logout);
router.get("/me", requireAuth, me);

export default router;
