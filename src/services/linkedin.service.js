// LinkedIn OAuth + publishing integration.
// Uses OpenID Connect for sign-in (to obtain the member URN via `sub`) and the
// versioned REST Posts API for publishing.

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const POSTS_URL = "https://api.linkedin.com/rest/posts";
const IMAGES_URL = "https://api.linkedin.com/rest/images";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function apiVersion() {
  return process.env.LINKEDIN_API_VERSION || "202605";
}

export function getScopes() {
  return (process.env.LINKEDIN_SCOPES || "openid profile email w_member_social").trim();
}

// Build the authorization URL the user is redirected to. `state` is a CSRF
// token we generate and verify on callback.
export function buildAuthorizationUrl(state) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: requireEnv("LINKEDIN_CLIENT_ID"),
    redirect_uri: requireEnv("LINKEDIN_REDIRECT_URI"),
    state,
    scope: getScopes(),
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Exchange an authorization code for tokens.
export async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: requireEnv("LINKEDIN_REDIRECT_URI"),
    client_id: requireEnv("LINKEDIN_CLIENT_ID"),
    client_secret: requireEnv("LINKEDIN_CLIENT_SECRET"),
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${errorBody}`);
  }
  return res.json(); // { access_token, expires_in, refresh_token?, refresh_token_expires_in?, scope }
}

// Refresh an access token using a refresh token (only available for apps with
// programmatic refresh enabled).
export async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: requireEnv("LINKEDIN_CLIENT_ID"),
    client_secret: requireEnv("LINKEDIN_CLIENT_SECRET"),
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${errorBody}`);
  }
  return res.json();
}

// Fetch OIDC userinfo to derive the member URN and display name.
export async function fetchUserInfo(accessToken) {
  const res = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Failed to fetch userinfo: ${res.status} ${errorBody}`);
  }
  const data = await res.json(); // { sub, name, email, ... }
  return {
    personUrn: data.sub ? `urn:li:person:${data.sub}` : null,
    displayName: data.name || data.email || null,
    raw: data,
  };
}

// Upload a single image to LinkedIn and return its image URN.
// Three steps: initialize upload -> PUT the binary -> the URN is usable in a post.
export async function uploadImageToLinkedIn({ accessToken, authorUrn, buffer, mimeType }) {
  // 1. Initialize the upload to get a one-time upload URL + the image URN.
  const initRes = await fetch(`${IMAGES_URL}?action=initializeUpload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": apiVersion(),
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify({ initializeUploadRequest: { owner: authorUrn } }),
  });
  if (!initRes.ok) {
    const errorBody = await initRes.text();
    throw new Error(`LinkedIn image init failed: ${initRes.status} ${errorBody}`);
  }
  const { value } = await initRes.json();
  const uploadUrl = value?.uploadUrl;
  const imageUrn = value?.image;
  if (!uploadUrl || !imageUrn) {
    throw new Error("LinkedIn image init returned no upload URL.");
  }

  // 2. PUT the raw image bytes to the upload URL.
  const putRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": mimeType || "application/octet-stream",
    },
    body: buffer,
  });
  if (!putRes.ok) {
    const errorBody = await putRes.text();
    throw new Error(`LinkedIn image upload failed: ${putRes.status} ${errorBody}`);
  }

  return imageUrn;
}

// Publish a post and return its URN (from the x-restli-id header). Pass
// `mediaUrns` (array of image URNs) to attach images; empty = text-only.
export async function publishLinkedInTextPost({ accessToken, authorUrn, body, mediaUrns = [] }) {
  const payload = {
    author: authorUrn,
    commentary: body,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };

  // Attach media: single image -> content.media, multiple -> content.multiImage.
  if (mediaUrns.length === 1) {
    payload.content = { media: { id: mediaUrns[0] } };
  } else if (mediaUrns.length > 1) {
    payload.content = { multiImage: { images: mediaUrns.map((id) => ({ id })) } };
  }

  const response = await fetch(POSTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": apiVersion(),
      "X-Restli-Protocol-Version": "2.0.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`LinkedIn publish failed: ${response.status} ${errorBody}`);
  }

  return response.headers.get("x-restli-id");
}
