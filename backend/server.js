// ============================================================
//  server.js  –  Sentinel AI Backend Entry Point
//  Express + Socket.IO + Agent Pipeline
// ============================================================

require("dotenv").config();

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

const apiRoutes  = require("./routes/api");
const chatRoutes = require("./routes/chat");
const { startStatsTicker, startLogTicker, startSmsTicker } = require("./agents/pipeline");

// ── App setup ─────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// ── Middleware ─────────────────────────────────────────────────
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Serve the frontend HTML directly from /public (or / if a frontend
// file is placed alongside server.js)
app.use(express.static(path.join(__dirname, "public")));

// ── Socket.IO setup ────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
  // Allow transport fallback
  transports: ["websocket", "polling"],
});

// Make io accessible inside route handlers via req.app.get("io")
app.set("io", io);

// ── WebSocket connection handler ───────────────────────────────
io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Send current state snapshot immediately on connect
  const { getState } = require("./data/state");
  const state = getState();

  socket.emit("init_state", {
    incident:    state.incident,
    stats:       state.stats,
    volunteers:  state.volunteers,
    resources:   state.resources,
    deployments: state.deployments,
    logs:        state.logs.slice(0, 20),
    smslogs:     state.smslogs.slice(0, 10),
  });

  socket.on("disconnect", (reason) => {
    console.log(`[WS] Client disconnected: ${socket.id} — ${reason}`);
  });

  // Allow client to manually trigger demo from socket
  socket.on("trigger_demo", () => {
    const { runPipeline } = require("./agents/pipeline");
    runPipeline(io).catch((e) => console.error("[Pipeline socket trigger]", e.message));
  });
});

// ── REST Routes ────────────────────────────────────────────────
app.use("/", apiRoutes);    // GET /state, POST /start-demo, POST /reset, GET /health
app.use("/chat", chatRoutes); // POST /chat

// ── Background tickers ────────────────────────────────────────
// These keep the UI alive with live data even without a pipeline run
startStatsTicker(io);
startLogTicker(io);
startSmsTicker(io);

// ============================================================
//  DISASTER DETECTION LAYER
//  Isolated addition — does NOT touch any code above this line.
//  All existing routes, sockets, tickers, and state are untouched.
// ============================================================

// ── USGS feed URL ─────────────────────────────────────────────
const USGS_URL =
  "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson";

// ── Resolve fetch (Node 18+ has it built-in, older needs node-fetch) ──
const _fetch = (() => {
  if (typeof globalThis.fetch === "function") return globalThis.fetch.bind(globalThis);
  try { return require("node-fetch"); } catch (_) { return null; }
})();

/**
 * GET /api/earthquakes
 * Proxies the USGS hourly GeoJSON feed and returns a clean array:
 *   [{ id, type, magnitude, place, lat, lng, time }, ...]
 *
 * The frontend calls this to avoid CORS issues hitting USGS directly.
 */
app.get("/api/earthquakes", async (req, res) => {
  if (!_fetch) {
    return res.status(500).json({
      error: "fetch not available — run Node 18+ or install node-fetch",
    });
  }

  try {
    const upstream = await _fetch(USGS_URL, {
      signal: AbortSignal.timeout(8000),
    });

    if (!upstream.ok) {
      throw new Error(`USGS responded with HTTP ${upstream.status}`);
    }

    const geojson = await upstream.json();

    const events = (geojson.features ?? []).map((feature) => {
      const p   = feature.properties;
      const [lng, lat] = feature.geometry?.coordinates ?? [0, 0];

      return {
        id:        feature.id,
        type:      "earthquake",
        magnitude: p.mag   ?? 0,
        place:     p.place ?? "Unknown location",
        lat:       parseFloat(lat.toFixed(4)),
        lng:       parseFloat(lng.toFixed(4)),
        time:      p.time  ?? Date.now(),
      };
    });

    // Sort newest-first (USGS already does this, but be explicit)
    events.sort((a, b) => b.time - a.time);

    // If a meaningful event (M>4.5) exists, broadcast it to all connected sockets
    // so clients running in AUTO mode get it without needing to poll themselves.
    const notable = events.find(e => e.magnitude > 4.5);
    if (notable) {
      io.emit("live_earthquake", notable);
      console.log(`[Earthquake] Broadcast live_earthquake: M${notable.magnitude} — ${notable.place}`);
    }

    console.log(`[Earthquake] Returned ${events.length} events from USGS`);
    return res.json(events);

  } catch (err) {
    console.error("[Earthquake] Fetch error:", err.message);
    return res.status(502).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       SENTINEL AI BACKEND — ONLINE           ║
╠══════════════════════════════════════════════╣
║  HTTP  → http://localhost:${PORT}              ║
║  WS    → ws://localhost:${PORT}                ║
║  API   → POST /start-demo                    ║
║          POST /chat                          ║
║          GET  /state                         ║
║          GET  /health                        ║
║          GET  /api/earthquakes  <- NEW        ║
║  Mode  → ${process.env.ANTHROPIC_API_KEY ? "Claude API (LIVE)" : "Mock AI (no API key)       "}       ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = { app, server, io };
