const express = require("express");
const app = express();

app.use(express.json());

// Default bot status
let botStatus = {
    online: false,
    ping: 0,
    uptime: 0,
    lastHeartbeat: null,
    version: "1.0.0"
};

// Track downtime
let downtime = {
    lastOffline: null
};

// BOT → API (heartbeat)
app.post("/status", (req, res) => {
    botStatus = {
        online: true,
        ping: req.body.ping ?? 0,
        uptime: req.body.uptime ?? 0,
        lastHeartbeat: Date.now(),
        version: req.body.version || botStatus.version
    };

    res.json({ ok: true });
});

// WEBSITE → API (fetch status)
app.get("/status", (req, res) => {
    const now = Date.now();

    // If no heartbeat for 10 seconds → offline
    if (botStatus.lastHeartbeat && now - botStatus.lastHeartbeat > 10000) {
        if (botStatus.online === true) {
            downtime.lastOffline = now;
        }
        botStatus.online = false;
    }

    res.json(botStatus);
});

// WEBSITE → API (downtime info)
app.get("/downtime", (req, res) => {
    res.json(downtime);
});

// Root
app.get("/", (req, res) => {
    res.send("Orion Status API running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Status API running on port ${PORT}`));
