import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Envelope encryption of each org's role password.
// Format on disk (base64): iv (12 bytes) | auth tag (16 bytes) | ciphertext
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function loadKey(masterKeyHex: string): Buffer {
  const key = Buffer.from(masterKeyHex, "hex");
  if (key.length !== 32) {
    throw new Error("MCP_MASTER_KEY must be 32 bytes (64 hex chars).");
  }
  return key;
}

export function encryptSecret(plaintext: string, masterKeyHex: string): string {
  const key = loadKey(masterKeyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(payloadBase64: string, masterKeyHex: string): string {
  const key = loadKey(masterKeyHex);
  const buf = Buffer.from(payloadBase64, "base64");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
