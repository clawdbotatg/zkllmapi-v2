/**
 * e2ee.ts — Browser-compatible Venice E2EE implementation
 *
 * Uses @noble/curves (available via viem) for secp256k1 ECDH,
 * @noble/hashes for HKDF-SHA256, and @noble/ciphers for AES-256-GCM.
 *
 * Protocol matches the proxy implementation exactly:
 *   Encrypt: ephemeral ECDH → HKDF("ecdsa_encryption") → AES-GCM
 *   Decrypt: client ECDH with server ephemeral → same KDF → AES-GCM
 */
import { gcm } from "@noble/ciphers/aes";
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha2";

const HKDF_INFO = new TextEncoder().encode("ecdsa_encryption");
const ATTESTATION_TTL_MS = 10 * 60 * 1000;
const E2EE_MODEL = "e2ee-glm-5";

export interface E2EESession {
  model: string;
  modelPublicKeyHex: string;
  clientPrivateKey: Uint8Array;
  clientPublicKeyHex: string;
  fetchedAt: number;
}

let cachedSession: E2EESession | null = null;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

function normalizeToUncompressedPubkey(keyHex: string): string {
  if (keyHex.startsWith("04") && keyHex.length === 130) return keyHex;
  if (!keyHex.startsWith("04") && keyHex.length === 128) return "04" + keyHex;
  const point = secp256k1.ProjectivePoint.fromHex(keyHex);
  return bytesToHex(point.toRawBytes(false));
}

function ecdhSharedSecret(privateKey: Uint8Array, publicKeyHex: string): Uint8Array {
  const sharedPoint = secp256k1.getSharedSecret(privateKey, publicKeyHex, false);
  // x-coordinate only (bytes 1-33 of uncompressed point), matching elliptic's derive()
  return sharedPoint.slice(1, 33);
}

// ─── Attestation ─────────────────────────────────────────────────

export async function fetchAttestation(apiUrl: string): Promise<E2EESession> {
  if (cachedSession && Date.now() - cachedSession.fetchedAt < ATTESTATION_TTL_MS) {
    return cachedSession;
  }

  const nonce = bytesToHex(randomBytes(32));
  const url = `${apiUrl}/v1/tee/attestation?model=${encodeURIComponent(E2EE_MODEL)}&nonce=${nonce}`;

  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attestation fetch failed (${res.status}): ${body}`);
  }

  const att = await res.json();
  if (att.nonce !== nonce) throw new Error("Attestation nonce mismatch");
  if (!att.verified) throw new Error("Attestation verification failed");

  const signingKey = att.signing_key || att.signing_public_key;
  if (!signingKey) throw new Error("Attestation missing signing key");

  const clientPrivateKey = secp256k1.utils.randomPrivateKey();
  const clientPublicKey = secp256k1.getPublicKey(clientPrivateKey, false);

  const session: E2EESession = {
    model: E2EE_MODEL,
    modelPublicKeyHex: normalizeToUncompressedPubkey(signingKey),
    clientPrivateKey,
    clientPublicKeyHex: bytesToHex(clientPublicKey),
    fetchedAt: Date.now(),
  };

  cachedSession = session;
  return session;
}

// ─── Encryption ──────────────────────────────────────────────────

function encryptMessage(plaintext: string, modelPublicKeyHex: string): string {
  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, false); // 65 bytes uncompressed

  const shared = ecdhSharedSecret(ephemeralPriv, modelPublicKeyHex);
  const aesKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const nonce = randomBytes(12);
  const cipher = gcm(aesKey, nonce);
  const encrypted = cipher.encrypt(new TextEncoder().encode(plaintext));

  const result = new Uint8Array(65 + 12 + encrypted.length);
  result.set(ephemeralPub, 0);
  result.set(nonce, 65);
  result.set(encrypted, 65 + 12);

  return bytesToHex(result);
}

export function encryptMessages(
  messages: { role: string; content: string }[],
  modelPublicKeyHex: string,
): { role: string; content: string }[] {
  // Venice E2EE requires ALL message content to be encrypted when TEE headers are present.
  // Encrypt user, system, AND assistant messages — mixed plaintext/ciphertext causes 400 errors.
  return messages.map(msg => ({ ...msg, content: encryptMessage(msg.content, modelPublicKeyHex) }));
}

// ─── Decryption ──────────────────────────────────────────────────

function isHexEncrypted(s: string): boolean {
  return s.length >= 186 && /^[0-9a-fA-F]+$/.test(s);
}

function decryptChunk(ciphertextHex: string, clientPrivateKey: Uint8Array): string {
  const raw = hexToBytes(ciphertextHex);

  const serverEphemeralPubHex = bytesToHex(raw.slice(0, 65));
  const nonce = raw.slice(65, 65 + 12);
  const ciphertext = raw.slice(65 + 12);

  const shared = ecdhSharedSecret(clientPrivateKey, serverEphemeralPubHex);
  const aesKey = hkdf(sha256, shared, undefined, HKDF_INFO, 32);

  const cipher = gcm(aesKey, nonce);
  return new TextDecoder().decode(cipher.decrypt(ciphertext));
}

export function decryptResponseChunks(chunks: string[], clientPrivateKey: Uint8Array): string {
  return chunks
    .map(chunk => {
      try {
        return isHexEncrypted(chunk) ? decryptChunk(chunk, clientPrivateKey) : chunk;
      } catch {
        return "";
      }
    })
    .join("");
}

// ─── Headers ─────────────────────────────────────────────────────

export function buildE2EEHeaders(session: E2EESession): Record<string, string> {
  return {
    "X-Venice-TEE-Client-Pub-Key": session.clientPublicKeyHex,
    "X-Venice-TEE-Model-Pub-Key": session.modelPublicKeyHex,
    "X-Venice-TEE-Signing-Algo": "ecdsa",
  };
}
