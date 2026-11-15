
import "dotenv/config";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState
} from "@whiskeysockets/baileys";

import { Boom } from "@hapi/boom";
import P from "pino";
import fs from "fs";
import path from "path";

// ==========================================
// CONFIGURATION
// ==========================================

const STORE_NAME =
  process.env.STORE_NAME || "Afoo Technology";

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
  process.env.AUTH_FOLDER ||
  path.join(process.cwd(), "auth_info_afoo");

const LOG_LEVEL =
  process.env.LOG_LEVEL || "info";

const logger = P({
  level: LOG_LEVEL
});

// ==========================================
// GLOBAL STATE
// ==========================================

let sock = null;
let authState = null;

let pairingCode = null;
let pendingPairingNumber = null;

let qrEventReady = false;
let pairingRequested = false;

let connectionStatus = "disconnected";
let sessionRegistered = false;

let starting = false;
let manualClose = false;

let reconnectTimer = null;

// Compatibility with existing Afoo admin API.
// QR images are intentionally disabled.
let currentQR = null;
let qrUpdatedAt = null;
let qrGenerationError = null;

const handledMessages = new Set();

// ==========================================
// GENERAL HELPERS
// ==========================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function toJid(phone) {
  return `${normalizePhone(phone)}@s.whatsapp.net`;
}

function isValidPhone(phone) {
  const number = normalizePhone(phone);

  return number.length >= 10 && number.length <= 15;
}

function getDisconnectStatus(error) {
  if (!error) return null;

  if (error instanceof Boom) {
    return error.output?.statusCode || null;
  }

  return error?.output?.statusCode || null;
}

function isConnected() {
  return Boolean(sock?.user) &&
    connectionStatus === "connected";
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
// MESSAGE HELPERS
// ==========================================

function isGreeting(text) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening|greetings|menu|start)\b/i
    .test(String(text || "").trim());
}

function isProductEnquiry(text) {
  return /\b(product|price|cost|available|availability|stock|buy|purchase|order|screen|display|lcd|touch|mouthpiece|charging port|charging flex|battery|phone case|case|charger|accessor(?:y|ies)|replacement|spare part|phone part|samsung|iphone|tecno|infinix|itel|xiaomi|redmi|oppo|vivo|nokia)\b/i
    .test(String(text || ""));
}

function getWelcome() {
  return `Welcome to *${STORE_NAME}*! 👋

We deal in phone accessories and replacement parts, including screens, mouthpieces, charging ports and other phone components.

Please tell us what you need and include your phone brand and model where possible.`;
}

// ==========================================
// INCOMING WHATSAPP MESSAGES
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

  // Ignore group messages.
  if (remoteJid.endsWith("@g.us")) {
    return;
  }

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

  if (!normalized) {
    if (TEXT_ONLY_MODE) {
      await sendText(
        remoteJid,
        `Thank you for contacting *${STORE_NAME}*. We currently handle enquiries through text messages only. Please type your enquiry here.`
      );
    }

    return;
  }

  console.log(
    `Message received from ${remoteJid}: ${normalized}`
  );

  // ----------------------------------------
  // LUMI PRODUCT NOTICE
  // ----------------------------------------

  if (
    AFOO_PRODUCT_NOTICE_MODE &&
    isProductEnquiry(normalized)
  ) {
    await sendText(remoteJid, AFOO_LUMI_NOTICE);
    return;
  }

  // ----------------------------------------
  // GREETINGS
  // ----------------------------------------

  if (isGreeting(normalized)) {
    await sendText(remoteJid, getWelcome());
    return;
  }

  // ----------------------------------------
  // HUMAN SUPPORT REQUEST
  // ----------------------------------------

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

  // ----------------------------------------
  // DEFAULT RESPONSE
  // ----------------------------------------

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

    // Phone-number pairing only.
    qrAvailable: false,
    qrUpdatedAt: null,
    qrGenerationError: null,

    pairingCode,
    pairingRequested,

    pairingInProgress: Boolean(
      pendingPairingNumber && pairingRequested
    ),

    pendingPairingNumber: pendingPairingNumber
      ? `${pendingPairingNumber.slice(0, 3)}******`
      : null,

    qrEventReady,

    socketReady: Boolean(sock),
    sessionRegistered,

    authFolder: AUTH_FOLDER
  };
}

export function getCurrentQR() {
  return null;
}

// ==========================================
// ISSUE PHONE-NUMBER PAIRING CODE
// ==========================================

async function issuePairingCode() {
  if (
    !sock ||
    !authState ||
    !pendingPairingNumber ||
    pairingRequested ||
    connectionStatus === "connected"
  ) {
    return null;
  }

  if (authState.creds.registered) {
    console.error(
      "Cannot request a pairing code: an existing session is registered."
    );

    connectionStatus = "logged_out";
    sessionRegistered = true;

    return null;
  }

  if (!qrEventReady) {
    console.log(
      "Waiting for WhatsApp pairing event."
    );

    return null;
  }

  // Prevent duplicate requests.
  pairingRequested = true;

  try {
    const activeSocket = sock;
    const number = pendingPairingNumber;

    console.log("----------------------------------");
    console.log("AFOO TECHNOLOGY WHATSAPP PAIRING");
    console.log("----------------------------------");
    console.log("Requesting WhatsApp pairing code.");
    console.log("Phone:", number);

    // Follow Divine's working pairing delay.
    await sleep(1500);

    if (
      !sock ||
      sock !== activeSocket ||
      !authState ||
      authState.creds.registered ||
      connectionStatus === "connected"
    ) {
      throw new Error(
        "WhatsApp socket is not ready for a new pairing request."
      );
    }

    const code = await activeSocket.requestPairingCode(number);

    if (!code || !String(code).trim()) {
      throw new Error(
        "Baileys did not return a valid pairing code."
      );
    }

    pairingCode = code;

    currentQR = null;
    qrUpdatedAt = null;
    qrGenerationError = null;

    connectionStatus = "pairing_code_ready";

    console.log("----------------------------------");
    console.log("PAIRING CODE GENERATED SUCCESSFULLY");
    console.log("----------------------------------");
    console.log("Pairing code:", code);
    console.log("Phone:", number);
    console.log("----------------------------------");

    return code;

  } catch (error) {
    pairingRequested = false;
    pairingCode = null;

    console.error(
      "PAIRING CODE REQUEST FAILED:",
      error?.output?.payload ||
      error.message ||
      error
    );

    return null;
  }
}

// ==========================================
// REQUEST WHATSAPP PAIRING
// ==========================================

export async function requestPairing(phoneNumber) {
  const number = normalizePhone(phoneNumber);

  if (!isValidPhone(number)) {
    throw new Error(
      "Enter a valid phone number with country code, digits only."
    );
  }

  if (!sock) {
    throw new Error(
      "WhatsApp socket is not initialized. Restart the bot and try again."
    );
  }

  if (connectionStatus === "connected") {
    throw new Error(
      "WhatsApp is already connected."
    );
  }

  if (authState?.creds?.registered || sessionRegistered) {
    throw new Error(
      "The saved WhatsApp session is already registered. Back up and reset the active authentication folder before pairing again."
    );
  }

  if (pendingPairingNumber && pairingRequested) {
    throw new Error(
      "A pairing-code request is already in progress. Please wait."
    );
  }

  pendingPairingNumber = number;

  pairingCode = null;
  pairingRequested = false;

  currentQR = null;
  qrUpdatedAt = null;
  qrGenerationError = null;

  console.log("----------------------------------");
  console.log("AFOO TECHNOLOGY PAIRING REQUEST");
  console.log("----------------------------------");
  console.log("Phone:", number);

  if (qrEventReady) {
    await issuePairingCode();
  }

  return {
    success: true,

    pairingCode: pairingCode || null,

    phoneNumber: number,

    message: pairingCode
      ? "Pairing code generated. Open WhatsApp, select Linked Devices, choose Link with phone number instead, and enter the code."
      : "Phone number saved. Waiting for WhatsApp connection event. Check the admin dashboard shortly."
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
  const message = `Hello ${name},

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

  let receiptSent = false;

  if (pdfBuffer && !TEXT_ONLY_MODE) {
    if (!isConnected()) {
      throw new Error(
        "WhatsApp disconnected before the receipt could be sent."
      );
    }

    await sock.sendMessage(jid, {
      document: Buffer.from(pdfBuffer),
      mimetype: "application/pdf",
      fileName
    });

    receiptSent = true;
  }

  return {
    success: true,
    receiptSent
  };
}

// ==========================================
// START WHATSAPP
// ==========================================

export async function startWhatsApp() {
  if (starting || isConnected()) {
    console.log(
      "WhatsApp startup skipped: already starting or connected."
    );

    return;
  }

  starting = true;
  manualClose = false;

  qrEventReady = false;

  connectionStatus = "connecting";

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    // --------------------------------------
    // AUTHENTICATION FOLDER
    // --------------------------------------

    fs.mkdirSync(AUTH_FOLDER, {
      recursive: true
    });

    // --------------------------------------
    // LOAD AUTHENTICATION
    // --------------------------------------

    const {
      state,
      saveCreds
    } = await useMultiFileAuthState(AUTH_FOLDER);

    authState = state;

    sessionRegistered = Boolean(
      authState.creds.registered
    );

    if (sessionRegistered) {
      console.log(
        "Existing WhatsApp authentication found. Attempting to reconnect."
      );
    } else {
      console.log(
        "No registered WhatsApp session found. Phone-number pairing is available."
      );
    }

    // --------------------------------------
    // CREATE WHATSAPP SOCKET
    // Divine Solar Hub configuration
    // --------------------------------------

    const newSocket = makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      markOnlineOnConnect: false,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 15000
    });

    sock = newSocket;

    console.log(
      "WhatsApp socket created. Waiting for connection updates..."
    );

    // --------------------------------------
    // SAVE AUTHENTICATION CREDENTIALS
    // --------------------------------------

    newSocket.ev.on(
      "creds.update",
      async () => {
        if (sock !== newSocket) return;

        try {
          await saveCreds();

          sessionRegistered = Boolean(
            authState?.creds?.registered
          );

          console.log(
            "WhatsApp authentication credentials saved."
          );

        } catch (error) {
          console.error(
            "AUTHENTICATION SAVE ERROR:",
            error.message
          );
        }
      }
    );

    // --------------------------------------
    // CONNECTION UPDATES
    // --------------------------------------

    newSocket.ev.on(
      "connection.update",
      async update => {
        if (sock !== newSocket) {
          return;
        }

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        console.log(
          "WHATSAPP CONNECTION UPDATE:",
          {
            connection,
            hasPairingEvent: Boolean(qr),
            qrEventReady,
            pairingCodeAvailable: Boolean(pairingCode)
          }
        );

        // ----------------------------------
        // PAIRING READINESS EVENT
        // ----------------------------------

        if (qr) {
          // This event is used only to know that
          // Baileys is ready for phone-number pairing.
          //
          // No QR image is generated.
          // No QR code is displayed.
          //
          // Phone-number pairing remains the
          // only supported linking method.

          qrEventReady = true;

          console.log(
            "WhatsApp pairing event received. Socket is ready for phone-number pairing."
          );

          if (
            pendingPairingNumber &&
            !authState?.creds?.registered
          ) {
            await issuePairingCode();
          }
        }

        // ----------------------------------
        // CONNECTING
        // ----------------------------------

        if (connection === "connecting") {
          connectionStatus = "connecting";

          console.log(
            "WhatsApp is connecting. Waiting for pairing readiness."
          );
        }

        // ----------------------------------
        // CONNECTED
        // ----------------------------------

        if (connection === "open") {
          starting = false;

          currentQR = null;
          qrUpdatedAt = null;
          qrGenerationError = null;

          pairingCode = null;

          pendingPairingNumber = null;
          pairingRequested = false;

          qrEventReady = false;

          connectionStatus = "connected";

          sessionRegistered = true;

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }

          console.log(
            `${STORE_NAME} WhatsApp connected successfully.`
          );

          console.log(
            "WhatsApp account:",
            newSocket.user?.id || "Connected"
          );
        }

        // ----------------------------------
        // DISCONNECTED
        // ----------------------------------

        if (connection === "close") {
          starting = false;

          const disconnectError =
            lastDisconnect?.error;

          const statusCode =
            getDisconnectStatus(disconnectError);

          const loggedOut =
            statusCode === DisconnectReason.loggedOut;

          currentQR = null;
          qrUpdatedAt = null;
          qrGenerationError = null;

          pairingCode = null;
          qrEventReady = false;

          connectionStatus = loggedOut
            ? "logged_out"
            : "disconnected";

          console.error(
            "WHATSAPP DISCONNECTED:",
            {
              statusCode: statusCode || "unknown",

              reason:
                disconnectError?.message ||
                "No error message",

              details:
                disconnectError?.data ||
                disconnectError?.output?.payload ||
                ""
            }
          );

          if (sock === newSocket) {
            sock = null;
          }

          if (loggedOut) {
            sessionRegistered = false;

            pendingPairingNumber = null;
            pairingRequested = false;

            console.error(
              "WhatsApp session rejected. A new pairing is required."
            );

            console.error(
              "Back up and reset the active authentication folder before attempting a fresh pairing."
            );

            return;
          }

          // Keep the pending number so that a new
          // socket can retry after reconnection.
          if (pendingPairingNumber) {
            pairingRequested = false;
          }

          if (
            !manualClose &&
            !reconnectTimer
          ) {
            console.log(
              "WhatsApp reconnecting in 5 seconds..."
            );

            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;

              startWhatsApp().catch(error => {
                console.error(
                  "WHATSAPP RECONNECT ERROR:",
                  error.message
                );
              });

            }, 5000);
          }
        }
      }
    );

    // --------------------------------------
    // INCOMING MESSAGES
    // --------------------------------------

    newSocket.ev.on(
      "messages.upsert",
      async ({ messages, type }) => {
        if (sock !== newSocket) return;

        if (type !== "notify") return;

        for (const message of messages || []) {
          try {
            await handleIncomingMessage(message);

          } catch (error) {
            console.error(
              "INCOMING MESSAGE ERROR:",
              error.message
            );
          }
        }
      }
    );

  } catch (error) {
    starting = false;

    qrEventReady = false;

    connectionStatus = "disconnected";

    console.error(
      "WHATSAPP STARTUP FAILED:",
      error
    );

    if (
      !reconnectTimer &&
      !manualClose
    ) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;

        startWhatsApp().catch(reconnectError => {
          console.error(
            "WHATSAPP RECONNECT ERROR:",
            reconnectError.message
          );
        });

      }, 10000);
    }

    throw error;
  }
}

// ==========================================
// STOP WHATSAPP
// ==========================================

export async function stopWhatsApp() {
  manualClose = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const activeSocket = sock;

  sock = null;
  authState = null;

  starting = false;

  connectionStatus = "disconnected";

  currentQR = null;
  qrUpdatedAt = null;
  qrGenerationError = null;

  pairingCode = null;
  pendingPairingNumber = null;

  pairingRequested = false;
  qrEventReady = false;

  if (activeSocket) {
    try {
      activeSocket.end(
        new Error("WhatsApp bot stopped manually.")
      );

    } catch (error) {
      console.error(
        "WHATSAPP STOP ERROR:",
        error.message
      );
    }
  }

  console.log(
    `${STORE_NAME} WhatsApp bot stopped.`
  );

  return {
    success: true,
    status: connectionStatus
  };
}
