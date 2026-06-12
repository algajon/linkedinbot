import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma.js";
import { isValidEmail } from "../utils/validation.js";

function loginSession(req, user) {
  return new Promise((resolve, reject) => {
    // Regenerate session on auth to prevent fixation.
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

export function renderRegister(req, res) {
  res.render("register", { title: "Create account", error: null, email: "" });
}

export function renderLogin(req, res) {
  res.render("login", { title: "Log in", error: null, email: "" });
}

export async function register(req, res, next) {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";
    const name = (req.body.name || "").trim() || null;

    if (!isValidEmail(email) || password.length < 8) {
      return res.status(400).render("register", {
        title: "Create account",
        error: "Enter a valid email and a password of at least 8 characters.",
        email,
      });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).render("register", {
        title: "Create account",
        error: "An account with that email already exists.",
        email,
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({ data: { email, name, passwordHash } });
    await loginSession(req, user);
    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
}

export async function login(req, res, next) {
  try {
    const email = (req.body.email || "").trim().toLowerCase();
    const password = req.body.password || "";

    const user = await prisma.user.findUnique({ where: { email } });
    const ok = user?.passwordHash && (await bcrypt.compare(password, user.passwordHash));
    if (!ok) {
      return res.status(401).render("login", {
        title: "Log in",
        error: "Invalid email or password.",
        email,
      });
    }

    await loginSession(req, user);
    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
}

export function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/login");
  });
}

export async function me(req, res) {
  const { id, email, name, createdAt } = req.user;
  res.json({
    user: { id, email, name, createdAt },
    linkedinConnected: Boolean(req.user.linkedinAccount),
  });
}
