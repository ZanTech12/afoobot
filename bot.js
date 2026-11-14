import "dotenv/config";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import P from "pino";
import QRCode from "qrcode";
import fs from "fs";
import path from "path";

const STORE_NAME = process.env.STORE_NAME || "Afoo Technology";

const TEXT_ONLY_MODE =
  (process.env.TEXT_ONLY_MODE || "true").toLowerCase() === "true";

const AFOO_PRODUCT_NOTICE_MODE =
  (process.env.AFOO_PRODUCT_NOTICE_MODE || "true").toLowerCase() === "true";

const AFOO_LUMI_NOTICE =
  process.env.AFOO_LUMI_NOTICE ||
  `Thank you for contacting *Afoo Technology*! 😊

Our API key has already been connected to the Lumi platform. However, the integration is still being finalised and is expected to be fully established within at least *two working days*.

We appreciate your patience. Our team will be glad to assist you with your phone accessories and replacement-parts enquiries once the integration is complete. 🙏`;

const AUTH_FOLDER =
  process.env.AUTH_FOLDER || path.join(process.cwd(), "auth_info");

const logger = P({
  level: process.env.LOG_LEVEL || "silent"
});

let sock = null;
let currentQR = null;
let pairingCode = null;
let pendingPairingNumber = null;
let connectionStatus = "disconnected";
let starting = false;
let reconnectTimer = null;
let manualClose = false;

const handledMessages = new Set();

// ==========================================
// PHONE NUMBER HELPERS
// ==========================================

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toJid(phone) {
  const number = normalizePhone(phone);
  return `${number}@s.whatsapp.net`;
}

// ==========================================
// CONNECTION HELPERS
// ==========================================

function isConnected() {
  return Boolean(sock?.user) && connectionStatus === "connected";
}

async function sendText(jid, message) {
  if (!isConnected()) {
    throw new Error("WhatsApp is not connected.");
  }

  return sock.sendMessage(jid, {
    text: String(message || "")
  });
}

// ==========================================
// MESSAGE DETECTION
// ==========================================

function isGreeting(text) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|greetings|menu|start)\b/i
    .test(String(text || "").trim());
}

function isProductEnquiry(text) {
  return /\b(product|price|cost|available|availability|stock|buy|purchase|order|screen|display|lcd|touch|mouthpiece|charging port|charging flex|battery|phone case|case|charger|accessor(?:y|ies)|replacement|spare part|phone part|samsung|iphone|tecno|infinix|itel|xiaomi|redmi|oppo|vivo|nokia)\b/i
    .test(String(text || ""));
}

// ==========================================
// CUSTOMER WELCOME MESSAGE
// ==========================================

function getWelcome() {
  return `Welcome to *${STORE_NAME}*! 👋

We deal in phone accessories and replacement parts, including screens, mouthpieces, charging ports and other phone components.

Please tell us what you need and include your phone brand and model where possible.`;
}

// ==========================================
// INCOMING MESSAGE HANDLER
// ==========================================

async function handleIncomingMessage(message) {
  const remoteJid = message?.key?.remoteJid;

  if (
    !remoteJid ||
    remoteJid === "status@broadcast" ||
    message?.key?.fromMe
  ) {
    return;
  }

  // Ignore group messages
  if (remoteJid.endsWith("@g.us")) {
    return;
  }

  // Prevent duplicate message processing
  const messageId = message?.key?.id;

  if (messageId && handledMessages.has(messageId)) {
    return;
  }

  if (messageId) {
    handledMessages.add(messageId);

    if (handledMessages.size > 2000) {
      handledMessages.clear();
    }
  }

  const content = message.message || {};

  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    "";

  const normalized = String(text).trim();

  // Text-only handling
  if (!normalized) {
    if (TEXT_ONLY_MODE) {
      await sendText(
        remoteJid,
        `Thank you for contacting *${STORE_NAME}*. We currently handle enquiries through text messages only. Please type your enquiry here.`
      );
    }

    return;
  }

  console.log(`Message received from ${remoteJid}: ${normalized}`);

  // ========================================
  // PRODUCT ENQUIRY - LUMI NOTICE
  // ========================================

  if (
    AFOO_PRODUCT_NOTICE_MODE &&
    isProductEnquiry(normalized)
  ) {
    await sendText(remoteJid, AFOO_LUMI_NOTICE);
    return;
  }

  // ========================================
  // GREETING
  // ========================================

  if (isGreeting(normalized)) {
    await sendText(remoteJid, getWelcome());
    return;
  }

  // ========================================
  // REQUEST FOR HUMAN SUPPORT
  // ========================================

  if (
    /\b(human|agent|staff|representative|customer care|support person)\b/i
      .test(normalized)
  ) {
    await sendText(
      remoteJid,
      `Thank you for reaching *${STORE_NAME}*. Your request for assistance from our team has been received. Please leave your name and a convenient contact time.`
    );

    return;
  }

  // ========================================
  // DEFAULT RESPONSE
  // ========================================

  await sendText(
    remoteJid,
    `Thank you for contacting *${STORE_NAME}*. 😊

Please tell us the phone brand/model and the assistance you need. For product availability, prices or replacement-part enquiries, our Lumi integration notice will be shared while setup is being completed.`
  );
}

// ==========================================
// WHATSAPP STATUS
// ==========================================

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,
    storeName: STORE_NAME,
    textOnlyMode: TEXT_ONLY_MODE,
    afooProductNoticeMode: AFOO_PRODUCT_NOTICE_MODE,
    qrAvailable: Boolean(currentQR),
    pairingCode,
    pairingRequested: Boolean(pendingPairingNumber),
    authFolder: AUTH_FOLDER
  };
}

export function getCurrentQR() {
  return currentQR;
}

// ==========================================
// REQUEST PAIRING CODE
// ==========================================

export async function requestPairing(phoneNumber) {
  const number = normalizePhone(phoneNumber);

  if (number.length < 10 || number.length > 15) {
    throw new Error(
      "Enter a valid phone number with country code."
    );
  }

  if (!sock) {
    throw new Error(
      "WhatsApp socket is not initialised. Start the bot first."
    );
  }

  if (isConnected()) {
    throw new Error("WhatsApp is already connected.");
  }

  if (pendingPairingNumber) {
    throw new Error("A pairing request is already pending.");
  }

  pendingPairingNumber = number;

  pairingCode = await sock.requestPairingCode(number);

  return {
    success: true,
    pairingCode,
    message:
      "Enter this pairing code on the WhatsApp account you want to connect."
  };
}

// ==========================================
// SEND WHATSAPP OTP
// ==========================================

export async function sendWhatsAppOTP(
  phone,
  otp,
  name = "Customer"
) {
  const message =
    `Hello ${name},

Your *${STORE_NAME}* verification code is: *${otp}*.

Do not share this code with anyone.`;

  return sendText(toJid(phone), message);
}

// ==========================================
// SEND WHATSAPP NOTIFICATION
// ==========================================

export async function sendWhatsAppNotification(
  phone,
  message,
  pdfBuffer = null,
  fileName = "receipt.pdf"
) {
  const jid = toJid(phone);

  await sendText(jid, message);

  // Text-only mode intentionally suppresses outgoing files.
  if (pdfBuffer && !TEXT_ONLY_MODE) {
    await sock.sendMessage(jid, {
      document: Buffer.from(pdfBuffer),
      mimetype: "application/pdf",
      fileName
    });
  }

  return {
    success: true
  };
}

// ==========================================
// START WHATSAPP BOT
// ==========================================

export async function startWhatsApp() {
  if (starting || isConnected()) {
    return;
  }

  starting = true;
  manualClose = false;

  try {
    fs.mkdirSync(AUTH_FOLDER, {
      recursive: true
    });

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_FOLDER);

    sock = makeWASocket({
      auth: state,
      logger,

      printQRInTerminal: false,

      browser: [
        STORE_NAME,
        "Chrome",
        "1.0.0"
      ],

      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    // ======================================
    // CONNECTION UPDATE
    // ======================================

    sock.ev.on(
      "connection.update",
      async (update) => {
        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        if (qr) {
          currentQR = await QRCode.toDataURL(qr);

          pairingCode = null;

          console.log(
            "WhatsApp QR code generated. Open the admin dashboard to scan it."
          );
        }

        if (connection === "open") {
          connectionStatus = "connected";

          currentQR = null;
          pairingCode = null;
          pendingPairingNumber = null;

          starting = false;

          console.log(
            `${STORE_NAME} WhatsApp bot connected.`
          );
        }

        if (connection === "close") {
          connectionStatus = "disconnected";

          starting = false;
          sock = null;

          const statusCode =
            new Boom(lastDisconnect?.error)?.output?.statusCode;

          const shouldReconnect =
            !manualClose &&
            statusCode !== DisconnectReason.loggedOut;

          if (shouldReconnect && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              startWhatsApp();
            }, 5000);
          } else if (
            statusCode === DisconnectReason.loggedOut
          ) {
            console.error(
              "WhatsApp session logged out. Remove the auth folder and pair again."
            );
          }
        }

        if (connection === "connecting") {
          connectionStatus = "connecting";
        }
      }
    );

    // ======================================
    // INCOMING WHATSAPP MESSAGES
    // ======================================

    sock.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (type !== "notify") {
          return;
        }

        for (const message of messages || []) {
          try {
            await handleIncomingMessage(message);
          } catch (error) {
            console.error(
              "Incoming message error:",
              error.message
            );
          }
        }
      }
    );

  } catch (error) {
    starting = false;
    connectionStatus = "disconnected";

    console.error(
      "WhatsApp startup failed:",
      error
    );

    if (!reconnectTimer && !manualClose) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp();
      }, 10000);
    }

    throw error;
  }
}