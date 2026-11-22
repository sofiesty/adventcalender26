import {
  loadIndex, openDoor, TooEarlyError, tryAnswer, solvedAnswer, markSolved,
  formatUnlock, calendarUrl, toast, startSnow,
} from "./lib.js";

const $ = (id) => document.getElementById(id);
const day = Number(new URLSearchParams(location.search).get("day"));

$("back").href = calendarUrl();
startSnow($("snow"));

function fail(msg) {
  $("status").textContent = msg;
  $("status").classList.add("error");
}

async function init() {
  if (!Number.isInteger(day) || day < 1 || day > 24) return fail("That's not a day in December. Go back to the calendar!");
  $("day-label").textContent = `December ${day}`;
  document.title = `Day ${day} · Puzzle`;

  let index;
  try { index = await loadIndex(); } catch { return fail("Couldn't load the calendar 😢"); }

  let content;
  try {
    content = await openDoor(day);
  } catch (err) {
    if (err instanceof TooEarlyError) return fail(`Nice try 😏 This puzzle unlocks ${formatUnlock(index.doors[day].unlockAt)}.`);
    console.error(err);
    return fail("Couldn't reach the time network. Check your internet and try again.");
  }
  render(content.puzzle);
}

function render(puzzle) {
  $("status").hidden = true;
  $("puzzle").hidden = false;
  $("title").textContent = `Day ${day}: ${puzzle.title}`;
  document.title = `Day ${day}: ${puzzle.title}`;
  // The HTML was produced by the seal script from puzzle files we wrote ourselves.
  $("body").innerHTML = puzzle.html;

  const input = puzzle.input;
  const lines = input.split("\n").length;
  $("input-info").textContent = `${lines.toLocaleString()} line${lines === 1 ? "" : "s"}, ${(new Blob([input]).size / 1024).toFixed(1)} KB. Solve it any way you like.`;

  const blobUrl = () => URL.createObjectURL(new Blob([input + "\n"], { type: "text/plain;charset=utf-8" }));
  $("view-input").onclick = () => window.open(blobUrl(), "_blank");
  $("download-input").onclick = () => {
    const a = document.createElement("a");
    a.href = blobUrl();
    a.download = `day${String(day).padStart(2, "0")}-input.txt`;
    a.click();
  };
  $("copy-input").onclick = async () => {
    try { await navigator.clipboard.writeText(input + "\n"); toast("Input copied 📋"); }
    catch { toast("Couldn't copy. Try the download button instead."); }
  };

  $("answer-form").onsubmit = async (e) => {
    e.preventDefault();
    const answer = $("answer").value;
    if (!answer.trim()) return;
    $("submit").disabled = true;
    $("feedback").className = "feedback";
    $("feedback").textContent = "Checking…";
    const reward = await tryAnswer(answer, puzzle.lock);
    $("submit").disabled = false;
    if (reward) {
      markSolved(day, answer.trim());
      showReward(reward, answer.trim(), true);
    } else {
      $("feedback").className = "feedback wrong";
      $("feedback").textContent = "That's not the right answer. Keep going, you've got this!";
      $("answer").select();
    }
  };

  // Already solved on an earlier visit: unlock the reward again with the saved answer.
  const saved = solvedAnswer(day);
  if (saved) tryAnswer(saved, puzzle.lock).then((reward) => reward && showReward(reward, saved, false));
}

function showReward(reward, answer, celebrate) {
  $("answer-panel").hidden = true;
  $("reward").hidden = false;
  $("reward-message").textContent = reward.message;
  $("solved-answer").textContent = answer;
  if (celebrate) {
    $("reward").classList.add("celebrate");
    $("reward").scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

init();
