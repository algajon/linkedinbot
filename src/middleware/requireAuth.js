import { prisma } from "../lib/prisma.js";

// Gate browser/API routes behind a logged-in session. Loads the current user
// onto req.user and res.locals for views.
export async function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) {
    if (req.accepts(["html", "json"]) === "json") {
      return res.status(401).json({ error: "Not authenticated." });
    }
    return res.redirect("/login");
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { linkedinAccount: true },
    });
    if (!user) {
      req.session.destroy(() => {});
      return res.redirect("/login");
    }
    req.user = user;
    res.locals.currentUser = user;
    res.locals.linkedinAccount = user.linkedinAccount;
    next();
  } catch (err) {
    next(err);
  }
}
