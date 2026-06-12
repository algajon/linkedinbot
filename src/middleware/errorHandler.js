// Centralized error handler. Renders an HTML page for browser requests and
// JSON for API requests. Never leaks tokens — only the error message.
export function errorHandler(err, req, res, next) {
  // eslint-disable-next-line no-console
  console.error("[error]", err.message);

  const status = err.status || 500;
  const message =
    status === 500 && process.env.NODE_ENV === "production"
      ? "Something went wrong."
      : err.message;

  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/") || req.accepts(["html", "json"]) === "json") {
    return res.status(status).json({ error: message });
  }

  res.status(status);
  res.render("error", { title: "Error", message, status });
}

export function notFound(req, res) {
  if (req.path.startsWith("/api/") || req.path.startsWith("/internal/")) {
    return res.status(404).json({ error: "Not found." });
  }
  res.status(404).render("error", { title: "Not found", message: "Page not found.", status: 404 });
}
