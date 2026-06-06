#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const DEFAULT_STATE_DIR = path.join(__dirname, "telegram-mtproto-driver");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_STATE_DIR, "config.local.json");
const EXAMPLE_CONFIG_PATH = path.join(__dirname, "telegram-mtproto-driver.config.example.json");

class DriverError extends Error {}

function usage() {
  return `Usage: node scripts/e2e/telegram-mtproto-driver.mjs <command> [options]

Commands:
  doctor --json
  login --json [--phone <number>] [--code <code>] [--password <2fa>]
  send --chat <bot-or-chat> --text <message> --json
  wait --chat <bot-or-chat> [--expect <text>] [--from-bot <username-or-id>] [--after-message-id <id>] --json
  transcript --chat <bot-or-chat> [--since <timestamp-or-run-id>] --json
  chats --json

Config:
  Copy scripts/e2e/telegram-mtproto-driver.config.example.json to
  scripts/e2e/telegram-mtproto-driver/config.local.json, then set apiId/apiHash
  from https://my.telegram.org. Secrets are also accepted through
  TELEGRAM_MTPROTO_DRIVER_API_ID, TELEGRAM_MTPROTO_DRIVER_API_HASH,
  TELEGRAM_MTPROTO_DRIVER_PHONE, TELEGRAM_MTPROTO_DRIVER_CHAT, and
  TELEGRAM_MTPROTO_DRIVER_SUT_USERNAME.
`;
}

function parseArgs(argv) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(usage());
    process.exit(0);
  }
  const flags = new Map();
  const appendFlags = new Map();
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new DriverError(`unknown positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (["json", "media", "video"].includes(key)) {
      flags.set(key, true);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new DriverError(`missing value for ${arg}`);
    }
    index += 1;
    if (key === "expect") {
      const values = appendFlags.get(key) || [];
      values.push(value);
      appendFlags.set(key, values);
    } else {
      flags.set(key, value);
    }
  }
  return { command, flags, appendFlags };
}

function expandHome(value) {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return process.env.USERPROFILE || process.env.HOME || value;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(process.env.USERPROFILE || process.env.HOME || "~", value.slice(2));
  }
  return value;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writePrivate(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, { mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function stateDir() {
  return path.resolve(expandHome(process.env.TELEGRAM_MTPROTO_DRIVER_STATE_DIR) || DEFAULT_STATE_DIR);
}

function configPath() {
  return path.resolve(expandHome(process.env.TELEGRAM_MTPROTO_DRIVER_CONFIG) || path.join(stateDir(), "config.local.json"));
}

function envOrConfig(envName, config, key, fallback = "") {
  const envValue = process.env[envName]?.trim();
  if (envValue) {
    return envValue;
  }
  const value = config[key];
  if (typeof value === "number") {
    return String(value);
  }
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

async function loadConfig() {
  const config = await readJson(configPath());
  const dir = stateDir();
  const configuredSessionFile = envOrConfig(
    "TELEGRAM_MTPROTO_DRIVER_SESSION_FILE",
    config,
    "sessionFile",
    "session.txt",
  );
  return {
    raw: config,
    stateDir: dir,
    configPath: configPath(),
    apiId: envOrConfig("TELEGRAM_MTPROTO_DRIVER_API_ID", config, "apiId"),
    apiHash: envOrConfig("TELEGRAM_MTPROTO_DRIVER_API_HASH", config, "apiHash"),
    phoneNumber: envOrConfig("TELEGRAM_MTPROTO_DRIVER_PHONE", config, "phoneNumber"),
    defaultChat: envOrConfig("TELEGRAM_MTPROTO_DRIVER_CHAT", config, "defaultChat"),
    sutUsername: envOrConfig("TELEGRAM_MTPROTO_DRIVER_SUT_USERNAME", config, "sutUsername"),
    sessionFile: path.resolve(dir, expandHome(configuredSessionFile)),
  };
}

async function loadGramJs() {
  try {
    const telegram = await import("telegram");
    const sessions = await import("telegram/sessions/index.js");
    return {
      TelegramClient: telegram.TelegramClient,
      Logger: telegram.Logger,
      StringSession: sessions.StringSession,
    };
  } catch (error) {
    throw new DriverError(
      `Missing GramJS dependency "telegram". Install project dependencies or add it with the repo package manager. Detail: ${error.message}`,
    );
  }
}

async function readSession(filePath) {
  try {
    return (await fs.readFile(filePath, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function createClient(config, { requireSession = true } = {}) {
  if (!config.apiId || !config.apiHash) {
    throw new DriverError("Missing apiId/apiHash. Configure config.local.json or TELEGRAM_MTPROTO_DRIVER_API_ID/API_HASH.");
  }
  const { Logger, TelegramClient, StringSession } = await loadGramJs();
  const session = new StringSession(await readSession(config.sessionFile));
  const client = new TelegramClient(session, Number(config.apiId), config.apiHash, {
    baseLogger: new Logger("none"),
    connectionRetries: 5,
  });
  await client.connect();
  const authorized = await client.checkAuthorization();
  if (requireSession && !authorized) {
    await client.disconnect();
    throw new DriverError("Not logged in. Run: node scripts/e2e/telegram-mtproto-driver.mjs login --json");
  }
  return { client, session };
}

async function prompt(label, { secret = false } = {}) {
  if (!process.stdin.isTTY) {
    throw new DriverError(`${label} is required; pass it as a flag in a non-interactive terminal.`);
  }
  const rl = createInterface({ input, output });
  try {
    if (!secret) {
      return (await rl.question(label)).trim();
    }
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

function publicPeer(peer) {
  if (!peer) {
    return {};
  }
  return {
    id: peer.id?.toString?.() || String(peer.id || ""),
    username: peer.username || "",
    firstName: peer.firstName || "",
    lastName: peer.lastName || "",
    title: peer.title || "",
    bot: Boolean(peer.bot),
  };
}

function mediaType(message) {
  const media = message.media;
  if (!media) {
    return "";
  }
  const className = media.className || media.constructor?.name || "";
  const document = media.document;
  const mimeType = document?.mimeType || "";
  if (message.video || mimeType.startsWith("video/")) {
    return "video";
  }
  if (message.photo) {
    return "photo";
  }
  if (document) {
    return "document";
  }
  return className || "media";
}

async function normalizeMessage(client, message) {
  let sender = {};
  try {
    sender = publicPeer(await message.getSender());
  } catch {}
  return {
    messageId: Number(message.id || 0),
    chatId: message.chatId?.toString?.() || "",
    senderId: message.senderId?.toString?.() || "",
    senderUsername: sender.username || "",
    date: message.date instanceof Date ? Math.floor(message.date.getTime() / 1000) : message.date || 0,
    replyToMessageId: Number(message.replyTo?.replyToMsgId || 0) || undefined,
    text: message.message || "",
    contentType: mediaType(message) || "text",
    hasMedia: Boolean(message.media),
    sender,
  };
}

async function resolveChat(client, config, chatArg) {
  const chat = chatArg || config.defaultChat;
  if (!chat) {
    throw new DriverError("Missing chat. Pass --chat or set defaultChat in config.local.json.");
  }
  return client.getEntity(chat);
}

function parseSince(value) {
  if (!value) {
    return {};
  }
  if (/^\d+$/u.test(value)) {
    const numeric = Number(value);
    return { afterMessageId: numeric > 2_000_000_000 ? 0 : numeric, sinceDate: numeric > 2_000_000_000 ? numeric : 0 };
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return { sinceDate: Math.floor(parsed / 1000) };
  }
  return { contains: value };
}

function matchesSender(message, fromBot) {
  if (!fromBot) {
    return true;
  }
  const normalized = fromBot.replace(/^@/u, "").toLowerCase();
  if (/^-?\d+$/u.test(normalized)) {
    return String(message.senderId) === normalized;
  }
  return String(message.senderUsername || "").toLowerCase() === normalized;
}

function matchesMessage(message, filters) {
  if (filters.afterMessageId && Number(message.messageId) <= Number(filters.afterMessageId)) {
    return false;
  }
  if (filters.replyTo && String(message.replyToMessageId || "") !== String(filters.replyTo)) {
    return false;
  }
  if (filters.sinceDate && Number(message.date || 0) < Number(filters.sinceDate)) {
    return false;
  }
  if (filters.contains && !message.text.includes(filters.contains)) {
    return false;
  }
  if (!matchesSender(message, filters.fromBot)) {
    return false;
  }
  if (filters.expect?.some((entry) => !message.text.includes(entry))) {
    return false;
  }
  if (filters.media && !message.hasMedia) {
    return false;
  }
  if (filters.video && message.contentType !== "video") {
    return false;
  }
  return true;
}

async function fetchTranscript(client, chatEntity, filters) {
  const limit = Number(filters.limit || 50);
  const rawMessages = await client.getMessages(chatEntity, { limit });
  const messages = [];
  for (const message of rawMessages) {
    const normalized = await normalizeMessage(client, message);
    if (matchesMessage(normalized, filters)) {
      messages.push(normalized);
    }
  }
  return messages.sort((left, right) => left.messageId - right.messageId);
}

async function commandDoctor(args) {
  const config = await loadConfig();
  let gramjsAvailable = false;
  let gramjsError = "";
  try {
    await loadGramJs();
    gramjsAvailable = true;
  } catch (error) {
    gramjsError = error.message;
  }
  const hasSession = await pathExists(config.sessionFile);
  let authorized = false;
  let authError = "";
  if (gramjsAvailable && config.apiId && config.apiHash && hasSession) {
    try {
      const { client } = await createClient(config, { requireSession: false });
      authorized = await client.checkAuthorization();
      await client.disconnect();
    } catch (error) {
      authError = error.message;
    }
  }
  const ok = Boolean(gramjsAvailable && config.apiId && config.apiHash && authorized);
  printResult(
    {
      ok,
      kind: "telegram-mtproto-driver-doctor",
      repoRoot,
      configPath: config.configPath,
      exampleConfigPath: EXAMPLE_CONFIG_PATH,
      stateDir: config.stateDir,
      sessionFile: config.sessionFile,
      gramjsAvailable,
      gramjsError,
      hasApiId: Boolean(config.apiId),
      hasApiHash: Boolean(config.apiHash),
      hasPhoneNumber: Boolean(config.phoneNumber),
      hasDefaultChat: Boolean(config.defaultChat),
      hasSutUsername: Boolean(config.sutUsername),
      hasSession,
      authorized,
      authError,
      next: ok
        ? "send --chat <bot-or-chat> --text /new --json"
        : gramjsAvailable && config.apiId && config.apiHash
          ? "login --json"
          : "copy the example config to config.local.json and set apiId/apiHash",
    },
    args.flags.get("json"),
  );
  if (!ok) {
    process.exitCode = 1;
  }
}

async function commandLogin(args) {
  const config = await loadConfig();
  const { client, session } = await createClient(config, { requireSession: false });
  await client.start({
    phoneNumber: async () => args.flags.get("phone") || config.phoneNumber || (await prompt("Telegram phone number: ")),
    phoneCode: async () => args.flags.get("code") || (await prompt("Telegram login code: ")),
    password: async () => args.flags.get("password") || (await prompt("Telegram 2FA password: ", { secret: true })),
    onError: (error) => {
      throw error;
    },
  });
  const sessionString = session.save();
  await writePrivate(config.sessionFile, `${sessionString}\n`);
  const me = await client.getMe();
  await client.disconnect();
  printResult({ ok: true, sessionFile: config.sessionFile, user: publicPeer(me) }, args.flags.get("json"));
}

async function commandSend(args) {
  const config = await loadConfig();
  const text = args.flags.get("text");
  if (!text) {
    throw new DriverError("Missing --text.");
  }
  const { client } = await createClient(config);
  const chat = await resolveChat(client, config, args.flags.get("chat"));
  const sent = await client.sendMessage(chat, { message: text });
  const normalized = await normalizeMessage(client, sent);
  await client.disconnect();
  printResult({ ok: true, sent: normalized }, args.flags.get("json"));
}

async function commandTranscript(args) {
  const config = await loadConfig();
  const { client } = await createClient(config);
  const chat = await resolveChat(client, config, args.flags.get("chat"));
  const since = parseSince(args.flags.get("since") || "");
  const messages = await fetchTranscript(client, chat, {
    ...since,
    limit: Number(args.flags.get("limit") || 50),
  });
  await client.disconnect();
  printResult({ ok: true, messages, observedCount: messages.length }, args.flags.get("json"));
}

async function commandWait(args) {
  const config = await loadConfig();
  const { client } = await createClient(config);
  const chat = await resolveChat(client, config, args.flags.get("chat"));
  const timeoutMs = Number(args.flags.get("timeout-ms") || 120000);
  const filters = {
    expect: args.appendFlags.get("expect") || [],
    fromBot: args.flags.get("from-bot") || config.sutUsername,
    afterMessageId: Number(args.flags.get("after-message-id") || 0),
    replyTo: args.flags.get("reply-to") || "",
    media: Boolean(args.flags.get("media")),
    video: Boolean(args.flags.get("video")),
    limit: Number(args.flags.get("limit") || 50),
  };
  const startedAt = Date.now();
  let observed = [];
  let match = null;
  while (Date.now() - startedAt < timeoutMs) {
    observed = await fetchTranscript(client, chat, filters);
    match = observed.at(-1) || null;
    if (match) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await client.disconnect();
  printResult(
    {
      ok: Boolean(match),
      message: match,
      observedCount: observed.length,
      observed: match ? [] : observed.slice(-10),
    },
    args.flags.get("json"),
  );
  if (!match) {
    process.exitCode = 1;
  }
}

async function commandChats(args) {
  const config = await loadConfig();
  const { client } = await createClient(config);
  const dialogs = await client.getDialogs({ limit: Number(args.flags.get("limit") || 50) });
  const chats = dialogs.map((dialog) => ({
    id: dialog.id?.toString?.() || "",
    title: dialog.title || "",
    name: dialog.name || "",
    username: dialog.entity?.username || "",
    isUser: Boolean(dialog.isUser),
    isGroup: Boolean(dialog.isGroup),
    isChannel: Boolean(dialog.isChannel),
  }));
  await client.disconnect();
  printResult({ ok: true, chats }, args.flags.get("json"));
}

function printResult(payload, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "doctor") {
    await commandDoctor(args);
  } else if (args.command === "login") {
    await commandLogin(args);
  } else if (args.command === "send") {
    await commandSend(args);
  } else if (args.command === "wait") {
    await commandWait(args);
  } else if (args.command === "transcript") {
    await commandTranscript(args);
  } else if (args.command === "chats") {
    await commandChats(args);
  } else {
    throw new DriverError(`unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
