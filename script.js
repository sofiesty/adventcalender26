import {
  loadIndex, drandNow, openDoor, openPhoto, TooEarlyError, isOpened, solvedAnswer,
  formatUnlock, puzzleUrl, toast, startSnow, DEMO,
} from "./lib.js";

// ---------- Door layout ----------
// Fixed, hand-picked shuffle so the order looks playful but stays the same every visit.
const order = [7, 15, 2, 24, 19, 11, 4, 22, 9, 1, 17, 13, 6, 20, 3, 14, 10, 23, 5, 18, 12, 8, 21, 16];

// Some doors get a different size for a more interesting grid.
// Desktop (6 columns): 24 doors + extra cells = 36 = 6 full rows.
const sizes = {
  24: "big",
  6: "wide", 12: "wide", 1: "wide", 14: "wide", 22: "wide",
  17: "tall", 3: "tall", 20: "tall", 9: "tall",
};

const themes = ["cream", "berry", "pine", "gold"];
const patterns = ["plain", "dots", "stripes"];

const calendar = document.getElementById("calendar");
const doorEls = {};
let index = null;
let now = null; // ms, from drand

// ---------- Build doors ----------
order.forEach((day, i) => {
  const door = document.createElement("button");
  door.className = "door locked" + (sizes[day] ? ` ${sizes[day]}` : "");
  door.dataset.day = day;
  door.dataset.theme = themes[(day * 7) % themes.length];
  door.dataset.pattern = patterns[(day * 5 + i) % patterns.length];
  door.setAttribute("aria-label", `Door ${day}`);

  door.innerHTML = `
    <div class="door-inside"><span class="door-heart">♥</span></div>
    <div class="door-front">
      <span class="number">${day}</span>
      ${day === 24 ? '<span class="label">Christmas Eve</span>' : ""}
      <span class="lock" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5Zm-3 8V7a3 3 0 1 1 6 0v3H9Z"/></svg>
      </span>
    </div>
  `;
  if (isOpened(day)) door.classList.add("open");
  if (solvedAnswer(day)) door.classList.add("solved");

  door.addEventListener("click", () => onDoorClick(day));
  doorEls[day] = door;
  calendar.appendChild(door);
});

// ---------- Photos behind the doors ----------
async function showPhoto(day) {
  try {
    const { photo, fit, focus } = await openPhoto(day, index?.sealedAt ?? "");
    if (!photo) return;
    const inside = doorEls[day].querySelector(".door-inside");
    if (inside.querySelector("img")) return;
    const img = new Image();
    img.alt = "";
    img.style.objectFit = fit === "contain" ? "contain" : "cover";
    img.style.objectPosition = focus || "center";
    img.onload = () => inside.classList.add("has-photo");
    img.src = photo;
    if (fit === "contain") {
      // Blurred copy of the photo fills the empty space around it.
      const bg = new Image();
      bg.alt = "";
      bg.className = "photo-backdrop";
      bg.src = photo;
      inside.prepend(bg);
      bg.after(img);
    } else {
      inside.prepend(img);
    }
  } catch { /* not unlocked or offline: keep the heart */ }
}

// ---------- Locks ----------
function isUnlocked(day) {
  if (!index) return false;
  return (now ?? Date.now()) >= Date.parse(index.doors[day].unlockAt); // fallback only affects the padlock icon
}
function refreshLocks() {
  for (const day in doorEls) doorEls[day].classList.toggle("locked", !isUnlocked(day));
}

// ---------- Opening ----------
async function onDoorClick(day) {
  const door = doorEls[day];
  if (!index) return toast("Still loading, try again in a second ✨");
  if (!isUnlocked(day) && !isOpened(day)) {
    shake(door);
    return toast(`Patience! Door ${day} opens ${formatUnlock(index.doors[day].unlockAt)} ♥`);
  }
  door.classList.add("busy");
  try {
    const content = await openDoor(day);
    showPhoto(day);
    const wasOpen = door.classList.contains("open");
    door.classList.add("open");
    setTimeout(() => showContent(day, content), wasOpen ? 0 : 550);
  } catch (err) {
    shake(door);
    if (err instanceof TooEarlyError) toast("Nice try 😏 The universe says it's not that day yet.");
    else { console.error(err); toast("Couldn't reach the time network. Check your internet and try again."); }
  } finally {
    door.classList.remove("busy");
  }
}

function shake(el) {
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

// ---------- Modal ----------
const modal = document.getElementById("modal");
function showContent(day, content) {
  modal.querySelector(".modal-day").textContent = `December ${day}`;
  modal.querySelector(".modal-quote").textContent = content.quote || "";
  const by = modal.querySelector(".modal-by");
  by.textContent = content.quoteBy ? `— ${content.quoteBy}` : "";
  by.hidden = !content.quoteBy;
  const img = modal.querySelector(".modal-image");
  if (content.image) { img.src = content.image; img.hidden = false; }
  else { img.removeAttribute("src"); img.hidden = true; }

  const link = modal.querySelector(".puzzle-link");
  link.href = puzzleUrl(day);
  link.querySelector(".puzzle-name").textContent = content.puzzle?.title ?? "Today's puzzle";
  link.classList.toggle("done", !!solvedAnswer(day));
  modal.showModal();
}
modal.querySelector(".modal-close").addEventListener("click", () => modal.close());
modal.addEventListener("click", (e) => { if (e.target === modal) modal.close(); });

// ---------- Startup ----------
async function init() {
  try {
    index = await loadIndex();
  } catch {
    return toast(DEMO ? "No demo data. Run: npm run seal -- --demo" : "Couldn't load the calendar 😢");
  }
  now = await drandNow();
  refreshLocks();
  // Bring back the photos of doors opened on earlier visits.
  for (const day in doorEls) if (isOpened(day)) showPhoto(day);
  // Keep the padlocks in sync (e.g. if the page is left open past midnight).
  setInterval(async () => {
    now = (await drandNow()) ?? now;
    refreshLocks();
  }, DEMO ? 10_000 : 60_000);
}
init();
startSnow(document.getElementById("snow"));
