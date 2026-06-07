#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const DEFAULT_MODEL = "llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf";
const DEFAULT_DRIVER = path.join(repoRoot, "scripts", "e2e", "telegram-user-driver.py");
const DEFAULT_MTPROTO_DRIVER = path.join(
  repoRoot,
  "scripts",
  "e2e",
  "telegram-mtproto-driver.mjs",
);
const DEFAULT_TASK =
  "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video at 60 fps, validate the recording duration and fps, and send it to me.";

function usage() {
  return `Usage: node scripts/qwen-telegram-e2e-runner.mjs [options]

Runs repeated real-Telegram E2E prompts against OpenClaw/Qwen using the existing
scripts/e2e/telegram-user-driver.py real-user driver or the Node MTProto driver.

Flow per run:
  1. send /new
  2. send /model <model>
  3. send an E2E_RUN_ID-tagged Godot recording task
  4. wait for bot replies and optionally send "Please continue" on idle timeout
  5. write a JSON report

Options:
  --runs <n>                         Number of runs (default: 5)
  --model <provider/model>           Model to select (default: ${DEFAULT_MODEL})
  --driver-kind <tdlib|mtproto>      Driver runtime (default: tdlib)
  --driver <path>                    Telegram user-driver script (default: scripts/e2e/telegram-user-driver.py)
  --python <command>                 Python executable for the driver (default: PYTHON or python)
  --node <command>                   Node executable for the MTProto driver (default: current node)
  --chat <chat>                      Chat id/title passed to telegram-user-driver.py
  --from-bot <username-or-id>         Expected bot sender for waits
  --run-prefix <prefix>              E2E_RUN_ID prefix (default: qwen-godot-telegram)
  --task <text>                      Task text to send after /model
  --timeout-ms <ms>                  Wait timeout for setup replies (default: 120000)
  --task-timeout-ms <ms>             Total task observation window per run (default: 900000)
  --continue-after-seconds <sec>     Send "Please continue" after idle timeout (default: 180; 0 disables)
  --max-continues <n>                Max automatic continue nudges per run (default: 2)
  --settle-seconds <sec>             Sleep between setup messages (default: 3)
  --output <path>                    JSON report path (default: .artifacts/qwen-telegram-e2e/<timestamp>/report.json)
  --no-output                        Do not write a report file; print summary only
  --dry-run                          Print planned sends without contacting Telegram
  --skip-new                         Do not send /new
  --skip-model                       Do not send /model
  --help                             Show this help
`;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer; got ${value}`);
  }
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer; got ${value}`);
  }
  return parsed;
}

function timestampForPath(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parseArgs(argv) {
  const startedAt = new Date();
  const options = {
    runs: 5,
    model: DEFAULT_MODEL,
    driverKind: "tdlib",
    driver: DEFAULT_DRIVER,
    python: process.env.PYTHON || "python",
    node: process.execPath,
    chat: "",
    fromBot: "",
    runPrefix: "qwen-godot-telegram",
    task: DEFAULT_TASK,
    timeoutMs: 120000,
    taskTimeoutMs: 900000,
    continueAfterSeconds: 180,
    maxContinues: 2,
    settleSeconds: 3,
    outputPath: path.join(
      repoRoot,
      ".artifacts",
      "qwen-telegram-e2e",
      timestampForPath(startedAt),
      "report.json",
    ),
    noOutput: false,
    dryRun: false,
    skipNew: false,
    skipModel: false,
    startedAt,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };

    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--runs") {
      options.runs = parsePositiveInteger(readValue(), "--runs");
    } else if (arg === "--model") {
      options.model = readValue();
    } else if (arg === "--driver-kind") {
      const value = readValue();
      if (!["tdlib", "mtproto"].includes(value)) {
        throw new Error(`--driver-kind must be tdlib or mtproto; got ${value}`);
      }
      options.driverKind = value;
    } else if (arg === "--driver") {
      options.driver = path.resolve(readValue());
    } else if (arg === "--python") {
      options.python = readValue();
    } else if (arg === "--node") {
      options.node = readValue();
    } else if (arg === "--chat") {
      options.chat = readValue();
    } else if (arg === "--from-bot") {
      options.fromBot = readValue();
    } else if (arg === "--run-prefix") {
      options.runPrefix = readValue();
    } else if (arg === "--task") {
      options.task = readValue();
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = parsePositiveInteger(readValue(), "--timeout-ms");
    } else if (arg === "--task-timeout-ms") {
      options.taskTimeoutMs = parsePositiveInteger(readValue(), "--task-timeout-ms");
    } else if (arg === "--continue-after-seconds") {
      options.continueAfterSeconds = parseNonNegativeInteger(
        readValue(),
        "--continue-after-seconds",
      );
    } else if (arg === "--max-continues") {
      options.maxContinues = parseNonNegativeInteger(readValue(), "--max-continues");
    } else if (arg === "--settle-seconds") {
      options.settleSeconds = parseNonNegativeInteger(readValue(), "--settle-seconds");
    } else if (arg === "--output") {
      options.outputPath = path.resolve(readValue());
    } else if (arg === "--no-output") {
      options.noOutput = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--skip-new") {
      options.skipNew = true;
    } else if (arg === "--skip-model") {
      options.skipModel = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (options.driverKind === "mtproto" && options.driver === DEFAULT_DRIVER) {
    options.driver = DEFAULT_MTPROTO_DRIVER;
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commandForDisplay(command, args) {
  return [command, ...args]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = new Date();
    const child = spawn(command, args, {
      cwd: options.cwd || repoRoot,
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      resolve({
        command: commandForDisplay(command, args),
        exitCode: null,
        failed: true,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        stdout,
        stderr: `${stderr}${stderr ? "\n" : ""}${error.message}`,
      });
    });
    child.on("close", (exitCode) => {
      resolve({
        command: commandForDisplay(command, args),
        exitCode,
        failed: exitCode !== 0,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        stdout,
        stderr,
      });
    });
  });
}

function buildDriverArgs(options, command, extraArgs = []) {
  const args = [options.driver, command, "--json", "--timeout-ms", String(options.timeoutMs)];
  if (options.chat) {
    args.push("--chat", options.chat);
  }
  args.push(...extraArgs);
  return args;
}

function buildDriverInvocation(options, command, extraArgs = []) {
  const args = buildDriverArgs(options, command, extraArgs);
  if (options.driverKind === "mtproto") {
    return { command: options.node, args };
  }
  return { command: options.python, args };
}

async function driverSend(options, text) {
  const invocation = buildDriverInvocation(options, "send", ["--text", text]);
  if (options.dryRun) {
    return {
      dryRun: true,
      text,
      command: commandForDisplay(invocation.command, invocation.args),
    };
  }
  return runCommand(invocation.command, invocation.args);
}

async function driverWait(options, extraArgs = []) {
  const invocation = buildDriverInvocation(options, "wait", extraArgs);
  if (options.dryRun) {
    return {
      dryRun: true,
      command: commandForDisplay(invocation.command, invocation.args),
    };
  }
  return runCommand(invocation.command, invocation.args);
}

function appendFromBot(options, args) {
  if (options.fromBot) {
    args.push("--from-bot", options.fromBot);
  }
  return args;
}

function collectText(result) {
  if (!result || result.dryRun) {
    return "";
  }
  const raw = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  return raw.slice(0, 12000);
}

function parseDriverJson(result) {
  if (!result || result.dryRun || !result.stdout) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function parseJsonObject(text) {
  if (!text || typeof text !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function hasTelegramDeliveryEvidence(parsed) {
  const message = parsed?.message || parsed?.reply || null;
  const payload = parseJsonObject(message?.text);
  const delivery = payload?.telegram_delivery;
  return Boolean(
    delivery &&
      typeof delivery === "object" &&
      delivery.ok === true &&
      (delivery.messageId || delivery.message_id),
  );
}

export function isTelegramVideoContentType(contentType) {
  const normalized = String(contentType || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, "");
  return normalized === "video" || normalized === "messagevideo";
}

export function inferEvidence(text, parsed = null) {
  const lower = text.toLowerCase();
  const message = parsed?.message || parsed?.reply || null;
  const hasVideoContentType = isTelegramVideoContentType(message?.contentType);
  const hasDeliveryEvidence = hasTelegramDeliveryEvidence(parsed);
  return {
    hasVideoSignal: hasVideoContentType,
    hasDeliveryEvidence,
    hasGuardrailSignal: lower.includes("guardrail") || lower.includes("tool-intent"),
    hasBlockedSignal:
      lower.includes("blocked") ||
      lower.includes("permission denied") ||
      lower.includes("can't") ||
      lower.includes("cannot") ||
      lower.includes("failed") ||
      lower.includes("卡住"),
  };
}

async function waitForTaskProgress(options, runId, taskMessageId) {
  const observations = [];
  const startedAt = Date.now();
  let lastActivityAt = startedAt;
  let continuesSent = 0;
  let cursorMessageId = Number(taskMessageId || 0);

  while (Date.now() - startedAt < options.taskTimeoutMs) {
    const waitArgs = appendFromBot(options, [
      "--after-message-id",
      String(cursorMessageId),
      "--timeout-ms",
      String(Math.min(options.timeoutMs, 60000)),
    ]);
    if (options.driverKind !== "mtproto") {
      waitArgs.push("--expect", runId);
    }
    const waitResult = await driverWait(options, waitArgs);
    const text = collectText(waitResult);
    const parsed = parseDriverJson(waitResult);
    if (!waitResult.failed) {
      const messageId = Number(parsed?.message?.messageId || 0);
      if (messageId > cursorMessageId) {
        cursorMessageId = messageId;
      }
      const evidence = inferEvidence(text, parsed);
      observations.push({
        type: "reply",
        at: new Date().toISOString(),
        result: waitResult,
        parsed,
        evidence,
      });
      lastActivityAt = Date.now();
      if (evidence.hasVideoSignal && !evidence.hasBlockedSignal) {
        break;
      }
    } else {
      observations.push({
        type: "wait-timeout",
        at: new Date().toISOString(),
        result: waitResult,
      });
    }

    const idleSeconds = (Date.now() - lastActivityAt) / 1000;
    if (
      options.continueAfterSeconds > 0 &&
      idleSeconds >= options.continueAfterSeconds &&
      continuesSent < options.maxContinues
    ) {
      const continueText = `E2E_RUN_ID: ${runId}\nPlease continue.`;
      const sendResult = await driverSend(options, continueText);
      observations.push({
        type: "continue-sent",
        at: new Date().toISOString(),
        result: sendResult,
      });
      continuesSent += 1;
      lastActivityAt = Date.now();
    }
  }

  return {
    observations,
    continuesSent,
    durationMs: Date.now() - startedAt,
  };
}

async function runOne(options, index) {
  const runId = `${options.runPrefix}-${String(index + 1).padStart(2, "0")}-${Date.now()}`;
  const run = {
    index: index + 1,
    runId,
    startedAt: new Date().toISOString(),
    sends: [],
    waits: [],
    task: {
      observations: [],
      continuesSent: 0,
      durationMs: 0,
    },
    status: "unknown",
  };

  if (!options.skipNew) {
    run.sends.push({ step: "new", result: await driverSend(options, "/new") });
    await sleep(options.settleSeconds * 1000);
    run.waits.push({
      step: "new-confirmation",
      result: await driverWait(options, appendFromBot(options, [])),
    });
  }

  if (!options.skipModel) {
    run.sends.push({
      step: "model",
      result: await driverSend(options, `/model ${options.model}`),
    });
    await sleep(options.settleSeconds * 1000);
    run.waits.push({
      step: "model-confirmation",
      result: await driverWait(options, appendFromBot(options, ["--expect", options.model])),
    });
  }

  const taskText = `E2E_RUN_ID: ${runId}\n\n${options.task}`;
  const taskSend = await driverSend(options, taskText);
  run.sends.push({ step: "task", result: taskSend });
  const parsedTaskSend = parseDriverJson(taskSend);
  const taskMessageId = parsedTaskSend?.sent?.messageId || parsedTaskSend?.sent?.message_id || 0;

  if (!options.dryRun) {
    run.task = await waitForTaskProgress(options, runId, taskMessageId);
  }

  const combinedText = [
    ...run.waits.map((item) => collectText(item.result)),
    ...run.task.observations.map((item) => collectText(item.result)),
  ].join("\n");
  const evidence = inferEvidence(combinedText);
  const observationEvidence = run.task.observations.reduce(
    (accumulator, item) => ({
      hasVideoSignal: accumulator.hasVideoSignal || Boolean(item.evidence?.hasVideoSignal),
      hasDeliveryEvidence:
        accumulator.hasDeliveryEvidence || Boolean(item.evidence?.hasDeliveryEvidence),
      hasGuardrailSignal:
        accumulator.hasGuardrailSignal || Boolean(item.evidence?.hasGuardrailSignal),
      hasBlockedSignal: accumulator.hasBlockedSignal || Boolean(item.evidence?.hasBlockedSignal),
    }),
    {
      hasVideoSignal: false,
      hasDeliveryEvidence: false,
      hasGuardrailSignal: false,
      hasBlockedSignal: false,
    },
  );
  evidence.hasVideoSignal ||= observationEvidence.hasVideoSignal;
  evidence.hasDeliveryEvidence ||= observationEvidence.hasDeliveryEvidence;
  evidence.hasGuardrailSignal ||= observationEvidence.hasGuardrailSignal;
  evidence.hasBlockedSignal ||= observationEvidence.hasBlockedSignal;
  if (options.dryRun) {
    run.status = "dry-run";
  } else if (evidence.hasVideoSignal && !evidence.hasBlockedSignal) {
    run.status = "pass";
  } else if (evidence.hasBlockedSignal || evidence.hasGuardrailSignal) {
    run.status = "needs-review";
  } else {
    run.status = "unknown";
  }

  run.finishedAt = new Date().toISOString();
  return run;
}

function summarize(runs) {
  const counts = {};
  for (const run of runs) {
    counts[run.status] = (counts[run.status] || 0) + 1;
  }
  return {
    total: runs.length,
    counts,
    passRate: runs.length > 0 ? (counts.pass || 0) / runs.length : 0,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = {
    kind: "qwen-telegram-e2e-runner-report",
    startedAt: options.startedAt.toISOString(),
    options: {
      runs: options.runs,
      model: options.model,
      driverKind: options.driverKind,
      driver: options.driver,
      python: options.python,
      node: options.node,
      chat: options.chat ? "<configured>" : "",
      fromBot: options.fromBot,
      runPrefix: options.runPrefix,
      timeoutMs: options.timeoutMs,
      taskTimeoutMs: options.taskTimeoutMs,
      continueAfterSeconds: options.continueAfterSeconds,
      maxContinues: options.maxContinues,
      settleSeconds: options.settleSeconds,
      dryRun: options.dryRun,
      skipNew: options.skipNew,
      skipModel: options.skipModel,
      noOutput: options.noOutput,
    },
    runs: [],
  };

  for (let index = 0; index < options.runs; index += 1) {
    process.stdout.write(`\n[${index + 1}/${options.runs}] starting Telegram E2E run\n`);
    const run = await runOne(options, index);
    report.runs.push(run);
    process.stdout.write(`[${index + 1}/${options.runs}] ${run.runId}: ${run.status}\n`);
  }

  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report.runs);
  if (!options.noOutput) {
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`\nWrote report: ${options.outputPath}\n`);
  } else {
    process.stdout.write("\nReport file disabled by --no-output\n");
  }
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
