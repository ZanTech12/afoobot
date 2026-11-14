
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

app.use(
  express.json({
    limit: "12mb"
  })
);

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
// BOT API AUTHENTICATION
// ==========================================

function botApiAuth(req, res, next) {
  const token = req.headers["x-bot-secret"];

  if (!BOT_API_SECRET || token !== BOT_API_SECRET) {
    return res.status(401).json({
      success: false,
      message: "Invalid bot API secret."
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
    whatsapp: getWhatsAppStatus().status
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

  <title>Afoo Technology | WhatsApp Admin</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 20px;
      font-family: Arial, sans-serif;
      background: #f3f6f8;
      color: #17202a;
    }

    .container {
      max-width: 550px;
      margin: 35px auto;
      background: white;
      padding: 25px;
      border-radius: 15px;
      box-shadow: 0 5px 25px #00000012;
    }

    .header {
      text-align: center;
      margin-bottom: 25px;
    }

    .logo {
      width: 65px;
      height: 65px;
      background: #075e45;
      color: white;
      border-radius: 18px;
      display: flex;
      justify-content: center;
      align-items: center;
      font-size: 27px;
      font-weight: bold;
      margin: auto auto 12px;
    }

    h2 {
      margin: 5px 0;
      color: #075e45;
    }

    h3 {
      margin-top: 25px;
      font-size: 17px;
    }

    .subtitle {
      color: #777;
      font-size: 13px;
    }

    label {
      display: block;
      font-weight: bold;
      font-size: 13px;
      margin-top: 15px;
    }

    input {
      width: 100%;
      padding: 14px;
      margin-top: 8px;
      border: 1px solid #ddd;
      border-radius: 8px;
      font-size: 15px;
      outline: none;
    }

    input:focus {
      border-color: #087b50;
    }

    button {
      width: 100%;
      border: none;
      padding: 14px;
      border-radius: 8px;
      margin-top: 12px;
      background: #087b50;
      color: white;
      font-size: 14px;
      font-weight: bold;
      cursor: pointer;
    }

    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    button.secondary {
      background: #185abd;
    }

    button.danger {
      background: #b42318;
    }

    .status {
      background: #f2f5f6;
      padding: 15px;
      border-radius: 8px;
      margin-top: 15px;
      font-size: 14px;
      line-height: 1.7;
      overflow-wrap: anywhere;
    }

    .connected {
      color: #087b50;
      font-weight: bold;
    }

    .disconnected {
      color: #b42318;
      font-weight: bold;
    }

    .pair-code {
      font-size: 27px;
      font-weight: bold;
      letter-spacing: 5px;
      text-align: center;
      color: #087b50;
      padding: 15px;
    }

    #qr {
      display: none;
      width: 260px;
      max-width: 100%;
      margin: 20px auto;
      border: 1px solid #eee;
      padding: 10px;
      border-radius: 10px;
    }

    .hint {
      font-size: 12px;
      line-height: 1.6;
      color: #777;
    }

    .divider {
      border: none;
      border-top: 1px solid #eee;
      margin: 25px 0;
    }

    .footer {
      text-align: center;
      color: #999;
      font-size: 12px;
      margin-top: 25px;
    }

    @media(max-width: 480px) {
      body {
        padding: 10px;
      }

      .container {
        margin: 10px auto;
        padding: 20px;
      }
    }
  </style>

</head>

<body>

<div class="container">

  <div class="header">

    <div class="logo">A</div>

    <h2>Afoo Technology</h2>

    <div class="subtitle">
      WhatsApp Bot Administration Panel
    </div>

  </div>

  <!-- ADMIN LOGIN -->

  <h3>Administrator Authentication</h3>

  <label>Admin Access Token</label>

  <input
    id="token"
    type="password"
    placeholder="Enter your ADMIN_TOKEN"
    autocomplete="off"
  >

  <button
    class="secondary"
    id="connectBtn"
    onclick="checkStatus()"
  >
    Authenticate & Connect
  </button>

  <div id="status" class="status">
    Enter your admin token to access bot controls.
  </div>

  <hr class="divider">

  <!-- WHATSAPP PAIRING -->

  <h3>Connect WhatsApp Using Phone Number</h3>

  <label>WhatsApp Phone Number</label>

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
    Your WhatsApp pairing code will appear here.
  </div>

  <p class="hint">
    Enter your number with country code.
    For Nigeria, use 234 followed by your phone number.
    Do not include spaces.
  </p>

  <hr class="divider">

  <!-- QR CODE -->

  <h3>Connect WhatsApp Using QR Code</h3>

  <button
    class="secondary"
    onclick="loadQR()"
  >
    Display WhatsApp QR Code
  </button>

  <div style="text-align:center">

    <img
      id="qr"
      alt="WhatsApp QR Code"
    >

  </div>

  <p class="hint">
    Open WhatsApp Business on your phone.
    Go to Linked Devices, select Link a Device
    and scan the displayed QR code.
  </p>

  <hr class="divider">

  <button
    class="danger"
    onclick="logoutDashboard()"
  >
    Clear Admin Session
  </button>

  <div class="footer">
    Afoo Technology WhatsApp Automation System
  </div>

</div>

<script>

// ==========================================
// DASHBOARD VARIABLES
// ==========================================

const tokenInput = document.getElementById("token");

const statusBox = document.getElementById("status");

const pairResult = document.getElementById("pairResult");

let refreshInterval = null;

let isAuthenticated = false;

// ==========================================
// API REQUEST
// ==========================================

async function api(path, options = {}) {

  const token = tokenInput.value.trim();

  if (!token) {
    throw new Error("Please enter your admin token.");
  }

  const response = await fetch(path, {
    ...options,

    headers: {
      "Content-Type": "application/json",

      "Authorization": "Bearer " + token,

      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {

    if (response.status === 401) {
      isAuthenticated = false;
    }

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
// CONNECTION STATUS
// ==========================================

async function checkStatus() {

  const button = document.getElementById("connectBtn");

  button.disabled = true;

  statusBox.innerText = "Checking WhatsApp connection...";

  try {

    const data = await api("/admin/status");

    isAuthenticated = true;

    const whatsappStatus = String(
      data.status || "unknown"
    );

    const connected =
      whatsappStatus.toLowerCase() === "connected";

    // Build status HTML without nested template literals.

    statusBox.innerHTML =
      "<strong>Server Authentication:</strong> " +
      '<span class="connected">Successful</span>' +
      "<br>" +

      "<strong>WhatsApp Status:</strong> " +

      '<span class="' +
      (connected ? "connected" : "disconnected") +
      '">' +

      escapeHTML(whatsappStatus) +

      "</span>" +

      "<br>" +

      "<strong>Last Checked:</strong> " +
      escapeHTML(new Date().toLocaleTimeString());

    if (data.pairingCode) {

      pairResult.innerHTML =
        "Pairing Code:" +
        "<div class='pair-code'>" +
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
// WHATSAPP PAIRING
// ==========================================

async function pairWhatsApp() {

  const phone = document
    .getElementById("phone")
    .value
    .trim();

  const button = document.getElementById("pairBtn");

  if (!phone) {

    pairResult.innerText =
      "Enter your WhatsApp phone number.";

    return;

  }

  if (!/^\+?\d{10,15}$/.test(phone)) {

    pairResult.innerText =
      "Enter a valid international phone number.";

    return;

  }

  button.disabled = true;

  pairResult.innerText =
    "Requesting WhatsApp pairing code...";

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
        "Your WhatsApp Pairing Code:" +
        "<div class='pair-code'>" +
        escapeHTML(data.pairingCode) +
        "</div>";

    }

    setTimeout(checkStatus, 3000);

    setTimeout(checkStatus, 8000);

  } catch (error) {

    pairResult.innerText = error.message;

  } finally {

    button.disabled = false;

  }

}

// ==========================================
// DISPLAY QR CODE
// ==========================================

async function loadQR() {

  const qrImage = document.getElementById("qr");

  statusBox.innerText =
    "Loading WhatsApp QR code...";

  try {

    const data = await api("/admin/qr");

    if (!data.success || !data.qr) {

      qrImage.style.display = "none";

      throw new Error(
        data.message || "WhatsApp QR code is not ready."
      );

    }

    qrImage.src = data.qr;

    qrImage.style.display = "block";

    statusBox.innerText =
      "QR code loaded successfully.";

  } catch (error) {

    statusBox.innerText = error.message;

  }

}

// ==========================================
// AUTOMATIC STATUS REFRESH
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

  document.getElementById("qr").style.display = "none";

  statusBox.innerText =
    "Admin session cleared.";

  pairResult.innerText =
    "Your pairing code will appear here.";

}

// ==========================================
// ENTER KEY LOGIN
// ==========================================

tokenInput.addEventListener("keydown", event => {

  if (event.key === "Enter") {

    checkStatus();

  }

});

</script>

</body>
</html>`);
});

// ==========================================
// ADMIN STATUS API
// ==========================================

app.get(
  "/admin/status",
  adminAuth,
  (_req, res) => {

    res.json({
      success: true,
      ...getWhatsAppStatus()
    });

  }
);

// ==========================================
// ADMIN QR CODE API
// ==========================================

app.get(
  "/admin/qr",
  adminAuth,
  (_req, res) => {

    const qr = getCurrentQR();

    if (!qr) {

      return res.status(404).json({
        success: false,
        message: "QR code is not currently available."
      });

    }

    res.json({
      success: true,
      qr
    });

  }
);

// ==========================================
// ADMIN PAIRING API
// ==========================================

app.post(
  "/admin/pair",
  adminAuth,
  async (req, res) => {

    try {

      const { phoneNumber } = req.body || {};

      if (!isValidPhone(phoneNumber)) {

        return res.status(400).json({
          success: false,
          message: "A valid international phone number is required."
        });

      }

      const result = await requestPairing(
        phoneNumber.trim()
      );

      return res.json({
        success: true,
        ...result
      });

    } catch (error) {

      console.error(
        "WHATSAPP PAIRING ERROR:",
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
// SEND WHATSAPP OTP
// ==========================================

app.post(
  "/api/whatsapp/otp",
  botApiAuth,
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

      if (!isValidPhone(phone)) {

        return res.status(400).json({
          success: false,
          message: "Invalid phone number."
        });

      }

      if (!/^\d{6}$/.test(String(otp))) {

        return res.status(400).json({
          success: false,
          message: "Invalid OTP format."
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
// SEND WHATSAPP NOTIFICATION
// ==========================================

app.post(
  "/api/whatsapp/notification",
  botApiAuth,
  async (req, res) => {

    try {

      const {
        phone,
        message,
        pdfBase64,
        fileName
      } = req.body || {};

      // Validate phone number.

      if (!isValidPhone(phone)) {

        return res.status(400).json({
          success: false,
          message: "A valid customer phone number is required."
        });

      }

      // Validate message.

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

        // Estimate decoded Base64 size.

        const estimatedSize = Math.floor(
          pdfBase64.length * 0.75
        );

        if (estimatedSize > MAX_PDF_SIZE) {

          return res.status(413).json({
            success: false,
            message: "PDF receipt exceeds the 7MB limit."
          });

        }

        // Decode Base64.

        pdfBuffer = Buffer.from(
          pdfBase64,
          "base64"
        );

        // Validate actual decoded size.

        if (
          !pdfBuffer.length ||
          pdfBuffer.length > MAX_PDF_SIZE
        ) {

          return res.status(400).json({
            success: false,
            message: "Invalid or oversized PDF receipt."
          });

        }

        // Validate PDF signature.

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
      // SEND WHATSAPP NOTIFICATION
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
// 404 HANDLER
// ==========================================

app.use((req, res) => {

  res.status(404).json({
    success: false,
    message: "Endpoint not found.",
    path: req.originalUrl
  });

});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================

app.use((error, _req, res, _next) => {

  console.error(
    "SERVER ERROR:",
    error
  );

  res.status(500).json({
    success: false,
    message: "Internal server error."
  });

});

// ==========================================
// START SERVER
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

    console.log("Health Check: /health");

    console.log("----------------------------------");

    startWhatsApp().catch(error => {

      console.error(
        "WHATSAPP STARTUP ERROR:",
        error.message
      );

    });

  }
);

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================

let shuttingDown = false;

function shutdown(signal) {

  if (shuttingDown) return;

  shuttingDown = true;

  console.log(
    `${signal} received. Shutting down server...`
  );

  server.close(() => {

    console.log("Express server closed.");

    process.exit(0);

  });

  setTimeout(() => {

    console.error("Forced shutdown.");

    process.exit(1);

  }, 10000).unref();

}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
