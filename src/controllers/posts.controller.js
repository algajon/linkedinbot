import { prisma } from "../lib/prisma.js";
import { validatePostInput, MAX_POST_LENGTH } from "../utils/validation.js";
import { formatInZone, defaultLocalParts, COMMON_TIMEZONES } from "../utils/date.js";
import { DateTime } from "luxon";
import { retryPost as retryPostService } from "../services/postScheduler.service.js";
import { linkFileToPost, getPostFiles, removeFileFromPost, getOwnedFileWithData } from "../services/upload.service.js";
import { getActiveRoutine, computeUpcomingSlots } from "../services/routine.service.js";
import { normalizePostLanguage } from "../utils/postLanguages.js";

const EDITABLE_STATUSES = new Set(["DRAFT", "PENDING_APPROVAL", "SCHEDULED", "FAILED"]);

function wantsJson(req) {
  return req.baseUrl.startsWith("/api");
}

async function findOwnedPost(id, userId) {
  const post = await prisma.scheduledPost.findFirst({ where: { id, userId } });
  return post;
}

// Split a stored UTC scheduledAt back into local date/time parts for forms.
// Drafts (PENDING_APPROVAL) have no scheduledAt yet — fall back to a default.
function toLocalParts(post) {
  if (!post.scheduledAt) return defaultLocalParts(post.timezone || "UTC");
  const dt = DateTime.fromJSDate(post.scheduledAt, { zone: "utc" }).setZone(post.timezone);
  return { date: dt.toFormat("yyyy-LL-dd"), time: dt.toFormat("HH:mm"), timezone: post.timezone };
}

// ---- Page renders -------------------------------------------------------

export async function renderDashboard(req, res, next) {
  try {
    const userId = req.user.id;
    const [upcoming, recentlyPublished, failed] = await Promise.all([
      prisma.scheduledPost.findMany({
        where: { userId, status: { in: ["SCHEDULED", "PUBLISHING"] } },
        orderBy: { scheduledAt: "asc" },
        take: 10,
      }),
      prisma.scheduledPost.findMany({
        where: { userId, status: "PUBLISHED" },
        orderBy: { publishedAt: "desc" },
        take: 5,
      }),
      prisma.scheduledPost.findMany({
        where: { userId, status: "FAILED" },
        orderBy: { updatedAt: "desc" },
        take: 10,
      }),
    ]);

    res.render("dashboard", {
      title: "Dashboard",
      upcoming,
      recentlyPublished,
      failed,
      formatInZone,
      flash: {
        connected: req.query.linkedin_connected,
        disconnected: req.query.linkedin_disconnected,
        linkedinError: req.query.linkedin_error,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function renderList(req, res, next) {
  try {
    const userId = req.user.id;
    const filter = (req.query.status || "").toUpperCase();
    const validStatuses = ["SCHEDULED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELED", "DRAFT"];
    const where = { userId };
    if (validStatuses.includes(filter)) where.status = filter;

    const posts = await prisma.scheduledPost.findMany({
      where,
      orderBy: { scheduledAt: "desc" },
    });

    res.render("post-list", {
      title: "Posts",
      posts,
      filter: validStatuses.includes(filter) ? filter : "",
      formatInZone,
    });
  } catch (err) {
    next(err);
  }
}

async function getSavedTones(userId) {
  return prisma.tonePreset.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
}

export async function renderNew(req, res, next) {
  try {
  const tz = req.query.tz || "UTC";
  const savedTones = await getSavedTones(req.user.id);
  res.render("new-post", {
    title: "New post",
    errors: [],
    savedTones,
    values: { body: "", language: "en", ...defaultLocalParts(tz) },
    timezones: COMMON_TIMEZONES,
    maxLength: MAX_POST_LENGTH,
    linkedinReady: Boolean(req.user.linkedinAccount?.linkedinPersonUrn),
  });
  } catch (err) {
    next(err);
  }
}

export async function renderEdit(req, res, next) {
  try {
    const post = await findOwnedPost(req.params.id, req.user.id);
    if (!post) return res.status(404).render("error", { title: "Not found", message: "Post not found.", status: 404 });
    if (!EDITABLE_STATUSES.has(post.status)) {
      return res.status(400).render("error", {
        title: "Cannot edit",
        message: `A ${post.status} post cannot be edited.`,
        status: 400,
      });
    }

    const files = await getPostFiles(post.id, req.user.id);
    const savedTones = await getSavedTones(req.user.id);

    res.render("edit-post", {
      title: "Edit post",
      errors: [],
      post,
      files,
      savedTones,
      values: { body: post.body, language: post.language || "en", ...toLocalParts(post) },
      timezones: COMMON_TIMEZONES,
      maxLength: MAX_POST_LENGTH,
    });
  } catch (err) {
    next(err);
  }
}

// ---- Data actions (serve both /api JSON and browser forms) --------------

export async function listPosts(req, res, next) {
  try {
    const posts = await prisma.scheduledPost.findMany({
      where: { userId: req.user.id },
      orderBy: { scheduledAt: "desc" },
    });
    res.json({ posts });
  } catch (err) {
    next(err);
  }
}

export async function getPost(req, res, next) {
  try {
    const post = await findOwnedPost(req.params.id, req.user.id);
    if (!post) return res.status(404).json({ error: "Post not found." });
    res.json({ post });
  } catch (err) {
    next(err);
  }
}

export async function createPost(req, res, next) {
  try {
    const account = req.user.linkedinAccount;
    if (!account?.linkedinPersonUrn) {
      const msg = "Connect your LinkedIn account before scheduling posts.";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("new-post", {
        title: "New post",
        errors: [msg],
        values: { body: req.body.body || "", date: req.body.date, time: req.body.time, timezone: req.body.timezone, language: req.body.language || "en" },
        timezones: COMMON_TIMEZONES,
        maxLength: MAX_POST_LENGTH,
        linkedinReady: false,
      });
    }

    const { valid, errors, value } = validatePostInput(req.body);
    if (!valid) {
      if (wantsJson(req)) return res.status(400).json({ errors });
      return res.status(400).render("new-post", {
        title: "New post",
        errors,
        values: { body: req.body.body || "", date: req.body.date, time: req.body.time, timezone: req.body.timezone, language: req.body.language || "en" },
        timezones: COMMON_TIMEZONES,
        maxLength: MAX_POST_LENGTH,
        linkedinReady: true,
      });
    }

    const post = await prisma.scheduledPost.create({
      data: {
        userId: req.user.id,
        linkedinAccountId: account.id,
        authorUrn: account.linkedinPersonUrn,
        targetType: "PERSONAL_PROFILE",
        body: value.body,
        scheduledAt: value.scheduledAt,
        timezone: value.timezone,
        language: normalizePostLanguage(req.body.language),
        status: "SCHEDULED",
      },
    });

    if (wantsJson(req)) return res.status(201).json({ post });
    // Land on the edit screen so the user can optionally attach images
    // (uploads require an existing post id).
    res.redirect(`/posts/${post.id}/edit`);
  } catch (err) {
    next(err);
  }
}

export async function updatePost(req, res, next) {
  try {
    const post = await findOwnedPost(req.params.id, req.user.id);
    if (!post) {
      if (wantsJson(req)) return res.status(404).json({ error: "Post not found." });
      return res.status(404).render("error", { title: "Not found", message: "Post not found.", status: 404 });
    }
    if (!EDITABLE_STATUSES.has(post.status)) {
      const msg = `A ${post.status} post cannot be edited.`;
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot edit", message: msg, status: 400 });
    }

    const { valid, errors, value } = validatePostInput(req.body);
    if (!valid) {
      if (wantsJson(req)) return res.status(400).json({ errors });
      return res.status(400).render("edit-post", {
        title: "Edit post",
        errors,
        post,
        values: { body: req.body.body || "", date: req.body.date, time: req.body.time, timezone: req.body.timezone, language: req.body.language || "en" },
        timezones: COMMON_TIMEZONES,
        maxLength: MAX_POST_LENGTH,
      });
    }

    const updated = await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        body: value.body,
        scheduledAt: value.scheduledAt,
        timezone: value.timezone,
        language: normalizePostLanguage(req.body.language),
        // Re-arming a previously failed post.
        status: "SCHEDULED",
        errorMessage: null,
      },
    });

    if (wantsJson(req)) return res.json({ post: updated });
    res.redirect("/posts?status=SCHEDULED");
  } catch (err) {
    next(err);
  }
}

export async function cancelPost(req, res, next) {
  try {
    // Only SCHEDULED/DRAFT posts can be canceled (never PUBLISHED/PUBLISHING).
    const result = await prisma.scheduledPost.updateMany({
      where: { id: req.params.id, userId: req.user.id, status: { in: ["SCHEDULED", "DRAFT", "PENDING_APPROVAL"] } },
      data: { status: "CANCELED" },
    });
    if (result.count !== 1) {
      const msg = "Post cannot be canceled (it may already be publishing or published).";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot cancel", message: msg, status: 400 });
    }
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect("/posts");
  } catch (err) {
    next(err);
  }
}

export async function retryPost(req, res, next) {
  try {
    const ok = await retryPostService(req.params.id, req.user.id);
    if (!ok) {
      const msg = "Only failed posts can be retried.";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot retry", message: msg, status: 400 });
    }
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect("/posts?status=SCHEDULED");
  } catch (err) {
    next(err);
  }
}

export async function deletePost(req, res, next) {
  try {
    // Never delete a post mid-publish.
    const result = await prisma.scheduledPost.deleteMany({
      where: { id: req.params.id, userId: req.user.id, status: { not: "PUBLISHING" } },
    });
    if (result.count !== 1) {
      const msg = "Post cannot be deleted right now.";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot delete", message: msg, status: 400 });
    }
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect("/posts");
  } catch (err) {
    next(err);
  }
}

export async function uploadFile(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file provided." });
    }
    const file = await linkFileToPost(req.params.id, req.user.id, req.file);
    res.json({ file });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

export async function removeFile(req, res, next) {
  try {
    await removeFileFromPost(req.params.fileId, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

// Stream a stored file's bytes from the DB (owner-scoped). Used by <img> tags;
// the browser sends the session cookie so requireAuth applies.
export async function serveFile(req, res, next) {
  try {
    const file = await getOwnedFileWithData(req.params.id, req.user.id);
    if (!file || !file.data) return res.status(404).send("Not found");
    res.set("Content-Type", file.mimeType);
    res.set("Cache-Control", "private, max-age=86400");
    res.send(Buffer.from(file.data));
  } catch (err) {
    next(err);
  }
}

// ---- Approval queue -----------------------------------------------------

export async function renderQueue(req, res, next) {
  try {
    const userId = req.user.id;
    const drafts = await prisma.scheduledPost.findMany({
      where: { userId, status: "PENDING_APPROVAL" },
      orderBy: { createdAt: "asc" },
    });

    // Prefill each draft with the next open routine slot (skipping ones already
    // suggested to earlier drafts in this list).
    const routine = await getActiveRoutine(userId);
    const taken = new Set();
    const slots = routine ? computeUpcomingSlots(routine, drafts.length + 2, { taken }) : [];

    const files = await Promise.all(drafts.map((d) => getPostFiles(d.id, userId)));

    const items = drafts.map((d, i) => {
      const slot = slots[i];
      const parts = slot
        ? toLocalParts({ scheduledAt: slot, timezone: routine.timezone })
        : defaultLocalParts(d.timezone || "UTC");
      return { post: d, files: files[i], suggested: parts };
    });

    res.render("queue", {
      title: "Approval queue",
      items,
      routine,
      timezones: COMMON_TIMEZONES,
      maxLength: MAX_POST_LENGTH,
    });
  } catch (err) {
    next(err);
  }
}

export async function approvePost(req, res, next) {
  try {
    const post = await findOwnedPost(req.params.id, req.user.id);
    if (!post || post.status !== "PENDING_APPROVAL") {
      const msg = "Only pending drafts can be approved.";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot approve", message: msg, status: 400 });
    }

    // Body may be edited inline at approval; reuse the standard validator.
    const input = { body: req.body.body ?? post.body, date: req.body.date, time: req.body.time, timezone: req.body.timezone };
    const { valid, errors, value } = validatePostInput(input);
    if (!valid) {
      if (wantsJson(req)) return res.status(400).json({ errors });
      return res.status(400).render("error", { title: "Cannot approve", message: errors.join(" "), status: 400 });
    }

    await prisma.scheduledPost.update({
      where: { id: post.id },
      data: {
        body: value.body,
        scheduledAt: value.scheduledAt,
        timezone: value.timezone,
        language: normalizePostLanguage(req.body.language),
        status: "SCHEDULED",
        approvedAt: new Date(),
        errorMessage: null,
      },
    });

    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect("/queue");
  } catch (err) {
    next(err);
  }
}

export async function rejectPost(req, res, next) {
  try {
    const result = await prisma.scheduledPost.updateMany({
      where: { id: req.params.id, userId: req.user.id, status: "PENDING_APPROVAL" },
      data: { status: "CANCELED" },
    });
    if (result.count !== 1) {
      const msg = "Only pending drafts can be rejected.";
      if (wantsJson(req)) return res.status(400).json({ error: msg });
      return res.status(400).render("error", { title: "Cannot reject", message: msg, status: 400 });
    }
    if (wantsJson(req)) return res.json({ ok: true });
    res.redirect("/queue");
  } catch (err) {
    next(err);
  }
}
