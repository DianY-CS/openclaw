#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const defaultCasesPath = path.join(__dirname, "qwen-tool-smoke.cases.json");
const DEFAULT_MODEL = "llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf";
const DEFAULT_TIMEOUT_SECONDS = 240;

function usage() {
  return `Usage: node scripts/qwen-tool-smoke.mjs [options]

Runs live OpenClaw agent smoke cases for local Qwen multi-tool behavior.

Options:
  --cases <path>              Case JSON file (default: scripts/qwen-tool-smoke.cases.json)
  --case <name>               Run only one case. Can be repeated.
  --model <provider/model>    Model override (default: ${DEFAULT_MODEL})
  --timeout <seconds>         Per-case OpenClaw agent timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --session-prefix <prefix>   Session key prefix (default: qwen-tool-smoke)
  --docker-container <name>   Run the openclaw CLI inside this Docker container
  --openclaw-bin <path>       Local openclaw executable (default: openclaw)
  --output <path>             Write JSON summary (default: .artifacts/qwen-tool-smoke/<timestamp>.json)
  --keep-going                Run remaining cases after a failure
  --help                      Show this help

Environment:
  OPENCLAW_QWEN_SMOKE_CONTAINER    Same as --docker-container
  OPENCLAW_QWEN_SMOKE_MODEL        Same as --model
`;
}

function parseArgs(argv) {
  const options = {
    casesPath: defaultCasesPath,
    caseNames: [],
    model: process.env.OPENCLAW_QWEN_SMOKE_MODEL || DEFAULT_MODEL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    sessionPrefix: "qwen-tool-smoke",
    dockerContainer: process.env.OPENCLAW_QWEN_SMOKE_CONTAINER || "",
    openclawBin: "openclaw",
    outputPath: "",
    keepGoing: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
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
    } else if (arg === "--cases") {
      options.casesPath = path.resolve(readValue());
    } else if (arg === "--case") {
      options.caseNames.push(readValue());
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
    } else if (arg === "--output") {
      options.outputPath = path.resolve(readValue());
    } else if (arg === "--keep-going") {
      options.keepGoing = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sanitizeSessionKeyPart(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function commandForCase(options, testCase, sessionKey) {
  const timeout = String(testCase.timeoutSeconds ?? options.timeoutSeconds);
  const model = testCase.model || options.model;
  const openclawArgs = [
    "agent",
    "--session-key",
    sessionKey,
    "--model",
    model,
    "--thinking",
    "off",
    "--json",
    "--timeout",
    timeout,
    "--message",
    testCase.message,
  ];
  if (options.dockerContainer) {
    return {
      command: "docker",
      args: ["exec", options.dockerContainer, options.openclawBin, ...openclawArgs],
      model,
      timeout,
    };
  }
  return {
    command: options.openclawBin,
    args: openclawArgs,
    model,
    timeout,
  };
}

function runProcess(command, args, timeoutSeconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutSeconds}s: ${command} ${args.join(" ")}`));
    }, Math.max(1, timeoutSeconds + 30) * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseAgentJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("openclaw agent produced empty stdout");
  }
  const firstJson = trimmed.indexOf("{");
  const lastJson = trimmed.lastIndexOf("}");
  if (firstJson < 0 || lastJson < firstJson) {
    throw new Error(`openclaw agent stdout did not contain JSON:\n${stdout}`);
  }
  return JSON.parse(trimmed.slice(firstJson, lastJson + 1));
}

function collectPayloadText(response) {
  const result = response.result ?? response;
  return (result.payloads ?? [])
    .map((payload) => payload?.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function assertCondition(condition, message, failures) {
  if (!condition) {
    failures.push(message);
  }
}

function arrayIncludesAll(actual, expected) {
  return expected.every((item) => actual.includes(item));
}

function assertCase(testCase, response) {
  const failures = [];
  const result = response.result ?? response;
  const meta = result.meta ?? {};
  const expect = testCase.expect ?? {};
  const text = collectPayloadText(response);
  const tools = meta.toolSummary?.tools ?? [];
  const toolCalls = Number(meta.toolSummary?.calls ?? 0);
  const executionTrace = meta.executionTrace ?? {};

  if (expect.status) {
    assertCondition(response.status === expect.status, `expected status=${expect.status}, got ${response.status}`, failures);
  }
  if (expect.stopReason) {
    assertCondition(meta.stopReason === expect.stopReason, `expected stopReason=${expect.stopReason}, got ${meta.stopReason}`, failures);
  }
  if (typeof expect.minToolCalls === "number") {
    assertCondition(toolCalls >= expect.minToolCalls, `expected at least ${expect.minToolCalls} tool calls, got ${toolCalls}`, failures);
  }
  if (typeof expect.maxToolCalls === "number") {
    assertCondition(toolCalls <= expect.maxToolCalls, `expected at most ${expect.maxToolCalls} tool calls, got ${toolCalls}`, failures);
  }
  if (Array.isArray(expect.toolsInclude)) {
    assertCondition(
      arrayIncludesAll(tools, expect.toolsInclude),
      `expected tools to include ${expect.toolsInclude.join(", ")}, got ${tools.join(", ") || "(none)"}`,
      failures,
    );
  }
  if (typeof expect.fallbackUsed === "boolean") {
    assertCondition(
      executionTrace.fallbackUsed === expect.fallbackUsed,
      `expected fallbackUsed=${expect.fallbackUsed}, got ${executionTrace.fallbackUsed}`,
      failures,
    );
  }
  if (expect.winnerProvider) {
    assertCondition(
      executionTrace.winnerProvider === expect.winnerProvider,
      `expected winnerProvider=${expect.winnerProvider}, got ${executionTrace.winnerProvider}`,
      failures,
    );
  }
  if (expect.winnerModelIncludes) {
    assertCondition(
      String(executionTrace.winnerModel ?? "").includes(expect.winnerModelIncludes),
      `expected winnerModel to include ${expect.winnerModelIncludes}, got ${executionTrace.winnerModel}`,
      failures,
    );
  }
  for (const value of expect.payloadMustContain ?? []) {
    assertCondition(text.includes(value), `expected payload to contain ${JSON.stringify(value)}, got ${JSON.stringify(text)}`, failures);
  }
  for (const value of expect.payloadMustNotContain ?? []) {
    assertCondition(!text.includes(value), `expected payload not to contain ${JSON.stringify(value)}, got ${JSON.stringify(text)}`, failures);
  }

  return {
    ok: failures.length === 0,
    failures,
    payloadText: text,
    toolCalls,
    tools,
    stopReason: meta.stopReason,
    executionTrace,
  };
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, ".artifacts", "qwen-tool-smoke", `${stamp}.json`);
}

function writeSummary(outputPath, summary) {
  const content = `${JSON.stringify(summary, null, 2)}\n`;
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content);
    return outputPath;
  } catch (error) {
    const fallbackPath = path.join(os.tmpdir(), "openclaw-qwen-tool-smoke", path.basename(outputPath));
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
    fs.writeFileSync(fallbackPath, content);
    process.stderr.write(
      `qwen-tool-smoke: could not write summary to ${outputPath}; wrote ${fallbackPath} instead (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return fallbackPath;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cases = readJson(options.casesPath);
  const selected = options.caseNames.length
    ? cases.filter((testCase) => options.caseNames.includes(testCase.name))
    : cases;
  const missing = options.caseNames.filter((name) => !cases.some((testCase) => testCase.name === name));
  if (missing.length > 0) {
    throw new Error(`unknown case(s): ${missing.join(", ")}`);
  }
  if (selected.length === 0) {
    throw new Error("no smoke cases selected");
  }

  const runId = Date.now().toString(36);
  const host = os.hostname();
  const results = [];
  let failed = false;
  for (const testCase of selected) {
    const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${sanitizeSessionKeyPart(testCase.name)}-${runId}`;
    const command = commandForCase(options, testCase, sessionKey);
    process.stdout.write(`qwen-tool-smoke: running ${testCase.name} (${command.model})\n`);
    const startedAt = Date.now();
    const processResult = await runProcess(command.command, command.args, Number(command.timeout));
    const durationMs = Date.now() - startedAt;
    let response;
    let assertion;
    try {
      response = parseAgentJson(processResult.stdout);
      assertion = assertCase(testCase, response);
    } catch (error) {
      assertion = {
        ok: false,
        failures: [error instanceof Error ? error.message : String(error)],
        payloadText: "",
        toolCalls: 0,
        tools: [],
        stopReason: undefined,
        executionTrace: undefined,
      };
    }
    const ok = processResult.code === 0 && assertion.ok;
    failed ||= !ok;
    const result = {
      name: testCase.name,
      description: testCase.description,
      ok,
      durationMs,
      sessionKey,
      command: `${command.command} ${command.args.map((arg) => JSON.stringify(arg)).join(" ")}`,
      exitCode: processResult.code,
      signal: processResult.signal,
      failures: [
        ...(processResult.code === 0 ? [] : [`process exited with code=${processResult.code} signal=${processResult.signal ?? ""}`]),
        ...assertion.failures,
      ],
      payloadText: assertion.payloadText,
      toolCalls: assertion.toolCalls,
      tools: assertion.tools,
      stopReason: assertion.stopReason,
      executionTrace: assertion.executionTrace,
      stderrTail: processResult.stderr.slice(-4000),
    };
    results.push(result);
    if (ok) {
      process.stdout.write(
        `qwen-tool-smoke: PASS ${testCase.name} tools=${result.tools.join(",") || "(none)"} calls=${result.toolCalls} durationMs=${durationMs}\n`,
      );
    } else {
      process.stderr.write(`qwen-tool-smoke: FAIL ${testCase.name}\n${result.failures.join("\n")}\n`);
      if (result.stderrTail) {
        process.stderr.write(`stderr tail:\n${result.stderrTail}\n`);
      }
      if (!options.keepGoing) {
        break;
      }
    }
  }

  const outputPath = options.outputPath || defaultOutputPath();
  const summaryPath = writeSummary(outputPath, {
    ok: !failed,
    generatedAt: new Date().toISOString(),
    host,
    model: options.model,
    dockerContainer: options.dockerContainer || null,
    casesPath: options.casesPath,
    results,
  });
  process.stdout.write(`qwen-tool-smoke: summary ${summaryPath}\n`);
  if (failed) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`qwen-tool-smoke: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
