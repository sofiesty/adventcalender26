// Seals (timelock-encrypts) each door's content so it can only be decrypted
// once its day has arrived.
//
//   npm run seal           -> reads secret/, writes public/sealed/
//   npm run preview-doors  -> writes demo/sealed/ with YOUR REAL content, every door
//                             already unlocked, so you can see what he'll see.
//                             Local only: demo/ is gitignored and never deployed.
//   npm run seal -- --demo -> writes demo/sealed/ with dummy content that
//                             unlocks over the next few minutes (local testing)
//
// How it works: each door (quote + puzzle + puzzle input) is encrypted with
// drand timelock encryption (tlock) to the drand "quicknet" round at midnight
// on that day. The key for a round does not exist until the drand network
// publishes that round's signature, so nobody (including you) can decrypt
// early, no matter what they do to the page, their clock, or the source code.
//
// Puzzle answers are never stored: see answer-crypto.js.

import { readFile, writeFile, mkdir, rm, mkdtemp, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import sharp from "sharp";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { timelockEncrypt, roundAt, roundTime, defaultChainInfo, Buffer } from "tlock-js";
import { withDrand } from "../drand.js";
import { marked } from "marked";
import { lockReward, normalizeAnswer } from "../answer-crypto.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_DIR = path.join(ROOT, "secret");
const preview = process.argv.includes("--preview");
const demo = preview || process.argv.includes("--demo"); // both write to demo/ (local only)

// Pad payloads to a multiple of this many bytes so ciphertext length doesn't
// hint at how long a message is.
const PAD_TO = 4096;

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".tif", ".tiff", ".heic", ".heif"];

const DEFAULT_REWARD = "Solved! You're brilliant ♥";

// Offset (ms) between UTC and the given time zone at a given instant.
function tzOffset(utcMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - utcMs;
}

// The UTC instant of local midnight on year-month-day in timeZone.
function midnightIn(year, month, day, timeZone) {
  const naive = Date.UTC(year, month - 1, day);
  let t = naive - tzOffset(naive, timeZone);
  t = naive - tzOffset(t, timeZone); // second pass handles DST edges
  return t;
}

// Reads a photo from secret/, shrinks it to at most maxSide pixels on its
// longest side, fixes phone rotation, and returns a JPEG data URL.
// Optional extra turn (degrees clockwise, e.g. 90, 180, -90) and mirroring.
async function photoDataUrl(rel, maxSide, quality, { rotate = 0, mirror = false } = {}) {
  let file = path.join(SECRET_DIR, rel);
  if (!existsSync(file)) throw new Error(`Photo not found: secret/${rel}`);
  const ext = path.extname(file).toLowerCase();
  if (!IMAGE_EXT.includes(ext)) throw new Error(`Unsupported photo type: ${rel} (use jpg, png, webp or heic)`);
  if (ext === ".heic" || ext === ".heif") {
    // iPhone photos: sharp can't read these, but macOS can convert them.
    if (process.platform !== "darwin") throw new Error(`Can't read ${rel} on this computer. Export it as JPG first.`);
    const out = path.join(await mkdtemp(path.join(os.tmpdir(), "advent-")), "photo.jpg");
    execFileSync("sips", ["-s", "format", "jpeg", file, "--out", out], { stdio: "ignore" });
    file = out;
  }
  // First fix the phone's own rotation info, then apply any extra turn/mirror.
  const upright = await sharp(file).rotate().toBuffer();
  let img = sharp(upright);
  const deg = ((Number(rotate) % 360) + 360) % 360;
  if (deg) img = img.rotate(deg);
  if (mirror) img = img.flop();
  const jpg = await img
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

// Validates doorPhotoFocus: "top", "bottom left", "50% 20%", ...
function cssPosition(value, day) {
  if (value == null || value === "") return "center";
  const v = String(value).trim().toLowerCase();
  if (/^((top|bottom|left|right|center|\d{1,3}%)\s*){1,2}$/.test(v)) return v;
  throw new Error(`Door ${day}: doorPhotoFocus "${value}" isn't valid. Use e.g. "top", "bottom", "left", "right", "top left" or "50% 20%".`);
}

// Placeholder "photo" for demo mode.
function demoPhoto(d) {
  const hue = (d * 47) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,30%)"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><text x="200" y="230" font-family="Georgia" font-size="90" fill="white" fill-opacity=".85" text-anchor="middle">photo ${d}</text></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function pad(json) {
  const len = Buffer.byteLength(json);
  const target = Math.ceil((len + 1) / PAD_TO) * PAD_TO;
  return json + " ".repeat(target - len); // trailing spaces are ignored by JSON.parse
}

// Turns a puzzle module into { title, html, input, answer }.
async function buildPuzzle(day) {
  const { rng } = await import(pathToFileURL(path.join(SECRET_DIR, "puzzles", "_util.mjs")).href);
  const file = path.join(SECRET_DIR, "puzzles", `day${String(day).padStart(2, "0")}.mjs`);
  if (!existsSync(file)) throw new Error(`Missing puzzle: secret/puzzles/day${String(day).padStart(2, "0")}.mjs`);
  const p = (await import(pathToFileURL(file).href)).default;
  const input = p.generate(rng(1000 + day));
  const answer = String(p.solve(input));
  const exampleAnswer = String(p.solve(p.example));
  const md = p.story.replaceAll("{{EXAMPLE}}", p.example).replaceAll("{{EXAMPLE_ANSWER}}", exampleAnswer);
  return { title: p.title, html: marked.parse(md), input, answer };
}

async function loadDoors() {
  if (demo && !preview) {
    // Dummy content only. Never put real messages or puzzles in demo output.
    const now = Date.now();
    const doors = {};
    for (let d = 1; d <= 24; d++) {
      // Doors 1-3 already open, the rest unlock one per minute from now.
      const unlockMs = d <= 3 ? now - (4 - d) * 60_000 : now + (d - 3) * 60_000;
      const nums = Array.from({ length: 200 }, (_, i) => ((i * 7919 + d * 31) % 1000) + 1);
      doors[d] = {
        unlockMs,
        content: {
          quote: `This is a placeholder quote for door ${d}. Real content is never used in demo mode.`,
          quoteBy: "Demo",
        },
        puzzle: {
          title: `Demo puzzle ${d}`,
          html: marked.parse(`This is a **demo puzzle**. Your input is a list of numbers, one per line.\n\n\`\`\`\n3\n5\n10\n\`\`\`\n\nFor this example the answer is **18**.\n\n**What is the sum of the numbers in your input?**`),
          input: nums.join("\n"),
          answer: String(nums.reduce((a, b) => a + b, 0)),
        },
        reward: `Demo reward for door ${d}.`,
        doorPhoto: { photo: demoPhoto(d), fit: d === 2 ? "contain" : "cover", focus: "center" },
      };
    }
    return doors;
  }

  const file = path.join(SECRET_DIR, "doors.json");
  if (!existsSync(file)) throw new Error("secret/doors.json not found.");
  const cfg = JSON.parse(await readFile(file, "utf8"));
  const { timezone, year } = cfg;
  const doors = {};
  for (let d = 1; d <= 24; d++) {
    const entry = cfg.doors?.[d];
    if (!entry) throw new Error(`secret/doors.json is missing door ${d}`);
    const content = { quote: entry.quote ?? "", quoteBy: entry.quoteBy ?? "" };
    if (entry.image) content.image = await photoDataUrl(entry.image, 1600, 82);
    const doorPhoto = entry.doorPhoto ? {
      photo: await photoDataUrl(entry.doorPhoto, 700, 78, { rotate: entry.doorPhotoRotate, mirror: entry.doorPhotoMirror }),
      fit: entry.doorPhotoFit === "contain" ? "contain" : "cover",
      focus: cssPosition(entry.doorPhotoFocus, d),
    } : null;
    // In preview mode every door is already unlocked (one minute ago).
    const unlockMs = preview ? Date.now() - 60_000 : midnightIn(year, 12, d, timezone);
    doors[d] = { unlockMs, content, puzzle: await buildPuzzle(d), reward: entry.reward || DEFAULT_REWARD, doorPhoto };
  }
  return doors;
}

const doors = await loadDoors();
const outDir = demo ? path.join(ROOT, "demo", "sealed") : path.join(ROOT, "public", "sealed");
// Build into a temporary folder and only replace the old files once every
// door has been sealed, so a failure never leaves a half-empty calendar.
const buildDir = outDir + ".tmp";
await rm(buildDir, { recursive: true, force: true });
await mkdir(buildDir, { recursive: true });

const index = { chain: defaultChainInfo.hash, sealedAt: new Date().toISOString(), doors: {} };
console.log(preview ? "Building PREVIEW with your real content, all doors unlocked (local only)..." : demo ? "Sealing DEMO doors (dummy content)..." : "Sealing doors from secret/ ...");
for (let d = 1; d <= 24; d++) {
  const { unlockMs, content, puzzle, reward, doorPhoto } = doors[d];
  let round = roundAt(unlockMs, defaultChainInfo);
  if (roundTime(defaultChainInfo, round) < unlockMs) round += 1; // never unlock before midnight
  const unlockAt = new Date(roundTime(defaultChainInfo, round)).toISOString();

  const lock = await lockReward(normalizeAnswer(puzzle.answer), { message: reward });
  const payload = {
    ...content,
    puzzle: { title: puzzle.title, html: puzzle.html, input: puzzle.input, lock },
  };
  const ciphertext = await withDrand((c) => timelockEncrypt(round, Buffer.from(pad(JSON.stringify(payload))), c));

  // The photo behind the door is sealed separately (same unlock time), so the
  // calendar can show photos without downloading every puzzle input.
  // Every door gets a photo file, even without a photo, so nothing leaks.
  const photoPayload = Buffer.from(pad(JSON.stringify(doorPhoto ?? { photo: null })));
  const photoCiphertext = await withDrand((c) => timelockEncrypt(round, photoPayload, c));

  index.doors[d] = { round, unlockAt };
  await writeFile(path.join(buildDir, `${d}.json`), JSON.stringify({ day: d, round, unlockAt, ciphertext }) + "\n");
  await writeFile(path.join(buildDir, `${d}.photo.json`), JSON.stringify({ day: d, round, unlockAt, ciphertext: photoCiphertext }) + "\n");
  console.log(`  door ${String(d).padStart(2)}  unlocks ${unlockAt}  ${puzzle.title.padEnd(22)} (${(ciphertext.length / 1024).toFixed(0)} KB)${doorPhoto ? "  📷" : ""}`);
}
await writeFile(path.join(buildDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
await rm(outDir, { recursive: true, force: true });
await rename(buildDir, outDir);
console.log(`\nWrote ${path.relative(ROOT, outDir)}/`);
