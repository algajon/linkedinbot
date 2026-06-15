import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import session from "express-session";
import cookieParser from "cookie-parser";
import connectPgSimple from "connect-pg-simple";

import authRoutes from "./routes/auth.routes.js";
import linkedinRoutes from "./routes/linkedin.routes.js";
import { pageRouter, apiRouter } from "./routes/posts.routes.js";
import aiRoutes from "./routes/ai.routes.js";
import tonesRoutes from "./routes/tones.routes.js";
import { sourcesPageRouter, sourcesApiRouter } from "./routes/sources.routes.js";
import { routinesPageRouter, routinesApiRouter } from "./routes/routines.routes.js";
import internalRoutes from "./routes/internal.routes.js";
import { TONE_PRESETS } from "./services/ai.service.js";
import { LANGUAGES, t } from "./utils/i18n.js";
import { POST_LANGUAGES } from "./utils/postLanguages.js";
import { POST_LENGTHS } from "./utils/postLengths.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  const isProd = process.env.NODE_ENV === "production";

  // Behind Render's proxy — needed for secure cookies to work.
  app.set("trust proxy", 1);

  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "views"));

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use("/public", express.static(path.join(__dirname, "..", "public")));
  app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

  // Session store: Postgres-backed so sessions survive restarts and scale
  // across instances.
  const PgStore = connectPgSimple(session);
  app.use(
    session({
      store: new PgStore({
        conString: process.env.DATABASE_URL,
        createTableIfMissing: true,
        tableName: "user_sessions",
      }),
      name: "connect.sid",
      secret: process.env.SESSION_SECRET || "insecure-dev-secret",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProd,
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      },
    })
  );

  // Make a few values available to all views.
  app.use((req, res, next) => {
    // Language from query param, cookie, or default to 'en'.
    let lang = req.query.lang || req.cookies.lang || "en";
    if (!LANGUAGES[lang]) lang = "en";
    if (req.query.lang) res.cookie("lang", lang, { maxAge: 365 * 24 * 60 * 60 * 1000 });

    res.locals.currentUser = null;
    res.locals.linkedinAccount = null;
    res.locals.appBaseUrl = process.env.APP_BASE_URL || "";
    res.locals.lang = lang;
    res.locals.languages = LANGUAGES;
    res.locals.t = (key) => t(key, lang);
    // AI generation availability + tone presets, for the editor views.
    res.locals.aiEnabled = Boolean(process.env.OPENAI_API_KEY);
    res.locals.tonePresets = TONE_PRESETS;
    res.locals.postLanguages = POST_LANGUAGES;
    res.locals.postLengths = POST_LENGTHS;
    next();
  });

  // Routes
  app.get("/", (req, res) => {
    if (req.session?.userId) return res.redirect("/dashboard");
    res.render("home", { title: "LinkedIn Scheduled Poster" });
  });
  // Convenience GET aliases for the auth pages.
  app.get("/login", (req, res) => res.redirect("/auth/login"));
  app.get("/register", (req, res) => res.redirect("/auth/register"));

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  app.use("/auth", authRoutes);
  app.use("/auth", linkedinRoutes);
  app.use("/api/posts", apiRouter);
  app.use("/api/ai", aiRoutes);
  app.use("/api/tones", tonesRoutes);
  app.use("/api/sources", sourcesApiRouter);
  app.use("/api/routines", routinesApiRouter);
  app.use("/internal", internalRoutes);
  app.use("/", pageRouter);
  app.use("/", sourcesPageRouter);
  app.use("/", routinesPageRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
