
import "dotenv/config";
import express from "express";

import {
  startWhatsApp,
  getWhatsAppStatus,
  getCurrentQR,
  requestPairing,
  sendWhatsAppOTP,
  sendWhatsAppNotification
} from "./bot.js";

const app = express();

// ==========================================
// CONFIGURATION
// ==========================================

const PORT = process.env.PORT || 3000;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BOT_API_SECRET = process.env.BOT_API_SECRET;

const MAX_PDF_SIZE = 7 * 1024 * 1024;

const SERVER_STARTED_AT = new Date().toISOString();

app.disable("x-powered-by");

app.use(express.json({
  limit: "12mb"
}));

// ==========================================
// CACHE CONTROL
// ==========================================

function noCache(req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");

  next();
}

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function adminAuth(req, res, next) {
  const token = req.headers.authorization?.replace(
    /^Bearer\s+/i,
    ""
  );

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized. Invalid admin token."
    });
  }

  next();
}

// ==========================================
// INTERNAL BOT SERVICE AUTHENTICATION
// ==========================================

function botServiceAuth(req, res, next) {
  const secret = req.headers["x-bot-secret"];

  if (!BOT_API_SECRET || secret !== BOT_API_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized bot service request."
    });
  }

  next();
}

// ==========================================
// PHONE VALIDATION
// ==========================================

function isValidPhone(phone) {
  return (
    typeof phone === "string" &&
    /^\+?\d{10,15}$/.test(phone.trim())
  );
}

// ==========================================
// PUBLIC HOME ROUTE
// ==========================================

app.get("/", (_req, res) => {
  res.status(200).json({
    success: true,

    service: "Afoo Technology WhatsApp Bot",

    message: "WhatsApp Bot API is running.",

    admin: "/admin",

    health: "/health",

    whatsappHealth: "/health/whatsapp",

    timestamp: new Date().toISOString()
  });
});

// ==========================================
// UPTIMEROBOT HEALTH CHECK
// ==========================================

// IMPORTANT:
// Configure UptimeRobot to monitor:
//
// https://YOUR-RENDER-DOMAIN.onrender.com/health
//
// This endpoint checks whether the Express server
// is running. It deliberately does not return 503
// when WhatsApp disconnects temporarily.
//
// This prevents a WhatsApp disconnection from
// being mistaken for a complete server outage.

app.head("/health", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  return res.status(200).end();
});

app.get("/health", noCache, (_req, res) => {
  const whatsapp = getWhatsAppStatus();

  return res.status(200).json({
    success: true,

    status: "online",

    service: "Afoo Technology WhatsApp Bot",

    monitoring: {
      provider: "UptimeRobot",

      endpoint: "/health",

      serverReachable: true
    },

    server: {
      status: "running",

      uptime: Math.floor(process.uptime()),

      startedAt: SERVER_STARTED_AT,

      memory: {
        rss: process.memoryUsage().rss,

        heapUsed: process.memoryUsage().heapUsed,

        heapTotal: process.memoryUsage().heapTotal
      }
    },

    whatsapp: {
      status: whatsapp.status,

      connected: whatsapp.status === "connected",

      robotName: whatsapp.robotName || "AFOO-X",

      typingIndicatorEnabled:
        whatsapp.typingIndicatorEnabled ?? false
    },

    timestamp: new Date().toISOString()
  });
});

// ==========================================
// WHATSAPP CONNECTION HEALTH
// ==========================================

// This endpoint checks the actual WhatsApp connection.
//
// HTTP 200 = WhatsApp connected.
// HTTP 503 = WhatsApp disconnected or connecting.
//
// Use this endpoint for manual diagnostics.
// Do not use it as the main UptimeRobot monitor
// if you only want to monitor the Express server.

app.get("/health/whatsapp", noCache, (_req, res) => {
  const whatsapp = getWhatsAppStatus();

  const connected = whatsapp.status === "connected";

  return res.status(connected ? 200 : 503).json({
    success: connected,

    status: connected ? "healthy" : "degraded",

    service: "Afoo Technology WhatsApp Bot",

    server: {
      status: "running",

      uptime: Math.floor(process.uptime())
    },

    whatsapp: {
      status: whatsapp.status,

      connected,

      robotName: whatsapp.robotName || "AFOO-X"
    },

    timestamp: new Date().toISOString()
  });
});

// ==========================================
// INTERNAL WHATSAPP OTP ENDPOINT
// ==========================================

app.post(
  "/internal/send-otp",
  botServiceAuth,
  async (req, res) => {
    try {
      const {
        phone,
        otp,
        name
      } = req.body || {};

      if (!phone || !otp) {
        return res.status(400).json({
          success: false,
          message: "Phone number and OTP are required."
        });
      }

      if (!/^\d{6}$/.test(String(otp))) {
        return res.status(400).json({
          success: false,
          message: "Invalid OTP format."
        });
      }

      if (!isValidPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "Invalid phone number."
        });
      }

      if (
        name !== undefined &&
        typeof name !== "string"
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid customer name."
        });
      }

      await sendWhatsAppOTP(
        phone,
        otp,
        name || "Customer"
      );

      return res.status(200).json({
        success: true,
        message: "WhatsApp OTP sent successfully."
      });

    } catch (error) {
      console.error(
        "WHATSAPP OTP DELIVERY ERROR:",
        error.message
      );

      return res.status(503).json({
        success: false,
        message: "WhatsApp OTP delivery failed."
      });
    }
  }
);

// ==========================================
// INTERNAL ORDER / PAYMENT NOTIFICATION
// ==========================================

app.post(
  "/internal/send-notification",
  botServiceAuth,
  async (req, res) => {
    try {
      const {
        phone,
        message,
        pdfBase64,
        fileName
      } = req.body || {};

      if (!isValidPhone(phone)) {
        return res.status(400).json({
          success: false,
          message: "A valid customer phone number is required."
        });
      }

      if (
        typeof message !== "string" ||
        !message.trim() ||
        message.length > 10000
      ) {
        return res.status(400).json({
          success: false,
          message: "A valid notification message is required."
        });
      }

      let pdfBuffer = null;

      // ======================================
      // OPTIONAL PDF VALIDATION
      // ======================================

      if (
        pdfBase64 !== undefined &&
        pdfBase64 !== null
      ) {
        if (
          typeof pdfBase64 !== "string" ||
          !pdfBase64.trim()
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid PDF receipt data."
          });
        }

        const estimatedSize = Math.floor(
          pdfBase64.length * 0.75
        );

        if (estimatedSize > MAX_PDF_SIZE) {
          return res.status(413).json({
            success: false,
            message: "PDF receipt exceeds the 7MB limit."
          });
        }

        pdfBuffer = Buffer.from(
          pdfBase64,
          "base64"
        );

        if (
          !pdfBuffer.length ||
          pdfBuffer.length > MAX_PDF_SIZE
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid or oversized PDF receipt."
          });
        }

        if (
          pdfBuffer.subarray(0, 5).toString() !== "%PDF-"
        ) {
          return res.status(400).json({
            success: false,
            message: "The supplied document is not a valid PDF."
          });
        }
      }

      // ======================================
      // SAFE FILE NAME
      // ======================================

      const safeFileName =
        typeof fileName === "string" && fileName.trim()
          ? fileName
              .replace(/[^a-zA-Z0-9._-]/g, "_")
              .slice(0, 100)
          : "Afoo-Technology-Receipt.pdf";

      // ======================================
      // SEND NOTIFICATION
      // ======================================

      const result = await sendWhatsAppNotification(
        phone,
        message.trim(),
        pdfBuffer,
        safeFileName
      );

      return res.status(200).json({
        success: true,

        message: pdfBuffer
          ? "WhatsApp notification and PDF receipt sent successfully."
          : "WhatsApp notification sent successfully.",

        receiptSent: Boolean(result?.receiptSent)
      });

    } catch (error) {
      console.error(
        "WHATSAPP NOTIFICATION ERROR:",
        error.message
      );

      return res.status(503).json({
        success: false,
        message: "WhatsApp notification delivery failed."
      });
    }
  }
);

// ==========================================
// ADMIN DASHBOARD
// ==========================================

app.get("/admin", noCache, (_req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >

  <meta
    name="robots"
    content="noindex,nofollow"
  >

  <title>Afoo Technology WhatsApp Admin</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      padding: 20px;
      margin: 0;
      color: #222;
    }

    .container {
      max-width: 500px;
      margin: 30px auto;
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow: 0 4px 20px #0001;
    }

    h2 {
      color: #087b45;
      text-align: center;
    }

    h3 {
      margin-top: 22px;
    }

    input, button {
      width: 100%;
      padding: 13px;
      margin: 8px 0;
      border-radius: 7px;
      border: 1px solid #ccc;
      font-size: 15px;
    }

    button {
      background: #087b45;
      color: white;
      border: 0;
      cursor: pointer;
    }

    button.secondary {
      background: #185abd;
    }

    button.danger {
      background: #c62828;
    }

    button:disabled {
      opacity: .6;
      cursor: not-allowed;
    }

    .status {
      padding: 13px;
      background: #f0f4f6;
      border-radius: 7px;
      margin: 15px 0;
      overflow-wrap: anywhere;
      line-height: 1.7;
    }

    .hint {
      color: #666;
      font-size: 13px;
      line-height: 1.5;
    }

    .pair-code {
      text-align: center;
      font-size: 28px;
      font-weight: bold;
      letter-spacing: 5px;
      color: #087b45;
      padding: 15px;
    }

    .connected {
      color: #087b45;
      font-weight: bold;
    }

    .disconnected {
      color: #c62828;
      font-weight: bold;
    }

    .warning {
      color: #b26a00;
      font-weight: bold;
    }

    .metric {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 9px 0;
      border-bottom: 1px solid #e8e8e8;
    }

    .metric:last-child {
      border-bottom: 0;
    }

    .metric span:last-child {
      text-align: right;
      overflow-wrap: anywhere;
    }

    .section {
      margin-top: 20px;
    }

    .monitor {
      padding: 13px;
      border: 1px solid #e5e5e5;
      border-radius: 8px;
      margin: 12px 0;
      overflow-wrap: anywhere;
    }

    .monitor a {
      color: #185abd;
      text-decoration: none;
      font-size: 13px;
    }

    hr {
      border: 0;
      border-top: 1px solid #eee;
      margin: 25px 0;
    }

    .footer {
      text-align: center;
      color: #999;
      font-size: 12px;
      margin-top: 25px;
    }

    .hidden {
      display: none;
    }
  </style>
</head>

<body>

  <div class="container">

    <h2>Afoo Technology</h2>

    <h3>WhatsApp Administration</h3>

    <label>Admin token</label>

    <input
      id="token"
      type="password"
      placeholder="Enter your Render ADMIN_TOKEN"
      autocomplete="off"
    >

    <button
      class="secondary"
      id="connectBtn"
      onclick="checkStatus()"
    >
      Authenticate & Check Status
    </button>

    <div id="status" class="status">
      Enter your admin token to continue.
    </div>

    <div id="dashboard" class="hidden">

      <hr>

      <h3>Server Monitoring</h3>

      <div class="status">

        <div class="metric">
          <span>Express server</span>
          <strong id="serverStatus">Checking...</strong>
        </div>

        <div class="metric">
          <span>WhatsApp connection</span>
          <strong id="whatsappStatus">Checking...</strong>
        </div>

        <div class="metric">
          <span>Server uptime</span>
          <strong id="serverUptime">--</strong>
        </div>

        <div class="metric">
          <span>Robot name</span>
          <strong id="robotName">--</strong>
        </div>

        <div class="metric">
          <span>Typing indicator</span>
          <strong id="typingStatus">--</strong>
        </div>

        <div class="metric">
          <span>Last checked</span>
          <strong id="lastChecked">--</strong>
        </div>

      </div>

      <div class="monitor">

        <strong>Public server health</strong>

        <p class="hint">
          Use this URL in UptimeRobot to monitor
          your Render service.
        </p>

        <a href="/health" target="_blank">
          /health
        </a>

      </div>

      <div class="monitor">

        <strong>WhatsApp connection health</strong>

        <p class="hint">
          This endpoint returns HTTP 200 when WhatsApp
          is connected and HTTP 503 when disconnected.
        </p>

        <a href="/health/whatsapp" target="_blank">
          /health/whatsapp
        </a>

      </div>

      <button
        class="secondary"
        onclick="checkStatus()"
      >
        Refresh Status
      </button>

      <hr>

      <h3>Phone-number pairing</h3>

      <input
        id="phone"
        type="tel"
        placeholder="2348012345678"
      >

      <button
        id="pairBtn"
        onclick="pairWhatsApp()"
      >
        Generate Pairing Code
      </button>

      <div id="pairResult" class="status">
        Your pairing code will appear here.
      </div>

      <p class="hint">
        Enter your number with country code, digits only.
        For Nigeria, use 234 followed by your phone number.
      </p>

      <hr>

      <button
        class="danger"
        onclick="logoutDashboard()"
      >
        Clear Admin Session
      </button>

    </div>

    <div class="footer">
      Afoo Technology WhatsApp Automation System
      <br>
      Powered by AFOO-X
    </div>

  </div>

<script>

// ==========================================
// ELEMENTS
// ==========================================

const tokenInput = document.getElementById("token");

const statusBox = document.getElementById("status");

const pairResult = document.getElementById("pairResult");

const dashboard = document.getElementById("dashboard");

let isAuthenticated = false;

let refreshInterval = null;

let requestInProgress = false;

// ==========================================
// API REQUEST
// ==========================================

async function api(path, options = {}) {
  const token = tokenInput.value.trim();

  if (!token) {
    throw new Error("Enter your admin token first.");
  }

  const response = await fetch(path, {
    ...options,

    cache: "no-store",

    headers: {
      "Content-Type": "application/json",

      "Authorization": "Bearer " + token,

      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || "Request failed."
    );
  }

  return data;
}

// ==========================================
// HTML ESCAPING
// ==========================================

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

// ==========================================
// FORMAT UPTIME
// ==========================================

function formatUptime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);

  const days = Math.floor(value / 86400);

  const hours = Math.floor((value % 86400) / 3600);

  const minutes = Math.floor((value % 3600) / 60);

  const remainingSeconds = Math.floor(value % 60);

  return (
    days + "d " +
    hours + "h " +
    minutes + "m " +
    remainingSeconds + "s"
  );
}

// ==========================================
// DISPLAY STATUS
// ==========================================

function displayStatus(data) {
  const connected = data.whatsapp?.status === "connected";

  document.getElementById("serverStatus").innerHTML =
    '<span class="connected">RUNNING</span>';

  document.getElementById("whatsappStatus").innerHTML =
    connected
      ? '<span class="connected">CONNECTED</span>'
      : '<span class="disconnected">' +
        escapeHTML(data.whatsapp?.status || "DISCONNECTED") +
        "</span>";

  document.getElementById("serverUptime").textContent =
    formatUptime(data.server?.uptime);

  document.getElementById("robotName").textContent =
    data.whatsapp?.robotName || "AFOO-X";

  document.getElementById("typingStatus").textContent =
    data.whatsapp?.typingIndicatorEnabled
      ? "Enabled"
      : "Disabled";

  document.getElementById("lastChecked").textContent =
    new Date().toLocaleTimeString();

  statusBox.innerHTML =
    "<strong>Authentication:</strong> " +
    '<span class="connected">Successful</span><br>' +

    "<strong>Server:</strong> " +
    '<span class="connected">Running</span><br>' +

    "<strong>WhatsApp:</strong> " +
    '<span class="' +
    (connected ? "connected" : "disconnected") +
    '">' +
    escapeHTML(data.whatsapp?.status || "Unknown") +
    "</span><br>" +

    "<strong>Uptime:</strong> " +
    escapeHTML(formatUptime(data.server?.uptime));

  if (data.pairingCode) {
    pairResult.innerHTML =
      "Pairing code:" +
      '<div class="pair-code">' +
      escapeHTML(data.pairingCode) +
      "</div>";
  }

  dashboard.classList.remove("hidden");
}

// ==========================================
// CONNECTION STATUS
// ==========================================

async function checkStatus() {
  if (requestInProgress) return;

  const button = document.getElementById("connectBtn");

  button.disabled = true;

  requestInProgress = true;

  try {
    const data = await api("/admin/status");

    isAuthenticated = true;

    displayStatus(data);

    startAutoRefresh();

  } catch (error) {
    isAuthenticated = false;

    dashboard.classList.add("hidden");

    statusBox.innerText = error.message;

    if (refreshInterval) {
      clearInterval(refreshInterval);
      refreshInterval = null;
    }

  } finally {
    button.disabled = false;

    requestInProgress = false;
  }
}

// ==========================================
// PAIR WITH PHONE NUMBER
// ==========================================

async function pairWhatsApp() {
  const phone = document
    .getElementById("phone")
    .value
    .trim();

  const button = document.getElementById("pairBtn");

  if (!/^\\+?\\d{10,15}$/.test(phone)) {
    pairResult.innerText =
      "Enter a valid international phone number.";

    return;
  }

  button.disabled = true;

  pairResult.innerText =
    "Requesting pairing code...";

  try {
    const data = await api("/admin/pair", {
      method: "POST",

      body: JSON.stringify({
        phoneNumber: phone
      })
    });

    pairResult.innerText =
      data.message || "Pairing request submitted.";

    if (data.pairingCode) {
      pairResult.innerHTML =
        "Your pairing code:" +
        '<div class="pair-code">' +
        escapeHTML(data.pairingCode) +
        "</div>";
    }

    // Refresh shortly to get the latest code/status.
    setTimeout(() => {
      if (isAuthenticated) {
        checkStatus();
      }
    }, 3000);

  } catch (error) {
    pairResult.innerText = error.message;

  } finally {
    button.disabled = false;
  }
}

// ==========================================
// AUTO REFRESH
// ==========================================

function startAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }

  refreshInterval = setInterval(() => {
    if (
      isAuthenticated &&
      tokenInput.value.trim()
    ) {
      checkStatus();
    }
  }, 15000);
}

// ==========================================
// CLEAR ADMIN SESSION
// ==========================================

function logoutDashboard() {
  tokenInput.value = "";

  isAuthenticated = false;

  if (refreshInterval) {
    clearInterval(refreshInterval);

    refreshInterval = null;
  }

  dashboard.classList.add("hidden");

  statusBox.innerText =
    "Admin session cleared.";

  pairResult.innerText =
    "Your pairing code will appear here.";

  document.getElementById("phone").value = "";
}

// ==========================================
// ENTER KEY SUPPORT
// ==========================================

tokenInput.addEventListener("keydown", event => {
  if (event.key === "Enter") {
    checkStatus();
  }
});

document.getElementById("phone").addEventListener(
  "keydown",
  event => {
    if (event.key === "Enter") {
      pairWhatsApp();
    }
  }
);

</script>

</body>
</html>`);
});

// ==========================================
// ADMIN STATUS
// ==========================================

app.get(
  "/admin/status",
  adminAuth,
  noCache,
  (_req, res) => {
    return res.json({
      success: true,

      server: {
        status: "running",

        uptime: Math.floor(process.uptime()),

        startedAt: SERVER_STARTED_AT
      },

      ...getWhatsAppStatus(),

      timestamp: new Date().toISOString()
    });
  }
);

// ==========================================
// ADMIN QR CODE
// ==========================================

// Retained for compatibility with existing API clients.
// The current Afoo bot uses phone-number pairing only.

app.get(
  "/admin/qr",
  adminAuth,
  noCache,
  (_req, res) => {
    const qr = getCurrentQR();

    if (!qr) {
      const status = getWhatsAppStatus();

      return res.status(404).json({
        success: false,

        message: status.status === "connected"
          ? "WhatsApp is already connected."
          : "QR pairing is disabled. Use phone-number pairing.",

        status: status.status,

        qrAvailable: false,

        error: status.qrGenerationError || null
      });
    }

    return res.json({
      success: true,

      qr,

      message: "WhatsApp QR code is ready."
    });
  }
);

// ==========================================
// ADMIN PAIRING
// ==========================================

app.post(
  "/admin/pair",
  adminAuth,
  async (req, res) => {
    try {
      const {
        phoneNumber
      } = req.body || {};

      if (!isValidPhone(phoneNumber)) {
        return res.status(400).json({
          success: false,

          message: "Enter a valid international phone number."
        });
      }

      const result = await requestPairing(phoneNumber);

      return res.json(result);

    } catch (error) {
      console.error(
        "PAIRING ERROR:",
        error.message
      );

      return res.status(400).json({
        success: false,

        message: error.message
      });
    }
  }
);

// ==========================================
// 404
// ==========================================

app.use((req, res) => {
  return res.status(404).json({
    success: false,

    message: "Endpoint not found.",

    path: req.originalUrl
  });
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((error, _req, res, _next) => {
  console.error(
    "SERVER ERROR:",
    error
  );

  if (error.type === "entity.too.large") {
    return res.status(413).json({
      success: false,
      message: "Request payload is too large."
    });
  }

  return res.status(500).json({
    success: false,

    message: "Internal server error."
  });
});

// ==========================================
// START SERVER AND WHATSAPP
// ==========================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log("----------------------------------");

    console.log("AFOO TECHNOLOGY WHATSAPP BOT");

    console.log("----------------------------------");

    console.log(`Port: ${PORT}`);

    console.log("Admin Dashboard: /admin");

    console.log("UptimeRobot Health: /health");

    console.log("WhatsApp Health: /health/whatsapp");

    console.log("Pairing: Phone number");

    console.log("----------------------------------");

    startWhatsApp().catch(error => {
      console.error(
        "WHATSAPP STARTUP ERROR:",
        error
      );
    });
  }
);

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `${signal} received. Shutting down server...`
  );

  // Stop accepting new HTTP connections.
  server.close(() => {
    console.log("Express server closed.");
  });

  try {
    // Stop the WhatsApp socket and its reconnect loop.
    const { stopWhatsApp } = await import("./bot.js");

    await stopWhatsApp();

  } catch (error) {
    console.error(
      "WHATSAPP SHUTDOWN ERROR:",
      error.message
    );
  }

  process.exit(0);
}

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
});
