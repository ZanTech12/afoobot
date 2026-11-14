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

const PORT = process.env.PORT || 3000;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const BOT_API_SECRET = process.env.BOT_API_SECRET;

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(
  express.json({
    limit: "12mb"
  })
);

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

function adminAuth(req, res, next) {
  const token =
    req.headers.authorization?.replace(
      /^Bearer\s+/i,
      ""
    );

  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return res.status(401).json({
      success: false,
      message: "Unauthorised."
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
// HOME ROUTE
// ==========================================

app.get("/", (_req, res) => {
  res.json({
    success: true,
    service: "Afoo Technology WhatsApp Bot",
    whatsapp: getWhatsAppStatus().status
  });
});

// ==========================================
// HEALTH CHECK
// ==========================================

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    whatsapp: getWhatsAppStatus()
  });
});

// ==========================================
// ADMIN STATUS
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
// GET QR CODE
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
// REQUEST PAIRING CODE
// ==========================================

app.post(
  "/admin/pair",
  adminAuth,
  async (req, res) => {
    try {
      const result = await requestPairing(
        req.body?.phoneNumber
      );

      res.json(result);

    } catch (error) {
      res.status(400).json({
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
          message: "phone and otp are required."
        });
      }

      await sendWhatsAppOTP(
        phone,
        otp,
        name || "Customer"
      );

      res.json({
        success: true,
        message: "WhatsApp OTP sent."
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
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

      if (!phone || !message) {
        return res.status(400).json({
          success: false,
          message: "phone and message are required."
        });
      }

      const pdfBuffer = pdfBase64
        ? Buffer.from(pdfBase64, "base64")
        : null;

      await sendWhatsAppNotification(
        phone,
        message,
        pdfBuffer,
        fileName || "Afoo-Technology-Receipt.pdf"
      );

      res.json({
        success: true,
        message: "WhatsApp notification sent."
      });

    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
);

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================

app.use(
  (error, _req, res, _next) => {
    console.error(
      "Server error:",
      error
    );

    res.status(500).json({
      success: false,
      message: "Internal server error."
    });
  }
);

// ==========================================
// START SERVER AND WHATSAPP
// ==========================================

app.listen(PORT, () => {
  console.log(
    `Afoo Technology WhatsApp Bot listening on port ${PORT}`
  );

  startWhatsApp().catch((error) => {
    console.error(
      "Initial WhatsApp connection failed:",
      error.message
    );
  });
});