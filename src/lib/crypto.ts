/**
 * Cryptographic primitives built on Web Crypto (available in Workers and Node ≥ 20).
 *
 * Password hashing: PBKDF2-HMAC-SHA256.
 *   - Argon2id is not available natively in Workers' Web Crypto, and Workers cap
 *     PBKDF2 at 100,000 iterations, so we use PBKDF2-SHA256 at that ceiling with
 *     a 16-byte random salt and a 32-byte derived key.
 *   - Hashes are self-describing (`pbkdf2_sha256$<iter>$<salt>$<hash>`), so the
 *     parameters can be raised later; `needsRehash` triggers transparent
 *     re-hashing on the next successful login.
 */

const encoder = new TextEncoder();

export const PASSWORD_HASH_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (const b of u) out += b.toString(16).padStart(2, '0');
  return out;
}

/** 256-bit URL-safe secret token (sessions, one-time links, upload grants). */
export const randomToken = (bytes = 32): string => toBase64Url(randomBytes(bytes));

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lower-case

/** Opaque, non-sequential identifier such as `usr_k3j9…`. */
export function newId(prefix: string, length = 22): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ID_ALPHABET[b & 31];
  return `${prefix}_${out}`;
}

export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data as BufferSource));
}

const hmacKeys = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeys.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
      'verify',
    ]);
    hmacKeys.set(secret, k);
  }
  return k;
}

export async function hmacHex(secret: string, data: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(data));
  return toHex(sig);
}

/** Constant-time string comparison (length is not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password.normalize('NFKC')), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, iterations = PASSWORD_HASH_ITERATIONS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_HASH_ITERATIONS) return false;
  const salt = fromBase64Url(parts[2]!);
  const expected = parts[3]!;
  const actual = toBase64Url(await pbkdf2(password, salt, iterations));
  return timingSafeEqual(actual, expected);
}

export function needsRehash(stored: string, iterations = PASSWORD_HASH_ITERATIONS): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'pbkdf2_sha256' || Number(parts[1]) !== iterations;
}

/** A fixed dummy hash used to equalize timing when the account does not exist. */
let dummyHash: Promise<string> | undefined;
export function getDummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(toBase64Url(randomBytes(16)));
  return dummyHash;
}
