import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password verifier: scrypt (Node's built-in KDF, no extra dependency) with a
 * per-password random salt. Stored as `scrypt:N:r:p:saltHex:hashHex` so the
 * cost parameters travel with the hash and can be tuned later without
 * invalidating existing rows.
 */

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

const N = 16384; // CPU/memory cost
const r = 8;
const p = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(password, salt, KEY_LEN, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Constant-time verify. Returns false (never throws) on a malformed stored hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const costN = Number.parseInt(nStr!, 10);
  const costR = Number.parseInt(rStr!, 10);
  const costP = Number.parseInt(pStr!, 10);
  if (!Number.isFinite(costN) || !Number.isFinite(costR) || !Number.isFinite(costP)) return false;
  const salt = Buffer.from(saltHex!, 'hex');
  const expected = Buffer.from(hashHex!, 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scrypt(password, salt, expected.length, { N: costN, r: costR, p: costP });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
