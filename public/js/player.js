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
const chanceBetStatus = document.getElementById("chance-bet-status");

let hasBuzzed = false;
let currentScore = 0;
let chanceModeActive = false;

// --- Buzzer sound (Web Audio API) ---
let audioCtx;
function playBuzzSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioCtx;
  const now = ctx.currentTime;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(500, now);
  osc.frequency.exponentialRampToValueAtTime(300, now + 0.2);
  gain.gain.setValueAtTime(0.4, now);
  gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + 0.3);
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
  setChanceMode(Boolean(data.chanceModeActive));
  hasBuzzed = false;
  setBuzzerActive(true);
  if (data.theme) applyTheme(data.theme);
  if (data.sessionToken) setSessionToken(data.sessionToken);
});

// --- Rejoin after reload ---
socket.on("rejoin-ok", (data) => {
  joinScreen.classList.add("hidden");
  buzzerScreen.classList.remove("hidden");
  displayName.textContent = data.name;
  setScore(data.score || 0);
  setChanceMode(Boolean(data.chanceModeActive));
  setChanceBetStatus(data.chanceBet ? `Submitted: ${data.chanceBet} pts` : "");
  if (data.theme) applyTheme(data.theme);

  if (data.hasBuzzed) {
    hasBuzzed = true;
    setBuzzerActive(false);
    if (data.position === 1) {
      buzzBtn.classList.add("winner");
      buzzStatus.textContent = "\u{1F947} You were 1st!";
    } else {
      const suffix =
        data.position === 2 ? "nd" : data.position === 3 ? "rd" : "th";
      buzzStatus.textContent = `You were ${data.position}${suffix}!`;
    }
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

socket.on("chance-bet-ok", (data) => {
  setChanceBetStatus(`Submitted: ${data.points} pts`);
});

socket.on("chance-bet-error", (msg) => {
  setChanceBetStatus(msg || "Invalid chance bet", true);
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

  const suffix =
    data.position === 1 ? "st" : data.position === 2 ? "nd" : data.position === 3 ? "rd" : "th";
  buzzStatus.textContent = `You were ${data.position}${suffix}!`;

  if (data.position === 1) {
    buzzBtn.classList.add("winner");
    buzzStatus.textContent = "\u{1F947} You were 1st!";
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
  if (!chanceModeActive) return;

  const points = Number(chanceBetInput.value);
  if (!Number.isInteger(points)) {
    setChanceBetStatus("Bet must be a whole number", true);
    return;
  }
  if (points < 1 || points > currentScore) {
    setChanceBetStatus(`Bet must be between 1 and ${currentScore}`, true);
    return;
  }

  socket.emit("chance-bet", { points });
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
  playerScoreEl.textContent = `Score: ${currentScore} pts`;

  chanceBetInput.max = String(Math.max(1, currentScore));
  if (!chanceBetInput.value) {
    chanceBetInput.value = currentScore > 0 ? "1" : "";
  }

  if (Number(chanceBetInput.value) > currentScore) {
    chanceBetInput.value = currentScore > 0 ? String(currentScore) : "";
  }

  setChanceMode(chanceModeActive);
}

function setChanceMode(active) {
  chanceModeActive = active;
  chanceBetForm.classList.toggle("hidden", !active);
  chanceBetInput.disabled = !active || currentScore < 1;

  const submitButton = chanceBetForm.querySelector("button[type='submit']");
  if (submitButton) {
    submitButton.disabled = !active || currentScore < 1;
  }

  if (active && currentScore < 1) {
    setChanceBetStatus("You need at least 1 point to place a bet", true);
  } else if (!active) {
    setChanceBetStatus("");
  } else {
    setChanceBetStatus("");
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
