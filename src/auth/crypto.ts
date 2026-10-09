// Primitives shared by device, session and password code. All WebCrypto, no deps.

const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return toHex(new Uint8Array(digest));
}

// Deliberately low for Workers Free (10 ms CPU/request). Access + device gate
// carry the real weight; see docs/DECISIONS.md.
export const PBKDF2_ITERATIONS = 25_000;

export async function hashPassword(
  password: string,
  saltHex = randomToken(16),
  iterations = PBKDF2_ITERATIONS,
): Promise<{ hash: string; salt: string; iterations: number }> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: fromHex(saltHex), iterations },
    key,
    256,
  );
  return { hash: toHex(new Uint8Array(bits)), salt: saltHex, iterations };
}

export async function verifyPassword(
  password: string,
  stored: { hash: string; salt: string; iterations: number },
): Promise<boolean> {
  const { hash } = await hashPassword(password, stored.salt, stored.iterations);
  return timingSafeEqualHex(hash, stored.hash);
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toHex(buf: Uint8Array): string {
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
