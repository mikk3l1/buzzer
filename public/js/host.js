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
const buzzResultsEl = document.getElementById("buzz-results");
const waitingMessage = document.getElementById("waiting-message");
const playerListEl = document.getElementById("player-list");
const playerCountEl = document.getElementById("player-count");
const themeSelect = document.getElementById("theme-select");
const btnResetScores = document.getElementById("btn-reset-scores");
const leaderboardListEl = document.getElementById("leaderboard-list");
const btnChanceToggle = document.getElementById("btn-chance-toggle");
const chanceStateEl = document.getElementById("chance-state");
const chanceBetsListEl = document.getElementById("chance-bets-list");

const scoreSelection = new Map();
let latestBuzzResults = [];
let chanceModeActive = false;
let latestChanceBets = [];

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
socket.on("connect", () => {
  socket.emit("host-join");
});

socket.on("host-info", (info) => {
  roomCodeEl.textContent = info.roomCode;
  joinUrlEl.textContent = info.joinUrl;
  if (info.qrDataUrl) {
    qrImg.src = info.qrDataUrl;
    qrImg.style.display = "block";
  }
  if (info.theme) {
    themeSelect.value = info.theme;
    applyTheme(info.theme);
  }
  renderPlayers(info.players);
  renderBuzzResults(info.buzzResults);
  renderLeaderboard(info.leaderboard || []);
  setChanceMode(Boolean(info.chanceModeActive));
  renderChanceBets(info.chanceBets || []);
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
socket.on("leaderboard-update", (leaderboard) => renderLeaderboard(leaderboard));
socket.on("chance-mode-update", (data) => {
  setChanceMode(Boolean(data?.active));
});
socket.on("chance-bets-update", (bets) => {
  renderChanceBets(bets || []);
});

socket.on("first-buzz", () => {
  playBuzzSound();
});

function renderBuzzResults(results) {
  latestBuzzResults = results;

  if (results.length === 0) {
    waitingMessage.style.display = "block";
    // Remove result cards but keep waiting message
    buzzResultsEl.querySelectorAll(".buzz-card").forEach((el) => el.remove());
    scoreSelection.clear();
    return;
  }
  waitingMessage.style.display = "none";

  // Rebuild results
  const existing = buzzResultsEl.querySelectorAll(".buzz-card");
  existing.forEach((el) => el.remove());

  results.forEach((r) => {
    const selectedPoints = scoreSelection.get(r.sessionToken) || 100;
    const card = document.createElement("div");
    card.className = "buzz-card" + (r.position === 1 ? " winner" : "");

    const medal = r.position === 1 ? "🥇" : r.position === 2 ? "🥈" : r.position === 3 ? "🥉" : `#${r.position}`;

    card.innerHTML = `
      <div class="buzz-main">
        <span class="buzz-position">${medal}</span>
        <span class="buzz-name">${escapeHtml(r.name)}</span>
        <span class="buzz-score">${Number(r.score || 0)} pts</span>
      </div>
      <div class="score-controls" data-token="${r.sessionToken}">
        <div class="score-point-buttons">
          ${[100, 200, 300, 400, 500]
            .map(
              (points) =>
                `<button class="score-point-btn${selectedPoints === points ? " active" : ""}" data-action="select-points" data-token="${r.sessionToken}" data-points="${points}">${points}</button>`
            )
            .join("")}
        </div>
        <div class="score-actions">
          <button class="score-action-btn give" data-action="score-player" data-token="${r.sessionToken}" data-mode="give">Give</button>
          <button class="score-action-btn take" data-action="score-player" data-token="${r.sessionToken}" data-mode="take">Take</button>
        </div>
      </div>
    `;
    buzzResultsEl.appendChild(card);
  });
}

buzzResultsEl.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  const sessionToken = button.dataset.token;
  if (!sessionToken) return;

  if (action === "select-points") {
    const points = Number(button.dataset.points);
    if (![100, 200, 300, 400, 500].includes(points)) return;
    scoreSelection.set(sessionToken, points);
    renderBuzzResults(latestBuzzResults);
    return;
  }

  if (action === "score-player") {
    const mode = button.dataset.mode;
    if (mode !== "give" && mode !== "take") return;

    const points = scoreSelection.get(sessionToken) || 100;
    socket.emit("apply-score", { sessionToken, points, mode });
  }
});

function renderLeaderboard(leaderboard) {
  if (!leaderboard || leaderboard.length === 0) {
    leaderboardListEl.innerHTML = '<p class="no-players">No scores yet</p>';
    return;
  }

  leaderboardListEl.innerHTML = leaderboard
    .map(
      (entry, index) => `
        <div class="leaderboard-row${entry.connected ? "" : " disconnected"}">
          <span class="leaderboard-rank">#${index + 1}</span>
          <span class="leaderboard-name">${escapeHtml(entry.name)}</span>
          <span class="leaderboard-points">${Number(entry.score || 0)} pts</span>
        </div>
      `
    )
    .join("");
}

// --- Reset ---
btnReset.addEventListener("click", () => {
  socket.emit("reset-round");
});

socket.on("round-reset", () => {
  // Visual feedback handled by buzz-results update
  scoreSelection.clear();
  latestBuzzResults = [];
});

btnResetScores.addEventListener("click", () => {
  socket.emit("reset-scores");
});

btnChanceToggle.addEventListener("click", () => {
  socket.emit("set-chance-mode", { active: !chanceModeActive });
});

// --- Theme selection ---
themeSelect.addEventListener("change", () => {
  socket.emit("theme-change", themeSelect.value);
});

socket.on("theme-update", (theme) => {
  themeSelect.value = theme;
  applyTheme(theme);
});

function setChanceMode(active) {
  chanceModeActive = active;
  chanceStateEl.textContent = `Chance: ${active ? "On" : "Off"}`;
  btnChanceToggle.textContent = active ? "Disable Chance" : "Enable Chance";
  btnChanceToggle.classList.toggle("active", active);
}

function renderChanceBets(bets) {
  latestChanceBets = bets;

  if (!bets || bets.length === 0) {
    chanceBetsListEl.innerHTML = '<p class="no-players">No bets yet</p>';
    return;
  }

  chanceBetsListEl.innerHTML = bets
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .map(
      (bet) => `
        <div class="chance-bet-row">
          <div class="chance-bet-info">
            <span class="chance-bet-name">${escapeHtml(bet.name)}</span>
            <span class="chance-bet-answer">${escapeHtml(bet.answer || "")}</span>
          </div>
          <span class="chance-bet-points">${Number(bet.points || 0)} pts</span>
          <div class="chance-bet-actions">
            <button class="chance-bet-action win" data-action="chance-result" data-token="${bet.sessionToken}" data-result="win">Win Bet</button>
            <button class="chance-bet-action lose" data-action="chance-result" data-token="${bet.sessionToken}" data-result="lose">Lose Bet</button>
          </div>
        </div>
      `
    )
    .join("");
}

chanceBetsListEl.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const button = target.closest("button[data-action='chance-result']");
  if (!button) return;

  const sessionToken = button.dataset.token;
  const result = button.dataset.result;
  if (!sessionToken) return;
  if (result !== "win" && result !== "lose") return;

  const row = button.closest(".chance-bet-row");
  const playerName = row?.querySelector(".chance-bet-name")?.textContent || "player";
  const pointsText = row?.querySelector(".chance-bet-points")?.textContent || "this bet";
  const actionText = result === "win" ? "Win Bet" : "Lose Bet";

  const confirmed = window.confirm(`Apply \"${actionText}\" for ${playerName} (${pointsText})?`);
  if (!confirmed) return;

  socket.emit("apply-chance-result", { sessionToken, result }, (response) => {
    if (!response?.ok) {
      window.alert(response?.error || "Unable to resolve chance bet");
      return;
    }

    if (Array.isArray(response.chanceBets)) {
      renderChanceBets(response.chanceBets);
    } else {
      renderChanceBets(latestChanceBets.filter((bet) => bet.sessionToken !== sessionToken));
    }

    if (Array.isArray(response.leaderboard)) {
      renderLeaderboard(response.leaderboard);
    }

    if (Array.isArray(response.buzzResults)) {
      renderBuzzResults(response.buzzResults);
    }
  });
});

// --- Utility ---
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
