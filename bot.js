
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

const ROBOT_NAME =
  process.env.ROBOT_NAME || "AFOO-X";

const ROBOT_DESCRIPTION =
  `${ROBOT_NAME} is the intelligent virtual customer service assistant of ${STORE_NAME}.`;

const TEXT_ONLY_MODE =
  (process.env.TEXT_ONLY_MODE || "true").toLowerCase() === "true";

const AFOO_PRODUCT_NOTICE_MODE =
  (process.env.AFOO_PRODUCT_NOTICE_MODE || "true").toLowerCase() === "true";

// ==========================================
// ONLINE PRESENCE CONFIGURATION
// ==========================================

const ONLINE_PRESENCE_ENABLED =
  (process.env.ONLINE_PRESENCE_ENABLED || "true").toLowerCase() === "true";

// ==========================================
// HUMAN-LIKE TYPING CONFIGURATION
// ==========================================

const TYPING_INDICATOR_ENABLED =
  (process.env.TYPING_INDICATOR_ENABLED || "true").toLowerCase() === "true";

const TYPING_MIN_DELAY =
  Math.max(0, Number(process.env.TYPING_MIN_DELAY) || 1000);

const TYPING_MAX_DELAY =
  Math.max(
    TYPING_MIN_DELAY,
    Number(process.env.TYPING_MAX_DELAY) || 4500
  );

const TYPING_CHARS_PER_SECOND =
  Math.max(1, Number(process.env.TYPING_CHARS_PER_SECOND) || 35);

// ==========================================
// LUMI INTEGRATION NOTICE
// ==========================================

const AFOO_LUMI_NOTICE =
  process.env.AFOO_LUMI_NOTICE ||
  `Thank you for contacting *${STORE_NAME}*! 😊

Our API key has already been connected to the Lumi platform. However, the integration is still being finalised and is expected to be fully established within at least *two working days*.

We appreciate your patience. Our team will be glad to assist you with your phone accessories and replacement-parts enquiries once the integration is complete. 🙏

🤖 *${ROBOT_NAME}*
_${ROBOT_DESCRIPTION}_`;

// ==========================================
// AUTHENTICATION AND LOGGING
// ==========================================

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

// QR images intentionally disabled.

let currentQR = null;
let qrUpdatedAt = null;
let qrGenerationError = null;

// Prevent duplicate message processing.
const handledMessages = new Set();

// Lightweight conversational context.
// This is held in memory and resets when the bot restarts.
const customerContext = new Map();

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

function rememberCustomer(remoteJid, details = {}) {
  const previous = customerContext.get(remoteJid) || {};

  customerContext.set(remoteJid, {
    ...previous,
    ...details,
    lastSeen: Date.now()
  });

  // Prevent unlimited memory growth.
  if (customerContext.size > 3000) {
    const oldestKey = customerContext.keys().next().value;

    if (oldestKey) {
      customerContext.delete(oldestKey);
    }
  }
}

function getCustomerContext(remoteJid) {
  return customerContext.get(remoteJid) || {};
}

// ==========================================
// HUMAN-LIKE TYPING DELAY
// ==========================================

function getTypingDelay(message) {
  const text = String(message || "");

  const calculatedDelay =
    (text.length / TYPING_CHARS_PER_SECOND) * 1000;

  const baseDelay = Math.max(
    TYPING_MIN_DELAY,
    Math.min(calculatedDelay, TYPING_MAX_DELAY)
  );

  const variation = Math.floor(
    Math.random() * 500
  );

  return Math.min(
    baseDelay + variation,
    TYPING_MAX_DELAY
  );
}

// ==========================================
// SEND WHATSAPP TEXT WITH TYPING INDICATOR
// ==========================================

async function sendText(jid, message) {
  if (!isConnected()) {
    throw new Error("WhatsApp is not connected.");
  }

  const text = String(message || "");

  if (!text.trim()) {
    throw new Error("Cannot send an empty WhatsApp message.");
  }

  const activeSocket = sock;

  let typingStarted = false;

  try {
    // SHOW TYPING INDICATOR

    if (TYPING_INDICATOR_ENABLED) {
      try {
        await activeSocket.sendPresenceUpdate(
          "composing",
          jid
        );

        typingStarted = true;

        console.log(
          `${ROBOT_NAME} is typing a response...`
        );

        await sleep(getTypingDelay(text));

      } catch (presenceError) {
        console.error(
          "TYPING INDICATOR ERROR:",
          presenceError.message
        );
      }
    }

    // VERIFY CONNECTION

    if (
      sock !== activeSocket ||
      !isConnected()
    ) {
      throw new Error(
        "WhatsApp disconnected while preparing the message."
      );
    }

    // SEND MESSAGE

    const result = await activeSocket.sendMessage(
      jid,
      { text }
    );

    console.log(
      `${ROBOT_NAME} sent a message successfully.`
    );

    return result;

  } finally {
    // STOP TYPING INDICATOR

    if (
      TYPING_INDICATOR_ENABLED &&
      typingStarted
    ) {
      try {
        await activeSocket.sendPresenceUpdate(
          "paused",
          jid
        );

      } catch (presenceError) {
        console.error(
          "TYPING INDICATOR STOP ERROR:",
          presenceError.message
        );
      }
    }
  }
}

// ==========================================
// MESSAGE NORMALIZATION
// ==========================================

function normalizeMessage(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:]+$/g, "")
    .replace(/\s+/g, " ");
}

// ==========================================
// GREETING DETECTION
// ==========================================

function isGreeting(text) {
  const message = normalizeMessage(text);

  const greetings = [
    /^hi$/,
    /^hii+$/,
    /^hello$/,
    /^helloo+$/,
    /^hey$/,
    /^heyy+$/,
    /^heyyy+$/,
    /^heya$/,
    /^hiya$/,
    /^yo$/,
    /^sup$/,
    /^wassup$/,
    /^what'?s up$/,
    /^howdy$/,
    /^good morning$/,
    /^good afternoon$/,
    /^good evening$/,
    /^good day$/,
    /^morning$/,
    /^afternoon$/,
    /^evening$/,
    /^greetings$/,
    /^hello there$/,
    /^hi there$/,
    /^hey there$/,
    /^hello friend$/,
    /^hi friend$/,
    /^hey friend$/,
    /^how are you$/,
    /^how are you doing$/,
    /^how have you been$/,
    /^how is it going$/,
    /^how'?s everything$/,
    /^how is business$/,
    /^are you there$/,
    /^anyone there$/,
    /^can you hear me$/,
    /^i am here$/,
    /^nice to meet you$/,
    /^pleased to meet you$/,
    /^good to see you$/,
    /^welcome$/,
    /^peace$/,
    /^start$/,
    /^start chat$/,
    /^begin$/,
    /^let'?s start$/,
    /^hello afoo$/,
    /^hi afoo$/,
    /^hey afoo$/,
    /^hello afoox$/,
    /^hi afoox$/,
    /^hey afoox$/,
    /^hello afoo-x$/,
    /^hi afoo-x$/,
    /^hey afoo-x$/
  ];

  return greetings.some(pattern => pattern.test(message));
}

// ==========================================
// MENU DETECTION
// ==========================================

function isMenuRequest(text) {
  const message = normalizeMessage(text);

  return /\b(menu|main menu|show menu|show options|what can you do|your services|list of services|available services|help me|options)\b/i
    .test(message);
}

// ==========================================
// MENU NUMBER DETECTION
// ==========================================

function getMenuSelection(text) {
  const message = normalizeMessage(text);

  const match = message.match(/^(?:option\s*)?([1-6])$/);

  return match ? Number(match[1]) : null;
}

// ==========================================
// IDENTITY DETECTION
// ==========================================

function isIdentityQuestion(text) {
  return /\b(who are you|what are you|your name|who am i chatting with|who am i speaking with|are you a robot|are you human|are you an ai|are you automated)\b/i
    .test(String(text || ""));
}

// ==========================================
// PRODUCT ENQUIRY DETECTION
// ==========================================

function isProductEnquiry(text) {
  return /\b(product|price|prices|cost|available|availability|stock|buy|purchase|order|screen|display|lcd|touch|mouthpiece|charging port|charging flex|battery|phone case|case|charger|accessor(?:y|ies)|replacement|spare part|phone part|samsung|iphone|tecno|infinix|itel|xiaomi|redmi|oppo|vivo|nokia)\b/i
    .test(String(text || ""));
}

// ==========================================
// CUSTOMER SUPPORT DETECTION
// ==========================================

function isHumanSupportRequest(text) {
  return /\b(human|agent|staff|representative|customer care|support person|speak to someone|talk to someone|real person|speak with a person|customer service|human support)\b/i
    .test(String(text || ""));
}

// ==========================================
// THANK YOU DETECTION
// ==========================================

function isThankYou(text) {
  return /\b(thank you|thanks|thank u|thx|i appreciate|much appreciated|thanks a lot)\b/i
    .test(String(text || ""));
}

// ==========================================
// GOODBYE DETECTION
// ==========================================

function isGoodbye(text) {
  return /\b(bye|goodbye|see you|talk to you later|i am leaving|have a nice day|good night)\b/i
    .test(String(text || ""));
}

// ==========================================
// DELIVERY DETECTION
// ==========================================

function isDeliveryQuestion(text) {
  return /\b(delivery|deliver|shipping|dispatch|dispatching|courier|waybill|send to me|transport|how long.*arrive|when.*arrive)\b/i
    .test(String(text || ""));
}

// ==========================================
// PAYMENT DETECTION
// ==========================================

function isPaymentQuestion(text) {
  return /\b(payment|pay|transfer|bank transfer|account number|pos|deposit|payment method|how can i pay|where can i pay)\b/i
    .test(String(text || ""));
}

// ==========================================
// LOCATION DETECTION
// ==========================================

function isLocationQuestion(text) {
  return /\b(address|location|where are you|where is your shop|shop address|office address|physical address|directions|how do i locate you)\b/i
    .test(String(text || ""));
}

// ==========================================
// ORDER STATUS DETECTION
// ==========================================

function isOrderStatusQuestion(text) {
  return /\b(order status|track my order|tracking|my order|order number|has my order|where is my order|order confirmation)\b/i
    .test(String(text || ""));
}

// ==========================================
// COMPLAINT DETECTION
// ==========================================

function isComplaint(text) {
  return /\b(complain|complaint|not working|does not work|faulty|damaged|wrong item|refund|return|bad service|problem with|issue with|disappointed|unsatisfied)\b/i
    .test(String(text || ""));
}

// ==========================================
// PHONE MODEL DETECTION
// ==========================================

function containsPhoneModel(text) {
  return /\b(samsung|iphone|tecno|infinix|itel|xiaomi|redmi|oppo|vivo|nokia|pixel|oneplus|huawei)\b/i
    .test(String(text || ""));
}

// ==========================================
// WELCOME MESSAGE
// ==========================================

function getWelcome() {
  return `👋 Hello and welcome to *${STORE_NAME}*!

🤖 My name is *${ROBOT_NAME}*.

I am your intelligent virtual customer service assistant. I can help you with phone accessories, replacement parts, product enquiries and general customer support.

I'm pleased to assist you today!

━━━━━━━━━━━━━━━━━━

📱 *1. PHONE ACCESSORIES*

• Phone cases and screen protectors
• Chargers and charging cables
• Batteries and other accessories
• Phone protection products

🔧 *2. PHONE REPLACEMENT PARTS*

• LCD screens and displays
• Touchscreens
• Charging ports and charging flexes
• Mouthpieces and earpieces
• Batteries
• Other replacement components

🛒 *3. PRODUCT ENQUIRIES*

• Product availability
• Pricing enquiries
• Orders and purchase assistance
• Phone brand and model enquiries

🚚 *4. DELIVERY ENQUIRIES*

• Delivery arrangements
• Dispatch information
• Shipping questions

💳 *5. PAYMENT ENQUIRIES*

• Payment assistance
• Payment confirmation
• General payment questions

👨‍💻 *6. CUSTOMER SUPPORT*

• General enquiries
• Complaints and assistance
• Technical support requests
• Connecting you with our support team

━━━━━━━━━━━━━━━━━━

💬 *HOW MAY I ASSIST YOU TODAY?*

You can type a menu number or describe what you need.

*Examples:*

_"I need a Samsung A15 screen."_

_"Do you have an iPhone 11 battery?"_

_"I want a Tecno Camon 20 charging port."_

_"How can I make payment?"_

_"I want to speak with customer support."_

You can type *MENU* anytime to see these options again.

━━━━━━━━━━━━━━━━━━

🤖 *${ROBOT_NAME}*
_${ROBOT_DESCRIPTION}_

🏢 *${STORE_NAME}*`;
}

// ==========================================
// IDENTITY RESPONSE
// ==========================================

function getIdentityResponse() {
  return `🤖 Hello! I am *${ROBOT_NAME}*.

I am the intelligent virtual customer service assistant of *${STORE_NAME}*.

I can help you with:

📱 Phone accessories.

🔧 Phone replacement parts.

🛒 Product and purchase enquiries.

🚚 Delivery enquiries.

💳 Payment assistance.

👨‍💻 Customer support requests.

I am an automated assistant designed to make your experience with *${STORE_NAME}* easier and faster.

How may I help you today? 😊

You can type *MENU* to explore my services.`;
}

// ==========================================
// CUSTOMER SUPPORT RESPONSE
// ==========================================

function getSupportResponse() {
  return `Thank you for reaching *${STORE_NAME}*! 😊

Your request to speak with a member of our customer support team has been received.

To help our team assist you faster, please provide:

1. Your full name.
2. Your phone number, if different from this WhatsApp number.
3. The phone brand and model, if applicable.
4. A brief description of what you need.

Our team will be glad to assist you.

🤖 *${ROBOT_NAME}*`;
}

// ==========================================
// MENU SELECTION RESPONSE
// ==========================================

function getMenuSelectionResponse(selection) {
  switch (selection) {
    case 1:
      return `📱 *PHONE ACCESSORIES*

I can help you with enquiries about:

• Phone cases
• Screen protectors
• Chargers and cables
• Batteries
• Other phone accessories

Please tell me your phone brand and model, together with the accessory you need.

💡 *Suggestion:* For example, "I need a screen protector for Samsung A15."`;

    case 2:
      return `🔧 *PHONE REPLACEMENT PARTS*

We handle enquiries about:

• LCD screens and displays
• Touchscreens
• Charging ports
• Charging flexes
• Batteries
• Earpieces and mouthpieces

Please provide your phone brand, exact model and the replacement part you need.

💡 *Suggestion:* "I need an iPhone 11 charging port."`;

    case 3:
      return `🛒 *PRODUCT ENQUIRIES*

Please tell me:

1. Your phone brand.
2. Your exact phone model.
3. The product or replacement part you need.

Our product integration is currently being finalised through Lumi. I can provide the relevant service notice and help direct your enquiry.

💡 *Suggestion:* Send the exact phone model so your enquiry is clearer.`;

    case 4:
      return `🚚 *DELIVERY ENQUIRIES*

I can help you direct your delivery enquiry.

Please provide:

1. Your location or delivery destination.
2. The item you want to purchase.
3. Whether you have already placed an order.

Our team can assist with delivery arrangements and confirmation.

💡 *Suggestion:* Include your town or state when asking about delivery.`;

    case 5:
      return `💳 *PAYMENT ENQUIRIES*

For payment assistance, please tell me:

1. Whether you are making a new purchase.
2. Whether you have already made a payment.
3. Whether you need payment confirmation or assistance.

For security, do not send your bank PIN, card PIN or password here.

Our support team can help with verified payment instructions.`;

    case 6:
      return getSupportResponse();

    default:
      return getWelcome();
  }
}

// ==========================================
// SMART RESPONSE HELPERS
// ==========================================

function getThankYouResponse() {
  return `You're very welcome! 😊

Thank you for choosing *${STORE_NAME}*.

I'm always happy to assist you.

Would you like help with anything else?

💡 You can ask me about:
• Phone accessories
• Replacement parts
• Delivery enquiries
• Payment assistance
• Customer support

Type *MENU* to explore more options.

🤖 *${ROBOT_NAME}*`;
}

function getGoodbyeResponse() {
  return `Thank you for contacting *${STORE_NAME}*! 😊

It was a pleasure assisting you.

Whenever you need phone accessories, replacement parts or customer support, feel free to message us again.

Have a wonderful day!

🤖 *${ROBOT_NAME}*`;
}

function getDeliveryResponse() {
  return `🚚 *DELIVERY ASSISTANCE*

Thank you for your delivery enquiry.

To help direct your request, please provide:

1. Your town or city.
2. Your state.
3. The product you are interested in.
4. Whether you have already placed an order.

Our team will assist you with the available delivery arrangements.

💡 *Helpful suggestion:* Include your delivery destination so the team can respond more accurately.

🤖 *${ROBOT_NAME}*`;
}

function getPaymentResponse() {
  return `💳 *PAYMENT ASSISTANCE*

Thank you for your payment enquiry.

Please let me know which assistance you need:

1. Payment instructions for a new order.
2. Payment confirmation.
3. Assistance with a failed transfer.
4. Help with an existing transaction.

Please do not share your PIN, password or full card details.

Our team can help verify payment-related enquiries.

🤖 *${ROBOT_NAME}*`;
}

function getLocationResponse() {
  return `📍 *LOCATION ENQUIRY*

Thank you for your interest in *${STORE_NAME}*.

Please tell me your current town or state so I can help direct your enquiry to our team.

I don't want to give you an unverified address or directions.

💡 *Suggestion:* You can also tell me whether you need our shop location or delivery information.

🤖 *${ROBOT_NAME}*`;
}

function getOrderStatusResponse() {
  return `🛒 *ORDER STATUS ASSISTANCE*

I can help direct your order enquiry.

Please provide:

1. Your order number, if available.
2. The name used when placing the order.
3. The date you placed the order.
4. A short description of the item.

Please avoid sending sensitive banking information.

Our customer support team can assist with checking your order.

🤖 *${ROBOT_NAME}*`;
}

function getComplaintResponse() {
  return `🙏 *CUSTOMER COMPLAINTS AND ASSISTANCE*

We are sorry to hear that you are experiencing a problem.

At *${STORE_NAME}*, we value your feedback and want to help resolve your concern.

Please provide:

1. Your full name.
2. Your order number, if available.
3. The product or service involved.
4. A clear description of the problem.
5. When the issue occurred.

Our customer support team can review your complaint and assist you.

Thank you for giving us the opportunity to help.

🤖 *${ROBOT_NAME}*`;
}

// ==========================================
// SMART DEFAULT RESPONSE
// ==========================================

function getSmartDefaultResponse(text, remoteJid) {
  const previous = getCustomerContext(remoteJid);

  if (
    /^(yes|yeah|yep|sure|okay|ok|please|continue|go ahead)$/i
      .test(normalizeMessage(text)) &&
    previous.lastTopic === "support"
  ) {
    return `Thank you. 😊

Please describe the issue you need help with, and include your phone model or order number if applicable.

🤖 *${ROBOT_NAME}*`;
  }

  if (
    /^(more|tell me more|explain more|details|more details)$/i
      .test(normalizeMessage(text))
  ) {
    return `Of course! 😊

I can help you explore the following services:

📱 Phone accessories.

🔧 Phone replacement parts.

🛒 Product enquiries.

🚚 Delivery enquiries.

💳 Payment assistance.

👨‍💻 Customer support.

Please tell me which one you would like to know more about.

You can also type *MENU* to see all options.

🤖 *${ROBOT_NAME}*`;
  }

  if (containsPhoneModel(text)) {
    return `Thank you for sharing your phone details. 😊

I can help direct your enquiry.

Please tell me the exact product or replacement part you need.

For example:

• LCD screen
• Battery
• Charging port
• Touchscreen
• Phone case
• Charger

💡 *Suggestion:* Include the complete phone model to help avoid confusion.

🤖 *${ROBOT_NAME}*`;
  }

  return `Thank you for contacting *${STORE_NAME}*! 😊

I am *${ROBOT_NAME}*, your virtual customer service assistant.

I would be happy to help you.

You can ask me about:

📱 Phone accessories.

🔧 Replacement parts.

🛒 Product enquiries.

🚚 Delivery assistance.

💳 Payment enquiries.

👨‍💻 Customer support.

💡 *To help me understand you better:*

Please describe what you need, including your phone brand and model if your enquiry concerns a phone.

*Examples:*

_"I need a Samsung A15 screen."_

_"How do I make payment?"_

_"Can you deliver to Lagos?"_

_"I want to speak with customer support."_

You can type *MENU* to see all available services.

🤖 *${ROBOT_NAME}*
_${ROBOT_DESCRIPTION}_`;
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
        `Thank you for contacting *${STORE_NAME}*. 😊

I am *${ROBOT_NAME}*, your virtual assistant.

We currently handle enquiries through text messages only.

Please type your enquiry here so I can assist you.

💡 You can type *MENU* to explore our services.`
      );
    }

    return;
  }

  console.log(
    `Message received from ${remoteJid}: ${normalized}`
  );

  rememberCustomer(remoteJid, {
    lastMessage: normalized
  });

  // ========================================
  // LUMI PRODUCT NOTICE
  // ========================================

  // Preserve the original product notice priority.

  if (
    AFOO_PRODUCT_NOTICE_MODE &&
    isProductEnquiry(normalized)
  ) {
    rememberCustomer(remoteJid, {
      lastTopic: "product"
    });

    await sendText(
      remoteJid,
      AFOO_LUMI_NOTICE
    );

    return;
  }

  // ========================================
  // GREETINGS
  // ========================================

  if (isGreeting(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "greeting"
    });

    await sendText(
      remoteJid,
      getWelcome()
    );

    return;
  }

  // ========================================
  // MENU REQUEST
  // ========================================

  if (isMenuRequest(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "menu"
    });

    await sendText(
      remoteJid,
      getWelcome()
    );

    return;
  }

  // ========================================
  // MENU NUMBER SELECTION
  // ========================================

  const selection = getMenuSelection(normalized);

  if (selection !== null) {
    const topics = {
      1: "accessories",
      2: "replacement-parts",
      3: "product",
      4: "delivery",
      5: "payment",
      6: "support"
    };

    rememberCustomer(remoteJid, {
      lastTopic: topics[selection]
    });

    await sendText(
      remoteJid,
      getMenuSelectionResponse(selection)
    );

    return;
  }

  // ========================================
  // ROBOT IDENTITY
  // ========================================

  if (isIdentityQuestion(normalized)) {
    await sendText(
      remoteJid,
      getIdentityResponse()
    );

    return;
  }

  // ========================================
  // HUMAN SUPPORT
  // ========================================

  if (isHumanSupportRequest(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "support"
    });

    await sendText(
      remoteJid,
      getSupportResponse()
    );

    return;
  }

  // ========================================
  // COMPLAINTS
  // ========================================

  if (isComplaint(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "complaint"
    });

    await sendText(
      remoteJid,
      getComplaintResponse()
    );

    return;
  }

  // ========================================
  // ORDER STATUS
  // ========================================

  if (isOrderStatusQuestion(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "order"
    });

    await sendText(
      remoteJid,
      getOrderStatusResponse()
    );

    return;
  }

  // ========================================
  // DELIVERY
  // ========================================

  if (isDeliveryQuestion(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "delivery"
    });

    await sendText(
      remoteJid,
      getDeliveryResponse()
    );

    return;
  }

  // ========================================
  // PAYMENT
  // ========================================

  if (isPaymentQuestion(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "payment"
    });

    await sendText(
      remoteJid,
      getPaymentResponse()
    );

    return;
  }

  // ========================================
  // LOCATION
  // ========================================

  if (isLocationQuestion(normalized)) {
    rememberCustomer(remoteJid, {
      lastTopic: "location"
    });

    await sendText(
      remoteJid,
      getLocationResponse()
    );

    return;
  }

  // ========================================
  // THANK YOU
  // ========================================

  if (isThankYou(normalized)) {
    await sendText(
      remoteJid,
      getThankYouResponse()
    );

    return;
  }

  // ========================================
  // GOODBYE
  // ========================================

  if (isGoodbye(normalized)) {
    await sendText(
      remoteJid,
      getGoodbyeResponse()
    );

    return;
  }

  // ========================================
  // SMART DEFAULT RESPONSE
  // ========================================

  await sendText(
    remoteJid,
    getSmartDefaultResponse(
      normalized,
      remoteJid
    )
  );
}

// ==========================================
// WHATSAPP STATUS
// ==========================================

export function getWhatsAppStatus() {
  return {
    status: connectionStatus,

    storeName: STORE_NAME,

    robotName: ROBOT_NAME,

    robotDescription: ROBOT_DESCRIPTION,

    textOnlyMode: TEXT_ONLY_MODE,

    afooProductNoticeMode: AFOO_PRODUCT_NOTICE_MODE,

    typingIndicatorEnabled: TYPING_INDICATOR_ENABLED,

    typingMinDelay: TYPING_MIN_DELAY,

    typingMaxDelay: TYPING_MAX_DELAY,

    onlinePresenceEnabled: ONLINE_PRESENCE_ENABLED,

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

  pairingRequested = true;

  try {
    const activeSocket = sock;

    const number = pendingPairingNumber;

    console.log("----------------------------------");
    console.log("AFOO TECHNOLOGY WHATSAPP PAIRING");
    console.log("----------------------------------");
    console.log("Requesting WhatsApp pairing code.");
    console.log("Phone:", number);

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

    const code =
      await activeSocket.requestPairingCode(number);

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

Do not share this code with anyone.

🤖 *${ROBOT_NAME}*`;

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
    // AUTHENTICATION FOLDER

    fs.mkdirSync(AUTH_FOLDER, {
      recursive: true
    });

    // LOAD AUTHENTICATION

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

    // CREATE WHATSAPP SOCKET
    // Keep this configuration compatible with
    // the working Baileys 6.7.24 pairing setup.

    const newSocket = makeWASocket({
      auth: state,

      logger,

      printQRInTerminal: false,

      markOnlineOnConnect: ONLINE_PRESENCE_ENABLED,

      syncFullHistory: false,

      connectTimeoutMs: 60000,

      defaultQueryTimeoutMs: 60000,

      keepAliveIntervalMs: 15000
    });

    sock = newSocket;

    console.log(
      `${ROBOT_NAME} socket created. Waiting for WhatsApp connection updates...`
    );

    // SAVE AUTHENTICATION CREDENTIALS

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

    // CONNECTION UPDATES

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

        // PAIRING READINESS EVENT

        if (qr) {
          // QR is not displayed or generated.
          // This event only signals pairing readiness.

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

        // CONNECTING

        if (connection === "connecting") {
          connectionStatus = "connecting";

          console.log(
            `${ROBOT_NAME} is connecting. Waiting for pairing readiness.`
          );
        }

        // CONNECTED

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
            `${ROBOT_NAME} is now online and ready to assist customers.`
          );

          console.log(
            "WhatsApp account:",
            newSocket.user?.id || "Connected"
          );

          // EXPLICIT ONLINE PRESENCE

          if (ONLINE_PRESENCE_ENABLED) {
            try {
              await newSocket.sendPresenceUpdate("available");

              console.log(
                `${ROBOT_NAME} online presence announced successfully.`
              );

            } catch (presenceError) {
              console.error(
                "ONLINE PRESENCE ERROR:",
                presenceError.message
              );
            }
          }
        }

        // DISCONNECTED

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

          // Preserve the pending number for a retry.

          if (pendingPairingNumber) {
            pairingRequested = false;
          }

          if (
            !manualClose &&
            !reconnectTimer
          ) {
            console.log(
              `${ROBOT_NAME} reconnecting in 5 seconds...`
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

    // INCOMING MESSAGES

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

  // Announce unavailable before shutting down.

  if (activeSocket && activeSocket.user) {
    try {
      await activeSocket.sendPresenceUpdate("unavailable");

    } catch (presenceError) {
      console.error(
        "OFFLINE PRESENCE ERROR:",
        presenceError.message
      );
    }
  }

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
    `${ROBOT_NAME} - ${STORE_NAME} WhatsApp bot stopped.`
  );

  return {
    success: true,

    status: connectionStatus
  };
}
