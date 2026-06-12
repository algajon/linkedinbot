import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middleware/requireAuth.js";
import * as posts from "../controllers/posts.controller.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Two routers exported from one module:
//   pageRouter — server-rendered HTML pages + browser form actions (mounted at /)
//   apiRouter  — JSON REST API (mounted at /api/posts)

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many posts created. Slow down." },
});

// ---- Browser pages + form actions ---------------------------------------
export const pageRouter = Router();
pageRouter.use(requireAuth);

pageRouter.get("/dashboard", posts.renderDashboard);
pageRouter.get("/posts", posts.renderList);
pageRouter.get("/posts/new", posts.renderNew);
pageRouter.post("/posts", createLimiter, posts.createPost);
pageRouter.get("/posts/:id/edit", posts.renderEdit);
// HTML forms only support GET/POST, so updates/cancel/retry/delete are POSTs.
pageRouter.post("/posts/:id", posts.updatePost);
pageRouter.post("/posts/:id/cancel", posts.cancelPost);
pageRouter.post("/posts/:id/retry", posts.retryPost);
pageRouter.post("/posts/:id/delete", posts.deletePost);

// ---- JSON API -----------------------------------------------------------
export const apiRouter = Router();
apiRouter.use(requireAuth);

apiRouter.get("/", posts.listPosts);
apiRouter.get("/:id", posts.getPost);
apiRouter.post("/", createLimiter, posts.createPost);
apiRouter.patch("/:id", posts.updatePost);
apiRouter.delete("/:id", posts.deletePost);
apiRouter.post("/:id/cancel", posts.cancelPost);
apiRouter.post("/:id/retry", posts.retryPost);
apiRouter.post("/:id/upload", upload.single("file"), posts.uploadFile);
apiRouter.delete("/:id/files/:fileId", posts.removeFile);
