import crypto from "node:crypto";
import { prisma } from "../lib/prisma.js";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserInfo,
} from "../services/linkedin.service.js";
import { saveTokens } from "../services/token.service.js";

// Step 1: redirect the user to LinkedIn with a CSRF state token.
export function startOAuth(req, res) {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.linkedinOAuthState = state;
  res.redirect(buildAuthorizationUrl(state));
}

// Step 2: handle the callback, exchange the code, fetch the URN, store tokens.
export async function handleCallback(req, res, next) {
  try {
    const { code, state, error, error_description: errorDescription } = req.query;

    if (error) {
      return res.redirect(
        `/dashboard?linkedin_error=${encodeURIComponent(errorDescription || error)}`
      );
    }

    const expectedState = req.session.linkedinOAuthState;
    delete req.session.linkedinOAuthState;
    if (!state || !expectedState || state !== expectedState) {
      return res.redirect(`/dashboard?linkedin_error=${encodeURIComponent("Invalid OAuth state.")}`);
    }
    if (!code) {
      return res.redirect(`/dashboard?linkedin_error=${encodeURIComponent("Missing authorization code.")}`);
    }

    const tokens = await exchangeCodeForTokens(code);

    // Derive member URN + display name from OIDC userinfo.
    let profile = {};
    try {
      profile = await fetchUserInfo(tokens.access_token);
    } catch {
      // Non-fatal: userinfo may fail if the profile scope is missing. The
      // account still saves; the user can re-authorize for a URN.
      profile = {};
    }

    await saveTokens(req.user.id, tokens, profile);
    res.redirect("/dashboard?linkedin_connected=1");
  } catch (err) {
    next(err);
  }
}

// Disconnect: remove the stored LinkedIn account.
export async function disconnect(req, res, next) {
  try {
    await prisma.linkedInAccount.deleteMany({ where: { userId: req.user.id } });
    res.redirect("/dashboard?linkedin_disconnected=1");
  } catch (err) {
    next(err);
  }
}
