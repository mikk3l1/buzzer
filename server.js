const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const QRCode = require("qrcode");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Game state ---
const players = new Map(); // socketId -> { name, sessionToken, joinedAt }
const sessions = new Map(); // sessionToken -> { name, socketId, disconnectTimer }
const scores = new Map(); // sessionToken -> { name, score, createdAt }
const chanceBets = new Map(); // sessionToken -> { points, answer }
let buzzOrder = []; // [{ sessionToken, name, timestamp }]
let roundActive = true;
let currentTheme = "default";
let chanceModeActive = false;

const SESSION_GRACE_MS = 60_000; // 60 seconds to reconnect after disconnect

// --- Room code ---
function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code = "";
  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

const roomCode = generateRoomCode();

// --- Local IP detection ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

// --- Static files ---
app.use(express.static(path.join(__dirname, "public")));
app.use("/font", express.static(path.join(__dirname, "font")));

// --- Routes ---
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "player.html"));
});

app.get("/host", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "host.html"));
});

// --- Helpers ---
function getPlayerList() {
  // Include players with active sockets AND sessions in grace period
  const list = [];
  const seen = new Set();

  // Active players
  for (const [id, p] of players) {
    list.push({ id, name: p.name });
    seen.add(p.sessionToken);
  }

  // Players in grace period (disconnected but session still alive)
  for (const [token, session] of sessions) {
    if (session.disconnectTimer && !seen.has(token)) {
      list.push({ id: token, name: session.name, disconnected: true });
    }
  }

  return list;
}

function getBuzzResults() {
  return buzzOrder.map((b, i) => ({
    position: i + 1,
    name: b.name,
    timeMs: b.timestamp,
    sessionToken: b.sessionToken,
    score: scores.get(b.sessionToken)?.score ?? 0,
  }));
}

function ensureScoreEntry(sessionToken, name) {
  const existing = scores.get(sessionToken);
  if (existing) {
    existing.name = name;
    return existing;
  }

  const created = { name, score: 0, createdAt: Date.now() };
  scores.set(sessionToken, created);
  return created;
}

function getLeaderboard() {
  return [...scores.entries()]
    .map(([sessionToken, entry]) => ({
      sessionToken,
      name: entry.name,
      score: entry.score,
      connected: sessions.has(sessionToken) && !sessions.get(sessionToken)?.disconnectTimer,
      createdAt: entry.createdAt,
    }))
    .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt || a.name.localeCompare(b.name))
    .map(({ createdAt, ...rest }) => rest);
}

function emitLeaderboard() {
  io.to("host-room").emit("leaderboard-update", getLeaderboard());
}

function getPlayerScore(sessionToken) {
  return scores.get(sessionToken)?.score ?? 0;
}

function normalizeChanceBet(bet) {
  if (typeof bet === "number") {
    return { points: bet, answer: null };
  }

  return {
    points: Number(bet?.points) || 0,
    answer: bet?.answer != null ? String(bet.answer).trim() : null,
  };
}

function emitPlayerScore(sessionToken) {
  const session = sessions.get(sessionToken);
  if (!session || !session.socketId) return;

  io.to(session.socketId).emit("score-update", {
    score: getPlayerScore(sessionToken),
  });
}

function emitAllPlayerScores() {
  for (const token of sessions.keys()) {
    emitPlayerScore(token);
  }
}

function getChanceBetsForHost() {
  return [...chanceBets.entries()].map(([sessionToken, bet]) => ({
    ...normalizeChanceBet(bet),
    sessionToken,
    name: scores.get(sessionToken)?.name || sessions.get(sessionToken)?.name || "Unknown",
  }));
}

function emitChanceMode() {
  io.emit("chance-mode-update", { active: chanceModeActive });
  io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
}

function resolveAck(callback, payload) {
  if (typeof callback === "function") {
    callback(payload);
  }
}

function removeSession(sessionToken) {
  const session = sessions.get(sessionToken);
  if (session) {
    clearTimeout(session.disconnectTimer);
    sessions.delete(sessionToken);
  }
  chanceBets.delete(sessionToken);
  buzzOrder = buzzOrder.filter((b) => b.sessionToken !== sessionToken);
  io.to("host-room").emit("player-list", getPlayerList());
  io.to("host-room").emit("buzz-results", getBuzzResults());
  emitLeaderboard();
  io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
}

// --- Socket.IO ---
io.on("connection", async (socket) => {
  socket.data.isHost = false;

  // Host connects
  socket.on("host-join", async () => {
    socket.data.isHost = true;
    socket.join("host-room");

    const localIP = getLocalIP();
    const joinUrl = `http://${localIP}:${PORT}/`;

    let qrDataUrl;
    try {
      qrDataUrl = await QRCode.toDataURL(joinUrl, {
        width: 300,
        margin: 2,
        color: { dark: "#ffffff", light: "#00000000" },
      });
    } catch {
      qrDataUrl = null;
    }

    socket.emit("host-info", {
      roomCode,
      joinUrl,
      qrDataUrl,
      players: getPlayerList(),
      buzzResults: getBuzzResults(),
      leaderboard: getLeaderboard(),
      chanceModeActive,
      chanceBets: getChanceBetsForHost(),
      roundActive,
      theme: currentTheme,
    });
  });

  // Send current theme immediately on connect (so join page gets themed)
  socket.emit("theme-update", currentTheme);

  // Player rejoins with existing session token (after reload)
  socket.on("player-rejoin", (data) => {
    const token = String(data.token || "");
    const session = sessions.get(token);

    if (!session) {
      socket.emit("rejoin-failed");
      return;
    }

    // Cancel the grace-period disconnect timer
    clearTimeout(session.disconnectTimer);
    session.disconnectTimer = null;
    session.socketId = socket.id;

    // Re-link session to new socket
    players.set(socket.id, { name: session.name, sessionToken: token, joinedAt: Date.now() });
    ensureScoreEntry(token, session.name);

    // Tell player they're back in
    const alreadyBuzzed = buzzOrder.some((b) => b.sessionToken === token);
    socket.emit("rejoin-ok", {
      name: session.name,
      theme: currentTheme,
      score: getPlayerScore(token),
      chanceModeActive,
      chanceBet: chanceBets.has(token) ? normalizeChanceBet(chanceBets.get(token)) : null,
      hasBuzzed: alreadyBuzzed,
      position: alreadyBuzzed
        ? buzzOrder.findIndex((b) => b.sessionToken === token) + 1
        : null,
    });

    socket.emit("round-state", { active: roundActive && !alreadyBuzzed });
    io.to("host-room").emit("player-list", getPlayerList());
    emitLeaderboard();
    emitChanceMode();
  });

  // Player joins fresh
  socket.on("player-join", (data) => {
    const name = String(data.name || "").trim().slice(0, 30);
    if (!name) {
      socket.emit("join-error", "Name is required");
      return;
    }

    const sessionToken = crypto.randomBytes(16).toString("hex");

    players.set(socket.id, { name, sessionToken, joinedAt: Date.now() });
    sessions.set(sessionToken, { name, socketId: socket.id, disconnectTimer: null });
    ensureScoreEntry(sessionToken, name);

    socket.emit("join-ok", {
      name,
      theme: currentTheme,
      sessionToken,
      score: getPlayerScore(sessionToken),
      chanceModeActive,
    });

    io.to("host-room").emit("player-list", getPlayerList());
    emitLeaderboard();
    emitChanceMode();

    const alreadyBuzzed = buzzOrder.some((b) => b.sessionToken === sessionToken);
    socket.emit("round-state", { active: roundActive && !alreadyBuzzed });
  });

  // Player buzzes
  socket.on("buzz", () => {
    if (!roundActive) return;
    if (!players.has(socket.id)) return;

    const player = players.get(socket.id);
    if (buzzOrder.some((b) => b.sessionToken === player.sessionToken)) return;

    const entry = {
      sessionToken: player.sessionToken,
      name: player.name,
      timestamp: Date.now(),
    };
    buzzOrder.push(entry);

    const position = buzzOrder.length;

    socket.emit("buzz-ack", { position });
    socket.emit("round-state", { active: false });

    const results = getBuzzResults();
    io.to("host-room").emit("buzz-results", results);

    if (position === 1) {
      io.to("host-room").emit("first-buzz", { name: entry.name });
    }
  });

  // Host applies score to a buzzed player
  socket.on("apply-score", (data) => {
    if (!socket.data.isHost) return;

    const sessionToken = String(data?.sessionToken || "");
    const points = Number(data?.points);
    const mode = String(data?.mode || "");

    if (!sessionToken) return;
    if (![100, 200, 300, 400, 500].includes(points)) return;
    if (mode !== "give" && mode !== "take") return;

    const buzzedPlayer = buzzOrder.find((b) => b.sessionToken === sessionToken);
    if (!buzzedPlayer) return;

    const scoreEntry = ensureScoreEntry(sessionToken, buzzedPlayer.name);
    if (mode === "give") {
      scoreEntry.score += points;
    } else {
      scoreEntry.score = Math.max(0, scoreEntry.score - points);
    }

    const existingBet = chanceBets.has(sessionToken)
      ? normalizeChanceBet(chanceBets.get(sessionToken))
      : null;
    if (existingBet && existingBet.points > scoreEntry.score) {
      if (scoreEntry.score < 1) {
        chanceBets.delete(sessionToken);
      } else {
        chanceBets.set(sessionToken, {
          ...existingBet,
          points: scoreEntry.score,
        });
      }
    }

    io.to("host-room").emit("buzz-results", getBuzzResults());
    emitLeaderboard();
    emitPlayerScore(sessionToken);
    io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
  });

  // Host toggles chance mode for all players
  socket.on("set-chance-mode", (data) => {
    if (!socket.data.isHost) return;

    const active = Boolean(data?.active);
    chanceModeActive = active;
    if (!chanceModeActive) {
      chanceBets.clear();
    }

    emitChanceMode();
  });

  // Player locks in their points (step 1 of 2)
  socket.on("chance-bet-lock", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    if (!chanceModeActive) {
      socket.emit("chance-bet-error", "Chance betting is not active");
      return;
    }

    const points = Number(data?.points);
    const score = getPlayerScore(player.sessionToken);

    if (!Number.isInteger(points) || points < 1 || points > score) {
      socket.emit("chance-bet-error", `Bet must be between 1 and ${score}`);
      return;
    }

    chanceBets.set(player.sessionToken, { points, answer: null });
    socket.emit("chance-bet-locked", { points });
    io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
  });

  // Player submits their answer (step 2 of 2)
  socket.on("chance-bet", (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    if (!chanceModeActive) {
      socket.emit("chance-bet-error", "Chance betting is not active");
      return;
    }

    const existing = chanceBets.get(player.sessionToken);
    if (!existing) {
      socket.emit("chance-bet-error", "Lock in your points first");
      return;
    }

    const bet = normalizeChanceBet(existing);
    if (bet.answer !== null) {
      socket.emit("chance-bet-error", "Answer already submitted");
      return;
    }

    const answer = String(data?.answer || "").trim().slice(0, 500);
    if (!answer) {
      socket.emit("chance-bet-error", "Answer is required");
      return;
    }

    chanceBets.set(player.sessionToken, { points: bet.points, answer });
    socket.emit("chance-bet-ok", { points: bet.points, answer });
    io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
  });

  // Host resolves a submitted chance bet in one click
  socket.on("apply-chance-result", (data, callback) => {
    if (!socket.data.isHost) {
      resolveAck(callback, { ok: false, error: "Only host can resolve chance bets" });
      return;
    }

    const sessionToken = String(data?.sessionToken || "");
    const result = String(data?.result || "");
    if (!sessionToken) {
      resolveAck(callback, { ok: false, error: "Missing player token" });
      return;
    }
    if (result !== "win" && result !== "lose") {
      resolveAck(callback, { ok: false, error: "Invalid chance result" });
      return;
    }

    const storedBet = chanceBets.get(sessionToken);
    const bet = storedBet ? normalizeChanceBet(storedBet) : null;
    if (!bet || bet.points < 1) {
      resolveAck(callback, { ok: false, error: "No active chance bet found for that player" });
      return;
    }
    if (bet.answer === null) {
      resolveAck(callback, { ok: false, error: "Player hasn't submitted their answer yet" });
      return;
    }

    const playerName = scores.get(sessionToken)?.name || sessions.get(sessionToken)?.name || "Unknown";
    const scoreEntry = ensureScoreEntry(sessionToken, playerName);

    if (result === "win") {
      scoreEntry.score += bet.points;
    } else {
      scoreEntry.score = Math.max(0, scoreEntry.score - bet.points);
    }

    chanceBets.delete(sessionToken);
    emitLeaderboard();
    emitPlayerScore(sessionToken);
    const session = sessions.get(sessionToken);
    if (session?.socketId) {
      io.to(session.socketId).emit("chance-bet-resolved", { result, points: bet.points });
    }
    const buzzResults = getBuzzResults();
    const chanceBetsForHost = getChanceBetsForHost();
    const leaderboard = getLeaderboard();
    io.to("host-room").emit("buzz-results", buzzResults);
    io.to("host-room").emit("chance-bets-update", chanceBetsForHost);
    resolveAck(callback, {
      ok: true,
      result,
      sessionToken,
      points: bet.points,
      buzzResults,
      chanceBets: chanceBetsForHost,
      leaderboard,
    });
  });

  // Host resets round
  socket.on("reset-round", () => {
    buzzOrder = [];
    roundActive = true;
    chanceModeActive = false;
    chanceBets.clear();
    io.emit("round-reset");
    io.to("host-room").emit("buzz-results", getBuzzResults());
    emitChanceMode();
  });

  // Host resets persistent scores/leaderboard
  socket.on("reset-scores", () => {
    if (!socket.data.isHost) return;

    scores.clear();
    for (const [token, session] of sessions) {
      ensureScoreEntry(token, session.name);
    }

    io.to("host-room").emit("buzz-results", getBuzzResults());
    emitLeaderboard();
    emitAllPlayerScores();
    chanceBets.clear();
    io.to("host-room").emit("chance-bets-update", getChanceBetsForHost());
  });

  // Host changes theme
  socket.on("theme-change", (theme) => {
    const allowed = ["default", "easter", "neon", "ocean"];
    if (!allowed.includes(theme)) return;
    currentTheme = theme;
    io.emit("theme-update", currentTheme);
  });

  // Disconnect — start grace period instead of immediate removal
  socket.on("disconnect", () => {
    const player = players.get(socket.id);
    if (!player) return;

    players.delete(socket.id);

    const session = sessions.get(player.sessionToken);
    if (session) {
      session.disconnectTimer = setTimeout(() => {
        removeSession(player.sessionToken);
      }, SESSION_GRACE_MS);
    }

    io.to("host-room").emit("player-list", getPlayerList());
    emitLeaderboard();
  });
});

// --- Start ---
server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log("");
  console.log("  🎯  Buzzer app is running!");
  console.log("");
  console.log(`  Host dashboard:  http://localhost:${PORT}/host`);
  console.log(`  Players join:    http://${localIP}:${PORT}/`);
  console.log(`  Room code:       ${roomCode}`);
  console.log("");
});
