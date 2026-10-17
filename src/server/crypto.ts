import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * AES-256-GCM for secrets stored in the database (Google refresh tokens).
 * Format: "v1:" + base64url(iv | tag | ciphertext). A wrong key or a modified
 * value fails to decrypt instead of returning garbage.
 */
function key(): Buffer {
  const k = env().TOKEN_ENCRYPTION_KEY;
  if (k) {
    // Either 32 random bytes in base64 (openssl rand -base64 32), or a long random passphrase
    // (40+ characters), which is stretched to 32 bytes with SHA-256.
    const buf = /^[A-Za-z0-9+/]{43}=$/.test(k) ? Buffer.from(k, "base64") : null;
    if (buf?.length === 32) return buf;
    if (k.length >= 40) return createHash("sha256").update(k, "utf8").digest();
    throw new Error("TOKEN_ENCRYPTION_KEY must be 32 random bytes in base64, or a random passphrase of at least 40 characters.");
  }
  if (env().GOOGLE_MODE === "real") throw new Error("TOKEN_ENCRYPTION_KEY is not set.");
  // Local review only (fake Google, local database): a fixed development key.
  return createHash("sha256").update("ammar-crm-local-development-key").digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return "v1:" + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function decryptSecret(stored: string): string {
  if (!stored.startsWith("v1:")) throw new Error("Unknown secret format.");
  const raw = Buffer.from(stored.slice(3), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
}

/** HMAC signature for short-lived values handed to the browser (e.g. an uploaded receipt). */
export function signValue(value: string): string {
  return createHmac("sha256", key()).update("sign:" + value).digest("base64url");
}

export function verifySignature(value: string, sig: string): boolean {
  const expected = Buffer.from(signValue(value));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
