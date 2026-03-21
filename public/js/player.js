const socket = io();

// --- Theme ---
function applyTheme(theme) {
  if (theme && theme !== "default") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

// --- DOM refs ---
const joinScreen = document.getElementById("join-screen");
const buzzerScreen = document.getElementById("buzzer-screen");
const joinForm = document.getElementById("join-form");
const nameInput = document.getElementById("name-input");
const errorMsg = document.getElementById("error-msg");
const displayName = document.getElementById("display-name");
const buzzBtn = document.getElementById("buzz-btn");
const buzzStatus = document.getElementById("buzz-status");
const playerScoreEl = document.getElementById("player-score");
const chanceBetForm = document.getElementById("chance-bet-form");
const chanceBetInput = document.getElementById("chance-bet-input");
const chanceLockBtn = document.getElementById("chance-lock-btn");
const chanceAnswerLabel = document.getElementById("chance-answer-label");
const chanceAnswerInput = document.getElementById("chance-answer-input");
const chanceSubmitBtn = document.getElementById("chance-submit-btn");
const chanceBetStatus = document.getElementById("chance-bet-status");

let hasBuzzed = false;
let currentScore = 0;
let chanceModeActive = false;
let lastSubmittedChanceBet = null;
// chanceBetStep: null | "points" | "answer" | "done"
let chanceBetStep = null;

// --- Buzzer sound (one fixed animal per player) ---
const BUZZ_SOUNDS = [
  "/sounds/chicken.mp3",
  "/sounds/cow-moo.mp3",
  "/sounds/horse-neigh.mp3",
  "/sounds/Lamb.mp3",
  "/sounds/Sheep.mp3",
];
let myBuzzSound = null;
let buzzAudio = null;
function playBuzzSound() {
  const src = myBuzzSound || BUZZ_SOUNDS[0];
  if (buzzAudio) { buzzAudio.pause(); buzzAudio.currentTime = 0; }
  buzzAudio = new Audio(src);
  buzzAudio.play().catch(() => {});
}

// --- Haptic feedback ---
function vibrate() {
  if (navigator.vibrate) {
    navigator.vibrate(100);
  }
}

// --- Session persistence ---
function getSessionToken() {
  return sessionStorage.getItem("buzzer-session-token");
}

function setSessionToken(token) {
  sessionStorage.setItem("buzzer-session-token", token);
}

function clearSessionToken() {
  sessionStorage.removeItem("buzzer-session-token");
}

// --- Join ---
joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) return;
  errorMsg.textContent = "";
  socket.emit("player-join", { name });
});

socket.on("join-ok", (data) => {
  joinScreen.classList.add("hidden");
  buzzerScreen.classList.remove("hidden");
  displayName.textContent = data.name;
  setScore(data.score || 0);
  chanceBetStep = null;
  setChanceMode(Boolean(data.chanceModeActive));
  lastSubmittedChanceBet = null;
  chanceAnswerInput.value = "";
  hasBuzzed = false;
  setBuzzerActive(true);
  if (data.theme) applyTheme(data.theme);
  if (data.sessionToken) setSessionToken(data.sessionToken);
  if (data.soundIndex != null) myBuzzSound = BUZZ_SOUNDS[data.soundIndex % BUZZ_SOUNDS.length];
});

// --- Rejoin after reload ---
socket.on("rejoin-ok", (data) => {
  joinScreen.classList.add("hidden");
  buzzerScreen.classList.remove("hidden");
  displayName.textContent = data.name;
  setScore(data.score || 0);
  chanceBetStep = null;
  setChanceMode(Boolean(data.chanceModeActive));
  if (data.soundIndex != null) myBuzzSound = BUZZ_SOUNDS[data.soundIndex % BUZZ_SOUNDS.length];
  if (data.chanceBet) {
    chanceBetInput.value = String(data.chanceBet.points || 1);
    lastSubmittedChanceBet = {
      points: Number(data.chanceBet.points || 0),
      answer: data.chanceBet.answer,
    };
    if (data.chanceBet.answer) {
      chanceAnswerInput.value = data.chanceBet.answer;
      setChanceBetStep("done");
      setChanceBetStatus(`Submitted: ${data.chanceBet.points} pts — answer received ✓`);
    } else {
      chanceAnswerInput.value = "";
      setChanceBetStep("answer");
      setChanceBetStatus(`${data.chanceBet.points} pts locked in — now type your answer`);
    }
  } else {
    lastSubmittedChanceBet = null;
    chanceAnswerInput.value = "";
    setChanceBetStatus("");
  }
  if (data.theme) applyTheme(data.theme);

  if (data.hasBuzzed) {
    hasBuzzed = true;
    setBuzzerActive(false);
    const medal = data.position === 1 ? "🥇" : data.position === 2 ? "🥈" : data.position === 3 ? "🥉" : "💩";
    const ordinal = data.position === 1 ? "1st" : data.position === 2 ? "2nd" : data.position === 3 ? "3rd" : `${data.position}th`;
    buzzStatus.textContent = `${medal} You were ${ordinal}!`;
    if (data.position === 1) buzzBtn.classList.add("winner");
  } else {
    hasBuzzed = false;
    setBuzzerActive(true);
    buzzStatus.textContent = "";
  }
});

socket.on("rejoin-failed", () => {
  // Session expired — clear token and show join screen
  clearSessionToken();
});

socket.on("theme-update", (theme) => {
  applyTheme(theme);
});

socket.on("score-update", (data) => {
  setScore(data?.score || 0);
});

socket.on("chance-mode-update", (data) => {
  setChanceMode(Boolean(data?.active));
});

socket.on("chance-bet-locked", (data) => {
  lastSubmittedChanceBet = { points: Number(data.points || 0), answer: null };
  chanceBetInput.value = String(data.points);
  setChanceBetStep("answer");
  setChanceBetStatus(`${data.points} pts locked in — now type your answer`);
});

socket.on("chance-bet-ok", (data) => {
  const confirmedAnswer = String(data.answer || "").trim();
  chanceAnswerInput.value = confirmedAnswer || chanceAnswerInput.value;
  lastSubmittedChanceBet = {
    points: Number(data.points || 0),
    answer: confirmedAnswer,
  };
  setChanceBetStep("done");
  setChanceBetStatus(`Submitted: ${data.points} pts — answer received ✓`);
});

socket.on("chance-bet-error", (msg) => {
  setChanceBetStatus(msg || "Invalid chance bet", true);
  if (chanceBetStep === "points") chanceLockBtn.disabled = false;
});

socket.on("chance-bet-resolved", (data) => {
  const result = data?.result === "win" ? "win" : "lose";
  const points = Number(data?.points || 0);
  lastSubmittedChanceBet = null;
  chanceBetInput.value = currentScore > 0 ? "1" : "";
  chanceAnswerInput.value = "";
  chanceBetStep = null;
  setChanceBetStep("points");
  setChanceBetStatus(
    result === "win"
      ? `Bet won: +${points} pts`
      : `Bet lost: -${points} pts`,
    false
  );
});

socket.on("join-error", (msg) => {
  errorMsg.textContent = msg;
});

// --- Buzz ---
buzzBtn.addEventListener("click", () => {
  if (hasBuzzed) return;
  socket.emit("buzz");
  playBuzzSound();
  vibrate();
});

// Prevent double-tap zoom on mobile
buzzBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  buzzBtn.click();
});

socket.on("buzz-ack", (data) => {
  hasBuzzed = true;
  setBuzzerActive(false);

  const medal = data.position === 1 ? "🥇" : data.position === 2 ? "🥈" : data.position === 3 ? "🥉" : "💩";
  buzzStatus.textContent = `${medal} You were ${data.position === 1 ? "1st" : data.position === 2 ? "2nd" : data.position === 3 ? "3rd" : `${data.position}th`}!`;

  if (data.position === 1) {
    buzzBtn.classList.add("winner");
  }
});

socket.on("round-state", (state) => {
  if (state.active) {
    hasBuzzed = false;
    setBuzzerActive(true);
    buzzStatus.textContent = "";
    buzzBtn.classList.remove("winner");
  } else {
    hasBuzzed = true;
    setBuzzerActive(false);
  }
});

// --- Round reset ---
socket.on("round-reset", () => {
  hasBuzzed = false;
  setBuzzerActive(true);
  buzzStatus.textContent = "";
  buzzBtn.classList.remove("winner");
  setChanceBetStatus("");
});

chanceBetForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!chanceModeActive || chanceBetStep !== "answer") return;
  const answer = chanceAnswerInput.value.trim();
  if (!answer) {
    setChanceBetStatus("Answer is required", true);
    return;
  }
  socket.emit("chance-bet", { answer });
});

chanceLockBtn.addEventListener("click", () => {
  if (!chanceModeActive || chanceBetStep !== "points") return;
  const points = Number(chanceBetInput.value);
  if (!Number.isInteger(points) || points < 1 || points > currentScore) {
    setChanceBetStatus(`Bet must be between 1 and ${currentScore}`, true);
    return;
  }
  chanceLockBtn.disabled = true;
  socket.emit("chance-bet-lock", { points });
});

// --- Helpers ---
function setBuzzerActive(active) {
  if (active) {
    buzzBtn.disabled = false;
    buzzBtn.classList.remove("buzzed");
    buzzBtn.textContent = "BUZZ!";
  } else {
    buzzBtn.disabled = true;
    buzzBtn.classList.add("buzzed");
    buzzBtn.textContent = "BUZZED";
  }
}

function setScore(score) {
  currentScore = Math.max(0, Number(score) || 0);
  playerScoreEl.textContent = `${currentScore} points`;

  chanceBetInput.max = String(Math.max(1, currentScore));
  if (!chanceBetInput.value && chanceBetStep === "points") {
    chanceBetInput.value = currentScore > 0 ? "1" : "";
  }

  if (chanceBetStep === "points" && Number(chanceBetInput.value) > currentScore) {
    chanceBetInput.value = currentScore > 0 ? String(currentScore) : "";
  }

  setChanceMode(chanceModeActive);
}

function setChanceMode(active) {
  chanceModeActive = active;
  chanceBetForm.classList.toggle("hidden", !active);
  buzzBtn.classList.toggle("hidden", active);

  if (!active) {
    lastSubmittedChanceBet = null;
    chanceBetStep = null;
    setChanceBetStatus("");
  } else if (chanceBetStep === null) {
    setChanceBetStep("points");
  } else {
    setChanceBetStep(chanceBetStep);
  }
}

function setChanceBetStep(step) {
  chanceBetStep = step;

  const isPoints = step === "points";
  const isAnswer = step === "answer";
  const showAnswer = step === "answer" || step === "done";

  chanceBetInput.disabled = !isPoints || currentScore < 1;
  chanceLockBtn.disabled = !isPoints || currentScore < 1;
  chanceLockBtn.classList.toggle("hidden", !isPoints);

  chanceAnswerLabel.classList.toggle("hidden", !showAnswer);
  chanceAnswerInput.classList.toggle("hidden", !showAnswer);
  chanceAnswerInput.disabled = !isAnswer;

  chanceSubmitBtn.classList.toggle("hidden", !showAnswer);
  chanceSubmitBtn.disabled = !isAnswer;

  if (isPoints && currentScore < 1) {
    setChanceBetStatus("You need at least 1 point to place a bet", true);
  }
}

function setChanceBetStatus(message, isError = false) {
  chanceBetStatus.textContent = message;
  chanceBetStatus.classList.toggle("error", Boolean(isError && message));
}



// --- Connection handling ---
socket.on("disconnect", () => {
  buzzStatus.textContent = "Disconnected \u2014 reconnecting...";
});

socket.on("connect", () => {
  // On connect (including after reload), try to rejoin with stored token
  const token = getSessionToken();
  if (token) {
    socket.emit("player-rejoin", { token });
  }
});
