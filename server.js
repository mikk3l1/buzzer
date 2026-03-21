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
let buzzOrder = []; // [{ sessionToken, name, timestamp }]
let roundActive = true;
let currentTheme = "default";

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
  }));
}

function removeSession(sessionToken) {
  const session = sessions.get(sessionToken);
  if (session) {
    clearTimeout(session.disconnectTimer);
    sessions.delete(sessionToken);
  }
  buzzOrder = buzzOrder.filter((b) => b.sessionToken !== sessionToken);
  io.to("host-room").emit("player-list", getPlayerList());
  io.to("host-room").emit("buzz-results", getBuzzResults());
}

// --- Socket.IO ---
io.on("connection", async (socket) => {
  // Host connects
  socket.on("host-join", async () => {
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

    // Tell player they're back in
    const alreadyBuzzed = buzzOrder.some((b) => b.sessionToken === token);
    socket.emit("rejoin-ok", {
      name: session.name,
      theme: currentTheme,
      hasBuzzed: alreadyBuzzed,
      position: alreadyBuzzed
        ? buzzOrder.findIndex((b) => b.sessionToken === token) + 1
        : null,
    });

    socket.emit("round-state", { active: roundActive && !alreadyBuzzed });
    io.to("host-room").emit("player-list", getPlayerList());
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

    socket.emit("join-ok", { name, theme: currentTheme, sessionToken });

    io.to("host-room").emit("player-list", getPlayerList());

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

  // Host resets round
  socket.on("reset-round", () => {
    buzzOrder = [];
    roundActive = true;
    io.emit("round-reset");
    io.to("host-room").emit("buzz-results", getBuzzResults());
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
