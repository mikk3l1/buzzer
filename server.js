const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const QRCode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// --- Game state ---
const players = new Map(); // socketId -> { name, joinedAt }
let buzzOrder = []; // [{ socketId, name, timestamp }]
let roundActive = true;
let currentTheme = "default";

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
  return Array.from(players.entries()).map(([id, p]) => ({
    id,
    name: p.name,
  }));
}

function getBuzzResults() {
  return buzzOrder.map((b, i) => ({
    position: i + 1,
    name: b.name,
    timeMs: b.timestamp,
  }));
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

  // Player joins
  socket.on("player-join", (data) => {
    const name = String(data.name || "").trim().slice(0, 30);
    if (!name) {
      socket.emit("join-error", "Name is required");
      return;
    }

    players.set(socket.id, { name, joinedAt: Date.now() });
    socket.emit("join-ok", { name, theme: currentTheme });

    io.to("host-room").emit("player-list", getPlayerList());

    // Tell player current round state
    const alreadyBuzzed = buzzOrder.some((b) => b.socketId === socket.id);
    socket.emit("round-state", { active: roundActive && !alreadyBuzzed });
  });

  // Player buzzes
  socket.on("buzz", () => {
    if (!roundActive) return;
    if (!players.has(socket.id)) return;
    if (buzzOrder.some((b) => b.socketId === socket.id)) return;

    const entry = {
      socketId: socket.id,
      name: players.get(socket.id).name,
      timestamp: Date.now(),
    };
    buzzOrder.push(entry);

    const position = buzzOrder.length;

    // Tell buzzing player their position
    socket.emit("buzz-ack", { position });

    // Tell all players to lock if this is the first buzz (optional: lock all on first buzz)
    // Actually, let everyone keep buzzing to record full order
    socket.emit("round-state", { active: false });

    // Send updated results to host
    const results = getBuzzResults();
    io.to("host-room").emit("buzz-results", results);

    // If first buzz, notify host for sound
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

  // Disconnect
  socket.on("disconnect", () => {
    if (players.has(socket.id)) {
      players.delete(socket.id);
      // Remove from buzz order too
      buzzOrder = buzzOrder.filter((b) => b.socketId !== socket.id);
      io.to("host-room").emit("player-list", getPlayerList());
      io.to("host-room").emit("buzz-results", getBuzzResults());
    }
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
