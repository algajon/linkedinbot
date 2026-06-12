import { prisma } from "../lib/prisma.js";
import { encryptToken, decryptToken } from "../utils/encryption.js";
import { refreshAccessToken } from "./linkedin.service.js";

// Persist token data (from an OAuth exchange/refresh) for a user, encrypting
// the secrets. `profile` optionally carries the derived URN / display name.
export async function saveTokens(userId, tokenResponse, profile = {}) {
  const now = Date.now();
  const tokenExpiresAt = tokenResponse.expires_in
    ? new Date(now + tokenResponse.expires_in * 1000)
    : null;
  const refreshExpiresAt = tokenResponse.refresh_token_expires_in
    ? new Date(now + tokenResponse.refresh_token_expires_in * 1000)
    : null;
  const scopes = (tokenResponse.scope || "").split(/[ ,]+/).filter(Boolean);

  const data = {
    accessTokenEncrypted: encryptToken(tokenResponse.access_token),
    refreshTokenEncrypted: tokenResponse.refresh_token
      ? encryptToken(tokenResponse.refresh_token)
      : null,
    tokenExpiresAt,
    refreshExpiresAt,
    scopes,
  };
  if (profile.personUrn !== undefined) data.linkedinPersonUrn = profile.personUrn;
  if (profile.displayName !== undefined) data.linkedinDisplayName = profile.displayName;

  return prisma.linkedInAccount.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

const EXPIRY_SKEW_MS = 60 * 1000; // refresh a minute early

// Return a usable decrypted access token for an account, refreshing it first if
// it is expired/expiring and a refresh token is available. Throws a clear error
// if the user must reconnect.
export async function getValidAccessToken(account) {
  if (!account) throw new Error("LinkedIn account not connected.");

  const expired =
    account.tokenExpiresAt &&
    account.tokenExpiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();

  if (!expired) {
    return decryptToken(account.accessTokenEncrypted);
  }

  // Token is expired/expiring — try to refresh.
  if (!account.refreshTokenEncrypted) {
    throw new Error("LinkedIn token expired and no refresh token is available. Please reconnect LinkedIn.");
  }
  if (account.refreshExpiresAt && account.refreshExpiresAt.getTime() <= Date.now()) {
    throw new Error("LinkedIn session fully expired. Please reconnect LinkedIn.");
  }

  const refreshToken = decryptToken(account.refreshTokenEncrypted);
  const refreshed = await refreshAccessToken(refreshToken);
  const updated = await saveTokens(account.userId, refreshed);
  return decryptToken(updated.accessTokenEncrypted);
}
