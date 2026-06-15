import {
  listRoutines,
  createRoutine,
  deleteRoutine,
  normalizeRoutineInput,
} from "../services/routine.service.js";
import { COMMON_TIMEZONES } from "../utils/date.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function renderRoutines(req, res, next) {
  try {
    const routines = await listRoutines(req.user.id);
    res.render("routines", {
      title: "Posting routines",
      routines,
      timezones: COMMON_TIMEZONES,
      weekdays: WEEKDAYS,
    });
  } catch (err) {
    next(err);
  }
}

export async function createRoutineHandler(req, res, next) {
  try {
    const { valid, errors, value } = normalizeRoutineInput(req.body);
    if (!valid) {
      if (req.baseUrl.startsWith("/api")) return res.status(400).json({ errors });
      const routines = await listRoutines(req.user.id);
      return res.status(400).render("routines", {
        title: "Posting routines",
        routines,
        timezones: COMMON_TIMEZONES,
        weekdays: WEEKDAYS,
        errors,
      });
    }
    const routine = await createRoutine(req.user.id, value);
    if (req.baseUrl.startsWith("/api")) return res.status(201).json({ routine });
    res.redirect("/routines");
  } catch (err) {
    next(err);
  }
}

export async function deleteRoutineHandler(req, res, next) {
  try {
    const ok = await deleteRoutine(req.params.id, req.user.id);
    if (req.baseUrl.startsWith("/api")) {
      return ok ? res.json({ ok: true }) : res.status(404).json({ error: "Routine not found." });
    }
    res.redirect("/routines");
  } catch (err) {
    next(err);
  }
}
