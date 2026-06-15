import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import {
  renderRoutines,
  createRoutineHandler,
  deleteRoutineHandler,
} from "../controllers/routines.controller.js";

// Browser pages + form actions (mounted at /).
export const routinesPageRouter = Router();
routinesPageRouter.use(requireAuth);
routinesPageRouter.get("/routines", renderRoutines);
routinesPageRouter.post("/routines", createRoutineHandler);
routinesPageRouter.post("/routines/:id/delete", deleteRoutineHandler);

// JSON API (mounted at /api/routines).
export const routinesApiRouter = Router();
routinesApiRouter.use(requireAuth);
routinesApiRouter.post("/", createRoutineHandler);
routinesApiRouter.delete("/:id", deleteRoutineHandler);
