#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const DEFAULT_MODEL = "llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf";
const DEFAULT_CONTAINER = "openclaw-openclaw-gateway-1";
const DEFAULT_TIMEOUT_SECONDS = 240;
const DEFAULT_TURN_DELAY_MS = 3000;
const DEFAULT_TIMEOUT_COOLDOWN_MS = 20000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 20000;
const DEFAULT_LOCK_RETRIES = 1;

const turns = [
  {
    id: "discover",
    message:
      "In my workspace do you see a Godot auto chess mvp project? Just let me know whether it's there or not, thanks.",
  },
  {
    id: "plan",
    message:
      "Cool, I need you to make a gameplay recording for me. What will you do? Just tell me your plan, thanks.",
  },
  {
    id: "execute",
    message:
      "Sounds all good. Let's keep the recording no short. A 15 sec recording with 60 fps is good enough. Please execute it.",
  },
  {
    id: "debug_prompt",
    message:
      "I don't see a usable 15 sec video yet. Please continue, inspect what happened, and debug the recording issue.",
  },
  {
    id: "conclusion",
    message:
      "Please continue until you have a concrete debugging conclusion and a suggested fix. It is okay if the conclusion is not perfectly accurate.",
  },
];

function usage() {
  return `Usage: node scripts/qwen-godot-recording-scenario.mjs [options]

Runs repeated live OpenClaw + Qwen Godot recording scenario sessions.

Options:
  --runs <n>                  Number of scenario runs (default: 10)
  --model <provider/model>    Model override (default: ${DEFAULT_MODEL})
  --timeout <seconds>         Per-turn OpenClaw agent timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --session-prefix <prefix>   Session key prefix (default: qwen-godot-scenario)
  --docker-container <name>   Docker container with openclaw CLI (default: ${DEFAULT_CONTAINER})
  --openclaw-bin <path>       OpenClaw executable inside container (default: openclaw)
  --turn-delay-ms <ms>        Delay between turns in one session (default: ${DEFAULT_TURN_DELAY_MS})
  --timeout-cooldown-ms <ms>  Extra delay after a timed-out turn (default: ${DEFAULT_TIMEOUT_COOLDOWN_MS})
  --lock-retries <n>          Retry same turn after session lock/takeover infra errors (default: ${DEFAULT_LOCK_RETRIES})
  --lock-retry-delay-ms <ms>  Delay before retrying a lock/takeover error (default: ${DEFAULT_LOCK_RETRY_DELAY_MS})
  --output <path>             Write JSON summary (default: .artifacts/qwen-godot-scenario/<timestamp>.json)
  --help                      Show this help
`;
}

function parseNonNegativeIntegerOption(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    runs: 10,
    model: process.env.OPENCLAW_QWEN_SCENARIO_MODEL || DEFAULT_MODEL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    sessionPrefix: "qwen-godot-scenario",
    dockerContainer: process.env.OPENCLAW_QWEN_SCENARIO_CONTAINER || DEFAULT_CONTAINER,
    openclawBin: "openclaw",
    turnDelayMs: DEFAULT_TURN_DELAY_MS,
    timeoutCooldownMs: DEFAULT_TIMEOUT_COOLDOWN_MS,
    lockRetries: DEFAULT_LOCK_RETRIES,
    lockRetryDelayMs: DEFAULT_LOCK_RETRY_DELAY_MS,
    outputPath: "",
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
      const parsed = Number.parseInt(readValue(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--runs must be a positive integer");
      }
      options.runs = parsed;
    } else if (arg === "--model") {
      options.model = readValue();
    } else if (arg === "--timeout") {
      const parsed = Number.parseInt(readValue(), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error("--timeout must be a positive integer");
      }
      options.timeoutSeconds = parsed;
    } else if (arg === "--session-prefix") {
      options.sessionPrefix = readValue();
    } else if (arg === "--docker-container") {
      options.dockerContainer = readValue();
    } else if (arg === "--openclaw-bin") {
      options.openclawBin = readValue();
    } else if (arg === "--turn-delay-ms") {
      options.turnDelayMs = parseNonNegativeIntegerOption(readValue(), "--turn-delay-ms");
    } else if (arg === "--timeout-cooldown-ms") {
      options.timeoutCooldownMs = parseNonNegativeIntegerOption(
        readValue(),
        "--timeout-cooldown-ms",
      );
    } else if (arg === "--lock-retries") {
      options.lockRetries = parseNonNegativeIntegerOption(readValue(), "--lock-retries");
    } else if (arg === "--lock-retry-delay-ms") {
      options.lockRetryDelayMs = parseNonNegativeIntegerOption(
        readValue(),
        "--lock-retry-delay-ms",
      );
    } else if (arg === "--output") {
      options.outputPath = path.resolve(readValue());
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function sanitizeSessionKeyPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function runProcess(command, args, timeoutSeconds) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, Math.max(1, timeoutSeconds + 30) * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function isSessionLockInfraError(processResult) {
  const stderr = String(processResult.stderr ?? "");
  return (
    stderr.includes("SessionWriteLockTimeoutError") ||
    stderr.includes("EmbeddedAttemptSessionTakeoverError") ||
    stderr.includes("session file locked") ||
    stderr.includes("session file changed while embedded prompt lock was released")
  );
}

function parseAgentJson(stdout) {
  const trimmed = stdout.trim();
  const firstJson = trimmed.indexOf("{");
  const lastJson = trimmed.lastIndexOf("}");
  if (firstJson < 0 || lastJson < firstJson) {
    return null;
  }
  try {
    return JSON.parse(trimmed.slice(firstJson, lastJson + 1));
  } catch {
    return null;
  }
}

function collectPayloadText(response) {
  const result = response?.result ?? response ?? {};
  return (result.payloads ?? [])
    .map((payload) => payload?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function classifyTurn(turnId, response, processResult) {
  const text = collectPayloadText(response);
  const lower = text.toLowerCase();
  const meta = (response?.result ?? response ?? {}).meta ?? {};
  const tools = meta.toolSummary?.tools ?? [];
  const toolCalls = Number(meta.toolSummary?.calls ?? 0);
  const guardrail =
    lower.includes("tool-intent guardrail") ||
    meta.executionTrace?.attempts?.some((attempt) => attempt.reason === "tool_intent_guardrail");
  const timeout = processResult.timedOut === true;
  const statusOk = processResult.code === 0 && response?.status === "ok";

  const checks = {
    statusOk,
    guardrail,
    timeout,
    toolCalls,
    tools,
    mentionsProject:
      lower.includes("roguelike_auto_chess_mvp") ||
      lower.includes("auto chess") ||
      lower.includes("project.godot"),
    mentionsGodotRunner:
      lower.includes("godot runner") ||
      lower.includes("host runner") ||
      lower.includes("jobs/game/requests") ||
      lower.includes("request json"),
    mentionsRecording:
      lower.includes("record") || lower.includes("video") || lower.includes("capture"),
    mentionsDebug:
      lower.includes("debug") ||
      lower.includes("inspect") ||
      lower.includes("issue") ||
      lower.includes("problem") ||
      lower.includes("fix") ||
      lower.includes("runner") ||
      lower.includes("schema"),
    deliveredFinalConclusion:
      lower.includes("conclusion") ||
      lower.includes("root cause") ||
      lower.includes("likely") ||
      lower.includes("suggested fix") ||
      lower.includes("recommend"),
  };

  const passByTurn = {
    discover: checks.statusOk && checks.mentionsProject,
    plan: checks.statusOk && checks.mentionsRecording && checks.mentionsGodotRunner,
    execute: checks.statusOk && (toolCalls > 0 || checks.guardrail),
    debug_prompt: checks.statusOk && (toolCalls > 0 || checks.guardrail || checks.mentionsDebug),
    conclusion: checks.statusOk && checks.mentionsDebug && checks.deliveredFinalConclusion,
  };

  return {
    ok: Boolean(passByTurn[turnId]),
    checks,
    payloadText: text.slice(0, 4000),
    stopReason: meta.stopReason,
    executionTrace: meta.executionTrace,
    sessionFile: meta.agentMeta?.sessionFile,
    promptTokens: meta.agentMeta?.promptTokens,
    durationMs: meta.durationMs,
  };
}

function commandForTurn(options, sessionKey, message) {
  const openclawArgs = [
    "agent",
    "--session-key",
    sessionKey,
    "--model",
    options.model,
    "--thinking",
    "off",
    "--json",
    "--timeout",
    String(options.timeoutSeconds),
    "--message",
    message,
  ];
  return {
    command: "docker",
    args: ["exec", options.dockerContainer, options.openclawBin, ...openclawArgs],
  };
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, ".artifacts", "qwen-godot-scenario", `${stamp}.json`);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function runScenario(options, runIndex, runId) {
  const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${runIndex}-${runId}`;
  const turnResults = [];
  let previousTimedOut = false;
  for (const turn of turns) {
    const command = commandForTurn(options, sessionKey, turn.message);
    if (turnResults.length > 0 && options.turnDelayMs > 0) {
      await sleep(options.turnDelayMs);
    }
    if (previousTimedOut && options.timeoutCooldownMs > 0) {
      process.stdout.write(
        `scenario ${runIndex}/${options.runs} turn=${turn.id} timeout-cooldown-ms=${options.timeoutCooldownMs}\n`,
      );
      await sleep(options.timeoutCooldownMs);
    }
    process.stdout.write(`scenario ${runIndex}/${options.runs} turn=${turn.id}\n`);
    const attemptResults = [];
    let processResult;
    for (let attempt = 0; attempt <= options.lockRetries; attempt += 1) {
      const startedAt = Date.now();
      processResult = await runProcess(
        command.command,
        command.args,
        Number(options.timeoutSeconds),
      );
      attemptResults.push({
        attempt: attempt + 1,
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        durationMs: Date.now() - startedAt,
        lockInfraError: isSessionLockInfraError(processResult),
        stderrTail: processResult.stderr.slice(-3000),
      });
      if (!isSessionLockInfraError(processResult) || attempt >= options.lockRetries) {
        break;
      }
      process.stdout.write(
        `scenario ${runIndex}/${options.runs} turn=${turn.id} session-lock-retry=${attempt + 1}/${options.lockRetries} delay-ms=${options.lockRetryDelayMs}\n`,
      );
      await sleep(options.lockRetryDelayMs);
    }
    previousTimedOut = processResult.timedOut === true;
    const response = parseAgentJson(processResult.stdout);
    const classification = classifyTurn(turn.id, response, processResult);
    turnResults.push({
      id: turn.id,
      message: turn.message,
      ok: classification.ok,
      process: {
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        durationMs: attemptResults.reduce((total, attempt) => total + attempt.durationMs, 0),
        lockInfraError: isSessionLockInfraError(processResult),
        stderrTail: processResult.stderr.slice(-3000),
        attempts: attemptResults,
      },
      classification,
      rawJsonParsed: Boolean(response),
    });
  }
  return {
    runIndex,
    sessionKey,
    ok: turnResults.every((turn) => turn.ok),
    turns: turnResults,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = Date.now().toString(36);
  const outputPath = options.outputPath || defaultOutputPath();
  const startedAt = new Date().toISOString();
  const results = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const result = await runScenario(options, index, runId);
    results.push(result);
    writeJson(outputPath, {
      ok: results.length === options.runs && results.every((entry) => entry.ok),
      generatedAt: new Date().toISOString(),
      startedAt,
      host: os.hostname(),
      model: options.model,
      dockerContainer: options.dockerContainer,
      turnDelayMs: options.turnDelayMs,
      timeoutCooldownMs: options.timeoutCooldownMs,
      lockRetries: options.lockRetries,
      lockRetryDelayMs: options.lockRetryDelayMs,
      turns,
      results,
    });
    const passedTurns = result.turns.filter((turn) => turn.ok).length;
    process.stdout.write(
      `scenario ${index}/${options.runs} ${result.ok ? "PASS" : "PARTIAL"} passedTurns=${passedTurns}/${turns.length} session=${result.sessionKey}\n`,
    );
  }
  process.stdout.write(`qwen-godot-scenario: summary ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `qwen-godot-scenario: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
