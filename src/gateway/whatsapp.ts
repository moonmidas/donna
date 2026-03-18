import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestWaWebVersion,
  type WASocket,
  type WAMessage,
  type MessageUpsertType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
// @ts-ignore no types available
import qrcode from "qrcode-terminal";
import { AUTH_DIR, isAllowedWhatsAppJid } from "./config.js";
import { parseWhatsAppConversationId, whatsappConversationId } from "./conversation-id.js";
import {
  buildUnsupportedAttachmentNotice,
  type OutboundMessage,
} from "./messages.js";
import type { IncomingMessage } from "./incoming-message.js";

const log = pino({ name: "whatsapp" });

/** Message IDs sent by the bot — used to avoid processing our own replies */
const sentMessageIds = new Set<string>();

export type MessageHandler = (message: IncomingMessage) => Promise<void>;

export interface WhatsAppConnection {
  sock: WASocket;
  /** Resolves when connection is established and QR is scanned */
  ready: Promise<void>;
  /** Send a text message (tracks ID to avoid processing our own echo) */
  sendMessage: (conversationId: string, payload: OutboundMessage) => Promise<unknown>;
}

async function getWaVersion(): Promise<[number, number, number]> {
  try {
    const { version, isLatest } = await fetchLatestWaWebVersion({});
    log.info({ version, isLatest }, "Fetched WA Web version");
    return version;
  } catch (err) {
    const fallback: [number, number, number] = [2, 3000, 1034074495];
    log.warn({ err, fallback }, "Failed to fetch WA version, using fallback");
    return fallback;
  }
}

export async function connectWhatsApp(
  onMessage: MessageHandler,
): Promise<WhatsAppConnection> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let readyResolve: () => void;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

  let sock: WASocket;
  let reconnecting = false;

  async function createSocket() {
    const version = await getWaVersion();

    sock = makeWASocket({
      auth: state,
      version,
      logger: pino({ level: "silent" }) as any,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        log.info("Scan QR code with WhatsApp (Linked Devices):");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const isLogout = statusCode === DisconnectReason.loggedOut;

        if (isLogout) {
          log.error("Logged out from WhatsApp — delete .gateway/auth/ and re-scan QR");
          process.exit(1);
        }

        if (!reconnecting) {
          reconnecting = true;
          log.warn({ statusCode }, "Connection closed — reconnecting in 3s...");
          setTimeout(async () => {
            reconnecting = false;
            try {
              await createSocket();
            } catch (err) {
              log.error({ err }, "Failed to reconnect");
              reconnecting = false;
              setTimeout(() => createSocket(), 10_000);
            }
          }, 3000);
        }
      }

      if (connection === "open") {
        log.info("WhatsApp connected");
        readyResolve();
      }
    });

    sock.ev.on("messages.upsert", ({ messages, type }: { messages: WAMessage[]; type: MessageUpsertType }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        if (msg.key.remoteJid === "status@broadcast") continue;

        if (msg.key.id && sentMessageIds.has(msg.key.id)) {
          sentMessageIds.delete(msg.key.id);
          continue;
        }

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        if (!isAllowedWhatsAppJid(jid)) {
          log.debug({ jid }, "Message from non-allowlisted JID — ignoring");
          continue;
        }

        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text;

        if (!text) {
          log.debug({ jid }, "Non-text message — ignoring");
          continue;
        }

        log.info({ jid, text: text.slice(0, 80) }, "Incoming message");
        onMessage({ conversationId: whatsappConversationId(jid), text }).catch((err) => {
          log.error({ jid, err }, "Message handler error");
        });
      }
    });
  }

  await createSocket();

  async function sendMessage(conversationId: string, payload: OutboundMessage) {
    const jid = parseWhatsAppConversationId(conversationId);
    const suffix = buildUnsupportedAttachmentNotice(payload.attachments || []);
    const text = [payload.text, suffix].filter(Boolean).join("\n\n");
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) {
      sentMessageIds.add(sent.key.id);
      setTimeout(() => sentMessageIds.delete(sent.key.id!), 30_000);
    }
    return sent;
  }

  return {
    get sock() { return sock; },
    ready,
    sendMessage,
  } as WhatsAppConnection;
}
