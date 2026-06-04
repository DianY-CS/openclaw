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
const DEFAULT_TIMEOUT_SECONDS = 360;

const evidencePrompt = `You are debugging a failed Godot gameplay recording job.

Do not run tools. Use only the evidence below.
Give a concrete debugging conclusion and suggested fix. It is okay if the conclusion is not perfectly accurate, but it must be specific and evidence-based.
This is a final-answer task. Start your visible answer with exactly:

RESPONSE_MODE: final

After that, write the conclusion. Do not promise future tool work. Do not write "let me", "I'll", "I will", "I need to check", or similar future-action text.

Before writing the conclusion, reason from these required checks. Your final answer should include the checks briefly:

1. Field-path check:
   - Compare the request's nested capture fields against the runner's field reads.
   - The request uses capture.record_seconds, capture.fps, capture.width, and capture.height.
   - The runner excerpt reads top-level record_seconds, record_fps, record_width, and record_height.
   - Decide whether the requested 15s/60fps/size settings are actually used.

2. Recording-path check:
   - The log says "Capture region: focused Godot window".
   - record_screen() receives capture_region as the region argument.
   - The FFmpeg shortcut only runs when region is None.
   - Decide whether the FFmpeg shortcut or the Python/mss frame loop is the likely path for this evidence.

3. Duration math check:
   - Compute frame_count / average_fps.
   - Explain why 10 frames at 60fps becomes about 0.1667 seconds.

4. Fix check:
   - Recommend concrete code-level changes for both configuration parsing and recording backend selection.
   - If recommending FFmpeg, mention that CFR output may require an fps filter to produce about 900 frames for 15s at 60fps.

Expected output:
- about 15 seconds
- 60fps
- about 900 frames

Request JSON:

\`\`\`json
{
  "job_id": "roguelike_auto_chess_recording_20260601_160900",
  "action": "run_and_capture",
  "project_path": "D:\\\\OpenClawWorkspace\\\\games\\\\roguelike_auto_chess_mvp",
  "scene": "scenes/combat_sandbox.tscn",
  "wait_seconds": 6,
  "capture": {
    "screenshot": false,
    "video": true,
    "record_seconds": 15,
    "fps": 60,
    "width": 1920,
    "height": 1080
  }
}
\`\`\`

Observed status:

\`\`\`json
{
  "status": "done",
  "job_id": "roguelike_auto_chess_recording_20260601_160900",
  "video_probe": {
    "duration_seconds": 0.16666666666666666,
    "frame_count": 10,
    "average_fps": 60.0
  },
  "recording": "D:\\\\OpenClawWorkspace\\\\jobs\\\\game\\\\results\\\\roguelike_auto_chess_recording_20260601_160900\\\\recording.mp4"
}
\`\`\`

Observed run log:

\`\`\`text
Started: 2026-06-01T16:11:25.037801
Project: D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp
Minimized existing windows before launching Godot.
Minimized existing windows before recording.
Kept Godot window topmost for recording: False
Focused window region: {'left': 629, 'top': 359, 'width': 1302, 'height': 776}
Capture region: focused Godot window
Recording: D:\\OpenClawWorkspace\\jobs\\game\\results\\roguelike_auto_chess_recording_20260601_160900\\recording.mp4
Video probe: {'duration_seconds': 0.16666666666666666, 'frame_count': 10, 'average_fps': 60.0}
Finished: 2026-06-01T16:11:41.045487
\`\`\`

Relevant runner code excerpts:

\`\`\`python
capture = request.get("capture", {})
wants_screenshot = bool(capture.get("screenshot", True))
wants_video = bool(capture.get("video", False))
startup_wait_seconds = float(request.get("startup_wait_seconds", 2 if wants_video else wait_seconds))
record_seconds = float(request.get("record_seconds", wait_seconds))
record_fps = int(request.get("record_fps", DEFAULT_RECORD_FPS))
record_width = int(request.get("record_width", DEFAULT_RECORD_WIDTH))
record_height = int(request.get("record_height", DEFAULT_RECORD_HEIGHT))
\`\`\`

\`\`\`python
if output_path.suffix.lower() == ".mp4" and region is None and not force_python_capture:
    try:
        if record_screen_with_ffmpeg(output_path, duration_seconds, fps, max_width, max_height):
            return output_path
    except Exception as exc:
        print(f"Native MP4 recording failed; using Python AVI fallback: {exc}")

frames = []
frame_interval = 1.0 / fps
end_at = next_frame_at + duration_seconds
...
while time.monotonic() < end_at:
    ...
    img = sct.grab(monitor)
    frames.append(...)
...
write_uncompressed_avi(avi_path, frames, width, target_height, fps)
\`\`\`

\`\`\`python
capture_region = get_window_capture_region(hwnd)
if capture_region:
    log_lines.append(f"Focused window region: {capture_region}")
    log_lines.append("Capture region: focused Godot window")
else:
    log_lines.append("Capture region: full monitor")

actual_recording_path = record_screen(
    recording_path,
    record_seconds,
    record_fps,
    record_width,
    record_height,
    capture_region,
)
\`\`\`

Your answer should:
- identify the likely root cause or causes;
- explain why the observed duration is so short;
- recommend concrete code-level fixes;
- avoid saying you checked anything beyond the evidence above;
- avoid promising to run more checks.`;

function usage() {
  return `Usage: node scripts/qwen-godot-debug-single-step.mjs [options]

Runs repeated one-turn OpenClaw + Qwen Godot recording debugging sessions.

Options:
  --runs <n>                  Number of runs (default: 10)
  --model <provider/model>    Model override (default: ${DEFAULT_MODEL})
  --timeout <seconds>         OpenClaw agent timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --session-prefix <prefix>   Session key prefix (default: qwen-godot-debug-single)
  --docker-container <name>   Docker container with openclaw CLI (default: ${DEFAULT_CONTAINER})
  --openclaw-bin <path>       OpenClaw executable inside container (default: openclaw)
  --prompt-output <path>      Write the exact evidence-only prompt
  --output <path>             Write JSON summary
  --help                      Show this help
`;
}

function parseArgs(argv) {
  const options = {
    runs: 10,
    model: process.env.OPENCLAW_QWEN_SCENARIO_MODEL || DEFAULT_MODEL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    sessionPrefix: "qwen-godot-debug-single",
    dockerContainer: process.env.OPENCLAW_QWEN_SCENARIO_CONTAINER || DEFAULT_CONTAINER,
    openclawBin: "openclaw",
    outputPath: "",
    promptOutputPath: "",
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
      options.runs = Number.parseInt(readValue(), 10);
      if (!Number.isFinite(options.runs) || options.runs <= 0) {
        throw new Error("--runs must be a positive integer");
      }
    } else if (arg === "--model") {
      options.model = readValue();
    } else if (arg === "--timeout") {
      options.timeoutSeconds = Number.parseInt(readValue(), 10);
      if (!Number.isFinite(options.timeoutSeconds) || options.timeoutSeconds <= 0) {
        throw new Error("--timeout must be a positive integer");
      }
    } else if (arg === "--session-prefix") {
      options.sessionPrefix = readValue();
    } else if (arg === "--docker-container") {
      options.dockerContainer = readValue();
    } else if (arg === "--openclaw-bin") {
      options.openclawBin = readValue();
    } else if (arg === "--output") {
      options.outputPath = path.resolve(readValue());
    } else if (arg === "--prompt-output") {
      options.promptOutputPath = path.resolve(readValue());
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

function scoreBool(value, points) {
  return value ? points : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function extractBlockedAttempt(text) {
  const match = String(text ?? "").match(/blocked attempted next step was:\s*"([\s\S]*?)"/i);
  return match?.[1] ?? "";
}

function qualitySignals(text) {
  const lower = String(text ?? "").toLowerCase();
  const nestedCapture =
    lower.includes("capture.record_seconds") ||
    lower.includes("capture.fps") ||
    lower.includes("capture.width") ||
    lower.includes("capture.height") ||
    (lower.includes("nested") && lower.includes("capture")) ||
    (lower.includes("top-level") && lower.includes("capture"));
  const regionBypass =
    lower.includes("region") &&
    (lower.includes("ffmpeg") || lower.includes("python") || lower.includes("mss"));
  const frameMath =
    lower.includes("10 / 60") ||
    lower.includes("10 frames") ||
    lower.includes("0.166") ||
    (lower.includes("frame_count") && lower.includes("fps"));
  const cfrFix =
    lower.includes("fps filter") ||
    lower.includes("fps=") ||
    lower.includes("constant") ||
    lower.includes("cfr") ||
    lower.includes("duplicate") ||
    lower.includes("output fps");
  const concreteFix =
    lower.includes("read nested") ||
    lower.includes("capture.record_seconds") ||
    lower.includes("window_region") ||
    lower.includes("region=none") ||
    lower.includes("full monitor") ||
    lower.includes("ffmpeg") ||
    lower.includes("fps=");
  const noFuturePromise = !/\b(?:let me|i(?:'|’)?ll|i will|i need to|now let me)\s+(?:check|inspect|read|run|look|wait|poll|debug)\b/i.test(
    text,
  );
  return {
    nestedCapture,
    regionBypass,
    frameMath,
    cfrFix,
    concreteFix,
    noFuturePromise,
    mentionsDone: lower.includes("done") || lower.includes("requests_done"),
    mentionsProbe: lower.includes("video_probe") || lower.includes("frame_count"),
  };
}

function looksLikeConservativeFinalizationFallback(text) {
  const lower = String(text ?? "").toLowerCase();
  return (
    lower.includes("debugging conclusion: the run reached finalization") ||
    lower.includes("blocked attempted next step") ||
    lower.includes("recommended next change: run one explicit follow-up tool turn")
  );
}

function scoreDebugAnswer(text, { conservativeFallback = false, rawGuardrailVisible = false, timedOut = false } = {}) {
  const signals = qualitySignals(text);
  let score =
    scoreBool(String(text ?? "").trim().length >= 180, 8) +
    scoreBool(signals.mentionsDone, 8) +
    scoreBool(signals.mentionsProbe, 8) +
    scoreBool(signals.nestedCapture, 22) +
    scoreBool(signals.regionBypass, 22) +
    scoreBool(signals.frameMath, 12) +
    scoreBool(signals.concreteFix, 14) +
    scoreBool(signals.cfrFix, 6) +
    scoreBool(signals.noFuturePromise, 8);
  const penalties = [];
  if (conservativeFallback) {
    score -= 20;
    penalties.push({
      reason: "conservative_finalization_fallback",
      points: -20,
      note: "The user-visible answer came from the conservative guardrail fallback.",
    });
  }
  if (rawGuardrailVisible) {
    score -= 30;
    penalties.push({
      reason: "raw_guardrail_visible",
      points: -30,
      note: "Raw guardrail implementation text was visible to the user.",
    });
  }
  if (timedOut) {
    score -= 30;
    penalties.push({ reason: "timeout", points: -30, note: "The turn timed out." });
  }
  if (!signals.nestedCapture && !signals.regionBypass) {
    score -= 10;
    penalties.push({
      reason: "missed_core_causes",
      points: -10,
      note: "The answer missed both core causes: nested capture fields and region capture bypass.",
    });
  }
  score = clamp(score, 0, 100);
  return {
    score,
    grade: score >= 85 ? "excellent" : score >= 70 ? "good" : score >= 55 ? "usable" : score >= 40 ? "weak" : "poor",
    signals,
    penalties,
    excerpt: String(text ?? "").trim().slice(0, 1500),
  };
}

function classify(response, processResult) {
  const text = collectPayloadText(response);
  const lower = text.toLowerCase();
  const result = response?.result ?? response ?? {};
  const meta = result.meta ?? {};
  const toolCalls = Number(meta.toolSummary?.calls ?? 0);
  const finalizationFallback = Boolean(
    meta.executionTrace?.attempts?.some(
      (attempt) => attempt.reason === "tool_intent_guardrail_finalization_fallback",
    ),
  );
  const statusOk = processResult.code === 0 && response?.status === "ok";
  const checks = {
    statusOk,
    timeout: processResult.timedOut === true,
    toolCalls,
    finalizationFallback,
    rawGuardrailVisible: lower.includes("tool-intent guardrail:"),
    mentionsNestedCapture:
      lower.includes("capture.record_seconds") ||
      lower.includes("capture.fps") ||
      lower.includes("nested"),
    mentionsRegionBypass:
      lower.includes("region") &&
      (lower.includes("ffmpeg") || lower.includes("python") || lower.includes("mss")),
    mentionsFrameMath:
      lower.includes("10 / 60") ||
      lower.includes("10 frames") ||
      lower.includes("0.166") ||
      lower.includes("frame_count"),
    mentionsCfrFix:
      lower.includes("fps filter") ||
      lower.includes("fps=") ||
      lower.includes("constant") ||
      lower.includes("cfr"),
    hasConcreteFix: lower.includes("fix") || lower.includes("change") || lower.includes("read nested"),
  };
  const blockedAttempt = extractBlockedAttempt(text);
  const conservativeFinalizationFallback =
    finalizationFallback && looksLikeConservativeFinalizationFallback(text);
  const salvagedFinalizationFallback = finalizationFallback && !conservativeFinalizationFallback;
  const visibleQuality = scoreDebugAnswer(text, {
    conservativeFallback: conservativeFinalizationFallback,
    rawGuardrailVisible: checks.rawGuardrailVisible,
    timedOut: checks.timeout,
  });
  const attemptedQuality = blockedAttempt
    ? scoreDebugAnswer(blockedAttempt, {
        fallback: false,
        rawGuardrailVisible: false,
        timedOut: false,
      })
    : null;
  const ok =
    checks.statusOk && !checks.timeout && !checks.rawGuardrailVisible && visibleQuality.score >= 70;
  return {
    ok,
    checks,
    quality: {
      visible: visibleQuality,
      attempted: attemptedQuality,
      guardrailImpact: {
        finalizationFallback,
        conservativeFinalizationFallback,
        salvagedFinalizationFallback,
        blockedAttemptAvailable: Boolean(blockedAttempt),
        visibleMinusAttempted:
          attemptedQuality == null ? null : visibleQuality.score - attemptedQuality.score,
      },
    },
    payloadText: text.slice(0, 8000),
    blockedAttemptText: blockedAttempt.slice(0, 4000),
    executionTrace: meta.executionTrace,
    durationMs: meta.durationMs,
    sessionFile: meta.agentMeta?.sessionFile,
  };
}

function commandForRun(options, sessionKey) {
  return {
    command: "docker",
    args: [
      "exec",
      options.dockerContainer,
      options.openclawBin,
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
      evidencePrompt,
    ],
  };
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, ".artifacts", "qwen-godot-debug-single", `${stamp}.json`);
}

function writeText(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function writeJson(filePath, data) {
  writeText(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function summarizeResults(results) {
  const scores = results.map((result) => result.classification.quality.visible.score);
  const attemptedScores = results
    .map((result) => result.classification.quality.attempted?.score)
    .filter((score) => Number.isFinite(score));
  const average = (values) =>
    values.length
      ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2))
      : null;
  const sorted = [...scores].sort((a, b) => a - b);
  const count = (predicate) => results.filter(predicate).length;
  return {
    total: results.length,
    pass: count((result) => result.ok),
    partial: count((result) => !result.ok),
    visibleAverage: average(scores),
    visibleMin: sorted[0] ?? null,
    visibleMax: sorted[sorted.length - 1] ?? null,
    attemptedAverage: average(attemptedScores),
    finalizationFallback: count(
      (result) => result.classification.quality.guardrailImpact.finalizationFallback,
    ),
    conservativeFinalizationFallback: count(
      (result) =>
        result.classification.quality.guardrailImpact.conservativeFinalizationFallback,
    ),
    salvagedFinalizationFallback: count(
      (result) => result.classification.quality.guardrailImpact.salvagedFinalizationFallback,
    ),
    blockedAttemptAvailable: count(
      (result) => result.classification.quality.guardrailImpact.blockedAttemptAvailable,
    ),
    rawGuardrailVisible: count((result) => result.classification.checks.rawGuardrailVisible),
    timedOut: count((result) => result.classification.checks.timeout),
    goodOrBetter: count((result) => result.classification.quality.visible.score >= 70),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const outputPath = options.outputPath || defaultOutputPath();
  if (options.promptOutputPath) {
    writeText(options.promptOutputPath, evidencePrompt);
  }
  const runId = Date.now().toString(36);
  const startedAt = new Date().toISOString();
  const results = [];
  for (let index = 1; index <= options.runs; index += 1) {
    const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${index}-${runId}`;
    process.stdout.write(`single-step ${index}/${options.runs} session=${sessionKey}\n`);
    const command = commandForRun(options, sessionKey);
    const started = Date.now();
    const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
    const response = parseAgentJson(processResult.stdout);
    const classification = classify(response, processResult);
    const result = {
      runIndex: index,
      sessionKey,
      ok: classification.ok,
      process: {
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        durationMs: Date.now() - started,
        stderrTail: processResult.stderr.slice(-3000),
      },
      classification,
      rawJsonParsed: Boolean(response),
    };
    results.push(result);
    writeJson(outputPath, {
      ok: results.length === options.runs && results.every((entry) => entry.ok),
      generatedAt: new Date().toISOString(),
      startedAt,
      host: os.hostname(),
      model: options.model,
      dockerContainer: options.dockerContainer,
      prompt: evidencePrompt,
      summary: summarizeResults(results),
      results,
    });
    process.stdout.write(
      `single-step ${index}/${options.runs} ${result.ok ? "PASS" : "PARTIAL"} visibleScore=${classification.quality.visible.score} attemptedScore=${classification.quality.attempted?.score ?? "n/a"} checks=${JSON.stringify(classification.checks)}\n`,
    );
  }
  process.stdout.write(`qwen-godot-debug-single-step: summary ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `qwen-godot-debug-single-step: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
