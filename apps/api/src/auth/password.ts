import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// scrypt parameters (N=2^15, r=8, p=1) — OWASP-recommended minimum for interactive logins.
const N = 32768;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEY_LEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

/** Returns "scrypt$N$r$p$saltB64$hashB64". */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64");
  const actual = await derive(password, Buffer.from(saltB64, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A valid hash of a random password, used to keep login timing uniform for unknown emails. */
export const DUMMY_HASH_PROMISE = hashPassword(randomBytes(16).toString("hex"));
