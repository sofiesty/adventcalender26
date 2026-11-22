// Shared logic for the calendar and puzzle pages.
//
// Security model: every door's content is timelock-encrypted (scripts/seal.mjs).
// Its decryption key only comes into existence when the drand network publishes
// the beacon for that door's round, at midnight on its day. The local clock is
// never trusted: "now" comes from drand's latest round, and even if someone
// fakes that, decryption itself is impossible before the real round.

import { timelockDecrypt, roundTime, defaultChainInfo } from "tlock-js";
import { withDrand } from "./drand.js";
export { tryAnswer } from "./answer-crypto.js";

// Demo mode (dummy content that unlocks over a few minutes) only exists in the
// dev server, never in the built site.
export const DEMO = import.meta.env.DEV && new URLSearchParams(location.search).has("demo");
// Works both at the site root (dev server) and in a subfolder (GitHub Pages).
const ROOT = import.meta.env.BASE_URL; // always ends with "/"
const BASE = DEMO ? "/demo/sealed" : `${ROOT}sealed`;
const STORE = DEMO ? "advent-demo" : "advent";


export async function loadIndex() {
  const res = await fetch(`${BASE}/index.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`index ${res.status}`);
  return res.json();
}

// Current time according to drand (ms), or null if unreachable.
export async function drandNow() {
  try {
    const beacon = await withDrand((c) => c.latest());
    return roundTime(defaultChainInfo, beacon.round);
  } catch {
    return null;
  }
}

export class TooEarlyError extends Error {}

const memory = {};
// Decrypts a door. Throws TooEarlyError if the day hasn't really arrived.
export async function openDoor(day) {
  if (memory[day]) return memory[day];
  const res = await fetch(`${BASE}/${day}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`door ${res.status}`);
  const { ciphertext } = await res.json();
  try {
    const plain = await withDrand((c) => timelockDecrypt(ciphertext, c));
    memory[day] = JSON.parse(new TextDecoder().decode(plain));
    markOpened(day);
    return memory[day];
  } catch (err) {
    if (/too early/i.test(err?.message ?? "")) throw new TooEarlyError();
    throw err;
  }
}

// Decrypts the photo behind a door: { photo, fit, focus } (photo may be null).
// Cached in the browser after the first successful decrypt, so the calendar
// loads fast next time. `version` (the seal time) makes a re-seal refresh the
// cache. Only legitimately unlocked photos can ever end up in the cache.
export async function openPhoto(day, version) {
  const prefix = `${STORE}-photo-`;
  const key = `${prefix}${version}-${day}`;
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch { /* storage blocked or bad entry */ }
  const res = await fetch(`${BASE}/${day}.photo.json`, { cache: "no-store" });
  if (!res.ok) return { photo: null };
  const { ciphertext } = await res.json();
  let data;
  try {
    const plain = await withDrand((c) => timelockDecrypt(ciphertext, c));
    data = JSON.parse(new TextDecoder().decode(plain));
  } catch (err) {
    if (/too early/i.test(err?.message ?? "")) throw new TooEarlyError();
    throw err;
  }
  try {
    // Drop cached photos from older seals, then cache this one.
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix) && !k.startsWith(`${prefix}${version}-`)) localStorage.removeItem(k);
    }
    localStorage.setItem(key, JSON.stringify(data));
  } catch { /* storage full: just don't cache */ }
  return data;
}

// ---------- Local progress (per browser) ----------
function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function save(state) {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* storage blocked */ }
}
export const isOpened = (day) => !!load().opened?.[day];
export function markOpened(day) {
  const s = load();
  (s.opened ??= {})[day] = true;
  save(s);
}
// The correct answer is saved after solving, so the reward can be re-unlocked on later visits.
export const solvedAnswer = (day) => load().solved?.[day] ?? null;
export function markSolved(day, answer) {
  const s = load();
  (s.solved ??= {})[day] = answer;
  save(s);
}

export function formatUnlock(unlockAt) {
  const d = new Date(unlockAt);
  if (DEMO) return "at " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return "on " + d.toLocaleDateString([], { day: "numeric", month: "long" });
}

export const puzzleUrl = (day) => `${ROOT}puzzle.html?day=${day}${DEMO ? "&demo" : ""}`;
export const calendarUrl = () => `${ROOT}${DEMO ? "?demo" : ""}`;

let toastTimer;
export function toast(text) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

// ---------- Snow ----------
export function startSnow(canvas) {
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let flakes = [];
  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const count = Math.round(window.innerWidth / 8);
    flakes = Array.from({ length: count }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      r: Math.random() * 2.2 + 0.6,
      speed: Math.random() * 0.6 + 0.25,
      drift: Math.random() * 0.6 - 0.3,
      phase: Math.random() * Math.PI * 2,
    }));
  }
  function tick(t) {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    for (const f of flakes) {
      f.y += f.speed;
      f.x += f.drift + Math.sin(t / 1600 + f.phase) * 0.25;
      if (f.y > window.innerHeight + 5) { f.y = -5; f.x = Math.random() * window.innerWidth; }
      if (f.x > window.innerWidth + 5) f.x = -5;
      if (f.x < -5) f.x = window.innerWidth + 5;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduceMotion) requestAnimationFrame(tick);
  }
  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(tick);
}
