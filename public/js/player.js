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

let hasBuzzed = false;

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
  hasBuzzed = false;
  setBuzzerActive(true);
  if (data.theme) applyTheme(data.theme);
});

socket.on("theme-update", (theme) => {
  applyTheme(theme);
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
    buzzStatus.textContent = "🥇 You were 1st!";
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

// --- Reconnection awareness ---
socket.on("disconnect", () => {
  buzzStatus.textContent = "Disconnected — reconnecting...";
});

socket.on("connect", () => {
  // If we had a name, re-join automatically
  const name = displayName.textContent;
  if (name && !joinScreen.classList.contains("hidden")) {
    // We're on the buzzer screen, re-join
    socket.emit("player-join", { name });
  }
});
