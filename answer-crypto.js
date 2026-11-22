// Answer checking without storing the answer.
//
// Each puzzle has a small "reward" message that is AES-GCM encrypted with a key
// derived from the correct answer (PBKDF2-SHA256, many iterations). Checking an
// answer = trying to decrypt the reward with it. The answer itself is never
// stored anywhere, and the slow key derivation makes brute-forcing expensive.
//
// Shared by scripts/seal.mjs (Node) and the browser; both have WebCrypto.

export const ITERATIONS = 600_000;

export const normalizeAnswer = (s) => String(s).trim().replace(/\s+/g, "").toLowerCase();

const enc = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(answer, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", enc.encode(normalizeAnswer(answer)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function lockReward(answer, reward) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(answer, salt, ITERATIONS);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(JSON.stringify(reward)));
  return { salt: b64(salt), iv: b64(iv), iterations: ITERATIONS, ct: b64(ct) };
}

// Returns the reward object if the answer is right, otherwise null.
export async function tryAnswer(answer, lock) {
  try {
    const key = await deriveKey(answer, unb64(lock.salt), lock.iterations);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(lock.iv) }, key, unb64(lock.ct));
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
