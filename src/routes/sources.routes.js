import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import * as sources from "../controllers/contentSources.controller.js";

// PDFs up to 15 MB, held in memory (we only persist the extracted text).
const pdfUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many generation requests. Please wait a moment." },
});

// Browser page (mounted at /).
export const sourcesPageRouter = Router();
sourcesPageRouter.use(requireAuth);
sourcesPageRouter.get("/sources", sources.renderSources);
sourcesPageRouter.post("/sources/watches", sources.addWatch);
sourcesPageRouter.post("/sources/watches/:id/delete", sources.removeWatch);

// JSON API (mounted at /api/sources).
export const sourcesApiRouter = Router();
sourcesApiRouter.use(requireAuth);
sourcesApiRouter.post("/", pdfUpload.single("file"), sources.uploadSource);
sourcesApiRouter.post("/url", generateLimiter, sources.addUrl);
sourcesApiRouter.post("/news", generateLimiter, sources.addNews);
sourcesApiRouter.delete("/:id", sources.removeSource);
sourcesApiRouter.post("/:id/generate", generateLimiter, sources.generateFromSource);
