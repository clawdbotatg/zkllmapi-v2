/**
 * e2ee.ts — Venice E2EE client implementation
 *
 * Protocol (per Venice docs — https://docs.venice.ai/overview/guides/tee-e2ee-models):
 *
 *   Encryption (outgoing messages — per-message ephemeral keys):
 *     1. Fetch TEE attestation → get model's public key + verify
 *     2. For each user/system message:
 *        a. Generate ephemeral secp256k1 keypair
 *        b. ECDH(ephemeralPriv, modelPub) → HKDF-SHA256("ecdsa_encryption") → AES key
 *        c. AES-256-GCM encrypt content
 *        d. Output: hex(ephemeralPub‖nonce‖ciphertext)
 *     3. Send messages with encrypted content + E2EE headers
 *
 *   Decryption (incoming response chunks — each chunk independently encrypted):
 *     1. Each SSE chunk content: hex(serverEphemeralPub‖nonce‖ciphertext)
 *     2. ECDH(clientPriv, serverEphemeralPub) → HKDF-SHA256 → AES key
 *     3. AES-256-GCM decrypt
 *
 * Important constraints:
 *   - E2EE requires streaming (Venice rejects stream:false for e2ee-* models)
 *   - Client public key must be uncompressed (130 hex chars, 04 prefix)
 *   - Attestation nonce must be 32 bytes (64 hex chars)
 *   - HKDF info: "ecdsa_encryption", salt: none
 *   - Signing algo header: "ecdsa"
 */

// @ts-ignore — no types for elliptic
import elliptic from "elliptic";
const { ec: EC } = elliptic;
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import crypto from "crypto";
import { Buffer } from "buffer";

const secp256k1 = new (EC as any)("secp256k1");

const ATTESTATION_TTL_MS = 10 * 60 * 1000;
const HKDF_INFO = new TextEncoder().encode("ecdsa_encryption");

const VENICE_BASE_URL = process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VENICE_API_KEY!;

export interface VeniceAttestation {
  verified: boolean;
  nonce: string;
  model: string;
  tee_provider: string;
  signing_key?: string;
  signing_public_key?: string;
  signing_address: string;
}

export interface E2EESession {
  model: string;
  modelPublicKeyHex: string;    // uncompressed, 130 hex chars with 04 prefix
  clientPrivateKey: Uint8Array;  // 32 bytes — for decrypting response chunks
  clientPublicKeyHex: string;    // uncompressed, 130 hex chars with 04 prefix
  fetchedAt: number;
}

const sessionCache = new Map<string, E2EESession>();

function normalizeToUncompressedPubkey(keyHex: string): string {
  if (keyHex.startsWith("04") && keyHex.length === 130) return keyHex;
  if (!keyHex.startsWith("04") && keyHex.length === 128) return "04" + keyHex;
  const key = secp256k1.keyFromPublic(keyHex, "hex");
  return key.getPublic("hex"); // always returns uncompressed
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

// ─── Attestation ─────────────────────────────────────────────────

async function fetchAttestation(model: string): Promise<VeniceAttestation> {
  const nonce = crypto.randomBytes(32).toString("hex"); // 32 bytes required by Venice
  const url = `${VENICE_BASE_URL}/tee/attestation?model=${encodeURIComponent(model)}&nonce=${nonce}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VENICE_API_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attestation fetch failed (${res.status}): ${body}`);
  }

  const att: VeniceAttestation = await res.json();
  if (att.nonce !== nonce) throw new Error("Attestation nonce mismatch — possible replay attack");
  if (!att.verified) throw new Error("Attestation failed server-side verification");

  const signingKey = att.signing_key || att.signing_public_key;
  if (!signingKey) throw new Error("Attestation missing signing key");

  console.log(`[e2ee] attestation verified — provider: ${att.tee_provider}, model: ${att.model}`);
  return att;
}

export async function getE2EESession(model: string): Promise<E2EESession> {
  const cached = sessionCache.get(model);
  if (cached && Date.now() - cached.fetchedAt < ATTESTATION_TTL_MS) return cached;

  const att = await fetchAttestation(model);
  const signingKey = (att.signing_key || att.signing_public_key)!;

  const clientKey = secp256k1.genKeyPair();
  const session: E2EESession = {
    model,
    modelPublicKeyHex: normalizeToUncompressedPubkey(signingKey),
    clientPrivateKey: new Uint8Array(clientKey.getPrivate().toArray("be", 32)),
    clientPublicKeyHex: clientKey.getPublic("hex"), // uncompressed 130 hex
    fetchedAt: Date.now(),
  };

  sessionCache.set(model, session);
  return session;
}

// ─── Per-message encryption ──────────────────────────────────────

/**
 * Encrypt a single plaintext string for Venice E2EE.
 * Generates a per-message ephemeral keypair for forward secrecy.
 * Returns hex: ephemeralPub (65 bytes) ‖ nonce (12 bytes) ‖ AES-GCM ciphertext
 */
export function encryptMessage(plaintext: string, modelPublicKeyHex: string): string {
  const modelKey = secp256k1.keyFromPublic(modelPublicKeyHex, "hex");
  const ephemeralKey = secp256k1.genKeyPair();

  const sharedSecret = ephemeralKey.derive(modelKey.getPublic());
  const sharedBytes = new Uint8Array(sharedSecret.toArray("be", 32));
  const aesKey = hkdf(sha256, sharedBytes, undefined, HKDF_INFO, 32);

  const nonce = crypto.randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext));

  const ephemeralPub = new Uint8Array(ephemeralKey.getPublic(false, "array"));
  const result = new Uint8Array(65 + 12 + encrypted.length);
  result.set(ephemeralPub, 0);
  result.set(nonce, 65);
  result.set(encrypted, 65 + 12);

  return Buffer.from(result).toString("hex");
}

/**
 * Encrypt a messages array. Only user and system messages are encrypted.
 */
export function encryptMessages(
  messages: { role: string; content: string }[],
  modelPublicKeyHex: string,
): { role: string; content: string }[] {
  return messages.map(msg =>
    msg.role === "user" || msg.role === "system"
      ? { ...msg, content: encryptMessage(msg.content, modelPublicKeyHex) }
      : msg,
  );
}

// ─── Per-chunk decryption ────────────────────────────────────────

/**
 * Check if a string is hex-encoded encrypted content.
 * Minimum size: ephemeralPub(65) + nonce(12) + tag(16) = 93 bytes = 186 hex chars
 */
export function isHexEncrypted(s: string): boolean {
  return s.length >= 186 && /^[0-9a-fA-F]+$/.test(s);
}

/**
 * Decrypt a single E2EE response chunk using the client's private key.
 * Input: hex(serverEphemeralPub ‖ nonce ‖ ciphertext)
 */
export function decryptChunk(ciphertextHex: string, clientPrivateKey: Uint8Array): string {
  const raw = hexToBytes(ciphertextHex);

  const serverEphemeralPub = raw.slice(0, 65);
  const nonce = raw.slice(65, 65 + 12);
  const ciphertext = raw.slice(65 + 12);

  const clientKey = secp256k1.keyFromPrivate(Buffer.from(clientPrivateKey));
  const serverKey = secp256k1.keyFromPublic(Buffer.from(serverEphemeralPub));

  const sharedSecret = clientKey.derive(serverKey.getPublic());
  const sharedBytes = new Uint8Array(sharedSecret.toArray("be", 32));
  const aesKey = hkdf(sha256, sharedBytes, undefined, HKDF_INFO, 32);

  const cipher = gcm(aesKey, nonce);
  return new TextDecoder().decode(cipher.decrypt(ciphertext));
}

// ─── High-level helpers ──────────────────────────────────────────

export function buildE2EEHeaders(session: E2EESession): Record<string, string> {
  return {
    "X-Venice-TEE-Client-Pub-Key": session.clientPublicKeyHex,
    "X-Venice-TEE-Model-Pub-Key": session.modelPublicKeyHex,
    "X-Venice-TEE-Signing-Algo": "ecdsa",
  };
}

export function isE2EEModel(model: string): boolean {
  return model.startsWith("e2ee-");
}

/**
 * Full encrypt-request helper. Returns null on failure (attestation unavailable etc).
 */
export async function encryptChatRequest(
  messages: { role: string; content: string }[],
  e2eeModel: string,
): Promise<{
  encryptedMessages: { role: string; content: string }[];
  e2eeHeaders: Record<string, string>;
  session: E2EESession;
} | null> {
  try {
    const session = await getE2EESession(e2eeModel);
    const encryptedMessages = encryptMessages(messages, session.modelPublicKeyHex);
    const e2eeHeaders = buildE2EEHeaders(session);
    console.log(`[e2ee] ${messages.length} message(s) encrypted, client pubkey: ${session.clientPublicKeyHex.slice(0, 20)}...`);
    return { encryptedMessages, e2eeHeaders, session };
  } catch (err: any) {
    console.warn(`[e2ee] encryption failed for "${e2eeModel}": ${err.message}`);
    return null;
  }
}

/**
 * Decrypt an array of encrypted response chunks and return combined plaintext.
 */
export function decryptResponseChunks(chunks: string[], session: E2EESession): string {
  return chunks
    .map(chunk => {
      try {
        return isHexEncrypted(chunk) ? decryptChunk(chunk, session.clientPrivateKey) : chunk;
      } catch (err: any) {
        console.error(`[e2ee] chunk decryption failed: ${err.message}`);
        return "";
      }
    })
    .join("");
}
