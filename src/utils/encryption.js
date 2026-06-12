import crypto from "node:crypto";

// AES-256-GCM authenticated encryption for LinkedIn tokens at rest.
// Stored format: base64(iv).base64(authTag).base64(ciphertext)

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce recommended for GCM

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set.");
  }

  // Accept hex (64 chars), base64, or a raw 32-char string.
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    const b64 = Buffer.from(raw, "base64");
    key = b64.length === 32 ? b64 : Buffer.from(raw, "utf8");
  }

  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes (e.g. `openssl rand -hex 32`).");
  }
  return key;
}

export function encryptToken(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(".");
}

export function decryptToken(payload) {
  if (payload == null) return null;
  const parts = String(payload).split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted token.");
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
