
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
    health: "/health"
  });
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (_req, res) => {
  res.status(200).json({
    success: true,
    status: "online",
    service: "Afoo Technology WhatsApp Bot",

    server: {
      status: "running",
      uptime: Math.floor(process.uptime()),
      startedAt: SERVER_STARTED_AT
    },

    whatsapp: getWhatsAppStatus(),

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
      const { phone, otp, name } = req.body || {};

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

      if (name !== undefined && typeof name !== "string") {
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

      if (pdfBase64 !== undefined && pdfBase64 !== null) {
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

        pdfBuffer = Buffer.from(pdfBase64, "base64");

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

      await sendWhatsAppNotification(
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
        receiptSent: Boolean(pdfBuffer)
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

app.get("/admin", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.type("html").send(`<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
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
      max-width: 480px;
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

    input, button {
      box-sizing: border-box;
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

    button:disabled {
      opacity: .6;
      cursor: not-allowed;
    }

    #qr {
      width: 280px;
      max-width: 100%;
      display: none;
      margin: 20px auto;
    }

    .status {
      padding: 12px;
      background: #f0f4f6;
      border-radius: 7px;
      margin: 15px 0;
      overflow-wrap: anywhere;
      line-height: 1.6;
    }

    .hint {
      color: #666;
      font-size: 13px;
      line-height: 1.5;
    }

    .pair-code {
      text-align: center;
      font-size: 27px;
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

    <hr>

    <h3>Option 1: Pair using phone number</h3>

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

    <h3>Option 2: Connect with QR code</h3>

    <button
      class="secondary"
      id="qrBtn"
      onclick="loadQR()"
    >
      Generate / Display QR Code
    </button>

    <div style="text-align:center">
      <img id="qr" alt="WhatsApp QR code">
    </div>

    <p class="hint">
      Open WhatsApp Business, go to Linked Devices,
      select Link a Device and scan the QR code.
    </p>

    <hr>

    <button
      class="secondary"
      onclick="logoutDashboard()"
    >
      Clear Admin Session
    </button>

    <div class="footer">
      Afoo Technology WhatsApp Automation System
    </div>

  </div>

<script>

const tokenInput = document.getElementById("token");
const statusBox = document.getElementById("status");
const pairResult = document.getElementById("pairResult");

let isAuthenticated = false;
let refreshInterval = null;

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
    throw new Error(data.message || "Request failed.");
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
// CONNECTION STATUS
// ==========================================

async function checkStatus() {
  const button = document.getElementById("connectBtn");

  button.disabled = true;

  try {
    const data = await api("/admin/status");

    isAuthenticated = true;

    const connected =
      data.status === "connected";

    statusBox.innerHTML =
      "<strong>Authentication:</strong> " +
      '<span class="connected">Successful</span><br>' +
      "<strong>WhatsApp:</strong> " +
      '<span class="' +
      (connected ? "connected" : "disconnected") +
      '">' +
      escapeHTML(data.status) +
      "</span><br>" +
      "<strong>QR Available:</strong> " +
      escapeHTML(String(data.qrAvailable)) +
      "<br>" +
      "<strong>Last Checked:</strong> " +
      escapeHTML(new Date().toLocaleTimeString());

    if (data.pairingCode) {
      pairResult.innerHTML =
        "Pairing code:" +
        '<div class="pair-code">' +
        escapeHTML(data.pairingCode) +
        "</div>";
    }

    startAutoRefresh();

  } catch (error) {
    isAuthenticated = false;
    statusBox.innerText = error.message;

  } finally {
    button.disabled = false;
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

    pairResult.innerText = data.message || "Pairing request submitted.";

    if (data.pairingCode) {
      pairResult.innerHTML =
        "Your pairing code:" +
        '<div class="pair-code">' +
        escapeHTML(data.pairingCode) +
        "</div>";
    }

    setTimeout(checkStatus, 3000);

  } catch (error) {
    pairResult.innerText = error.message;

  } finally {
    button.disabled = false;
  }
}

// ==========================================
// LOAD WHATSAPP QR CODE
// ==========================================

async function loadQR() {
  const img = document.getElementById("qr");
  const button = document.getElementById("qrBtn");

  button.disabled = true;
  img.style.display = "none";

  statusBox.innerText =
    "Waiting for WhatsApp to generate a QR code...";

  try {
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch("/admin/qr", {
        cache: "no-store",
        headers: {
          "Authorization": "Bearer " + tokenInput.value.trim()
        }
      });

      const data = await response.json().catch(() => ({}));

      if (response.status === 401) {
        throw new Error("Unauthorized. Check your admin token.");
      }

      if (data.success && data.qr) {
        img.onload = () => {
          img.style.display = "block";
          statusBox.innerText =
            "QR code is ready. Scan it with WhatsApp.";
        };

        img.onerror = () => {
          statusBox.innerText =
            "QR image could not be displayed.";
        };

        img.src = data.qr;

        return;
      }

      if (data.status === "connected") {
        throw new Error(
          "WhatsApp is already connected. No QR code is required."
        );
      }

      statusBox.innerText =
        "Waiting for QR code... (" +
        (attempt + 1) +
        "/20)";

      await new Promise(resolve =>
        setTimeout(resolve, 2000)
      );
    }

    throw new Error(
      "QR code was not generated after 40 seconds. Check the server logs and WhatsApp connection status."
    );

  } catch (error) {
    statusBox.innerText = error.message;

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
    if (isAuthenticated && tokenInput.value.trim()) {
      checkStatus();
    }
  }, 15000);
}

// ==========================================
// CLEAR SESSION
// ==========================================

function logoutDashboard() {
  tokenInput.value = "";
  isAuthenticated = false;

  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  document.getElementById("qr").style.display = "none";

  statusBox.innerText = "Admin session cleared.";

  pairResult.innerText =
    "Your pairing code will appear here.";
}

</script>

</body>
</html>`);
});

// ==========================================
// ADMIN STATUS
// ==========================================

app.get("/admin/status", adminAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    success: true,
    ...getWhatsAppStatus()
  });
});

// ==========================================
// ADMIN QR CODE
// ==========================================

app.get("/admin/qr", adminAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");

  const qr = getCurrentQR();

  if (!qr) {
    const status = getWhatsAppStatus();

    return res.status(404).json({
      success: false,
      message: status.status === "connected"
        ? "WhatsApp is already connected."
        : "QR code is not ready yet.",
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
});

// ==========================================
// ADMIN PAIRING
// ==========================================

app.post("/admin/pair", adminAuth, async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};

    if (!isValidPhone(phoneNumber)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid international phone number."
      });
    }

    const result = await requestPairing(phoneNumber);

    return res.json(result);

  } catch (error) {
    console.error("PAIRING ERROR:", error.message);

    return res.status(400).json({
      success: false,
      message: error.message
    });
  }
});
// ==========================================
// 404
// ==========================================

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Endpoint not found.",
    path: req.originalUrl
  });
});

// ==========================================
// ERROR HANDLER
// ==========================================

app.use((error, _req, res, _next) => {
  console.error("SERVER ERROR:", error);

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });
});

// ==========================================
// START SERVER AND WHATSAPP
// ==========================================

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log("----------------------------------");
  console.log("AFOO TECHNOLOGY WHATSAPP BOT");
  console.log("----------------------------------");
  console.log(`Port: ${PORT}`);
  console.log("Admin Dashboard: /admin");
  console.log("Health Check: /health");
  console.log("----------------------------------");

  startWhatsApp().catch(error => {
    console.error("WHATSAPP STARTUP ERROR:", error);
  });
});

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`${signal} received. Shutting down server...`);

  server.close(() => {
    console.log("Express server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
