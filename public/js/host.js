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
const qrImg = document.getElementById("qr-code");
const joinUrlEl = document.getElementById("join-url");
const roomCodeEl = document.getElementById("room-code");
const btnReset = document.getElementById("btn-reset");
const autoResetToggle = document.getElementById("auto-reset-toggle");
const autoResetDelay = document.getElementById("auto-reset-delay");
const buzzResultsEl = document.getElementById("buzz-results");
const waitingMessage = document.getElementById("waiting-message");
const playerListEl = document.getElementById("player-list");
const playerCountEl = document.getElementById("player-count");
const themeSelect = document.getElementById("theme-select");

// --- Buzzer sound (generated via Web Audio API) ---
let audioCtx;
function playBuzzSound() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioCtx;

  // Fun two-tone game-show buzzer
  const now = ctx.currentTime;

  // Tone 1
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = "square";
  osc1.frequency.setValueAtTime(800, now);
  gain1.gain.setValueAtTime(0.3, now);
  gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
  osc1.connect(gain1).connect(ctx.destination);
  osc1.start(now);
  osc1.stop(now + 0.15);

  // Tone 2
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = "square";
  osc2.frequency.setValueAtTime(600, now + 0.15);
  gain2.gain.setValueAtTime(0.3, now + 0.15);
  gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
  osc2.connect(gain2).connect(ctx.destination);
  osc2.start(now + 0.15);
  osc2.stop(now + 0.5);
}

// --- Join as host ---
socket.emit("host-join");

socket.on("host-info", (info) => {
  roomCodeEl.textContent = info.roomCode;
  joinUrlEl.textContent = info.joinUrl;
  if (info.qrDataUrl) {
    qrImg.src = info.qrDataUrl;
    qrImg.style.display = "block";
  }
  if (info.autoReset) {
    autoResetToggle.checked = info.autoReset.enabled;
    autoResetDelay.value = Math.round(info.autoReset.delayMs / 1000);
    autoResetDelay.disabled = !info.autoReset.enabled;
  }
  if (info.theme) {
    themeSelect.value = info.theme;
    applyTheme(info.theme);
  }
  renderPlayers(info.players);
  renderBuzzResults(info.buzzResults);
});

// --- Player list ---
socket.on("player-list", (list) => renderPlayers(list));

function renderPlayers(list) {
  playerCountEl.textContent = list.length;
  if (list.length === 0) {
    playerListEl.innerHTML = '<p class="no-players">No players connected yet</p>';
    return;
  }
  playerListEl.innerHTML = list
    .map((p) => `<div class="player-chip">${escapeHtml(p.name)}</div>`)
    .join("");
}

// --- Buzz results ---
socket.on("buzz-results", (results) => renderBuzzResults(results));

socket.on("first-buzz", () => {
  playBuzzSound();
});

function renderBuzzResults(results) {
  if (results.length === 0) {
    waitingMessage.style.display = "block";
    // Remove result cards but keep waiting message
    buzzResultsEl.querySelectorAll(".buzz-card").forEach((el) => el.remove());
    return;
  }
  waitingMessage.style.display = "none";

  // Rebuild results
  const existing = buzzResultsEl.querySelectorAll(".buzz-card");
  existing.forEach((el) => el.remove());

  results.forEach((r) => {
    const card = document.createElement("div");
    card.className = "buzz-card" + (r.position === 1 ? " winner" : "");

    const medal = r.position === 1 ? "🥇" : r.position === 2 ? "🥈" : r.position === 3 ? "🥉" : `#${r.position}`;

    card.innerHTML = `
      <span class="buzz-position">${medal}</span>
      <span class="buzz-name">${escapeHtml(r.name)}</span>
    `;
    buzzResultsEl.appendChild(card);
  });
}

// --- Reset ---
btnReset.addEventListener("click", () => {
  socket.emit("reset-round");
});

socket.on("round-reset", () => {
  // Visual feedback handled by buzz-results update
});

// --- Auto-reset ---
autoResetToggle.addEventListener("change", () => {
  autoResetDelay.disabled = !autoResetToggle.checked;
  sendAutoResetConfig();
});

autoResetDelay.addEventListener("change", () => {
  sendAutoResetConfig();
});

function sendAutoResetConfig() {
  socket.emit("auto-reset-config", {
    enabled: autoResetToggle.checked,
    delayMs: Number(autoResetDelay.value) * 1000,
  });
}

socket.on("auto-reset-update", (config) => {
  autoResetToggle.checked = config.enabled;
  autoResetDelay.value = Math.round(config.delayMs / 1000);
  autoResetDelay.disabled = !config.enabled;
});

// --- Theme selection ---
themeSelect.addEventListener("change", () => {
  socket.emit("theme-change", themeSelect.value);
});

socket.on("theme-update", (theme) => {
  themeSelect.value = theme;
  applyTheme(theme);
});

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
