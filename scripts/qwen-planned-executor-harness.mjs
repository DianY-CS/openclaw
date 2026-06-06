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
const DEFAULT_TIMEOUT_SECONDS = 420;
const DEFAULT_MAX_EXECUTOR_TURNS = 4;
const DEFAULT_GODOT_SKILL_PATH = "D:\\OpenClawWorkspace\\skills\\godot-runner\\SKILL.md";
const DEFAULT_RECORDING_TIMEOUT_SECONDS = 240;
let activeReportContext = null;

function extractSkillSection(skillText) {
  const marker = "## Qwen Execution Mode";
  const start = skillText.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const rest = skillText.slice(start);
  const nextSection = rest.slice(marker.length).search(/\n##\s+/u);
  const section =
    nextSection >= 0 ? rest.slice(0, marker.length + nextSection).trim() : rest.trim();
  return section.slice(0, 6000);
}

function buildExecutionPacketPrompt(runTag, skillText) {
  const jobId = `qwen_executor_godot_recording_${runTag}`;
  return `You are the EXECUTOR model in a planner-executor-reviewer test.

The senior planner has already designed the task. Do not redesign it. Do not ask the user a question. Execute the packet exactly, using tools when filesystem inspection or file creation is required.

This is a fresh, isolated execution packet. Ignore any apparent prior packet, transcript example, or earlier job id. Do not continue a godotRecording packet, POLL_STATUS packet, WAIT_AND_VALIDATE_RECORDING packet, or delivery packet. Your only active packet is CREATE_REQUEST_ONLY with job_id ${jobId}.

Skill summary for this packet:

- The planner selected the Godot runner workflow.
- In this benchmark packet, your only job is to create and validate one Windows host-runner request JSON.
- The harness, not you, will wait for recording.mp4, inspect video_probe.json, validate the recording, and test delivery.
- Do not use Telegram, message, or recording-delivery tools in this packet.

Execution packet:

Execution packet type: CREATE_REQUEST_ONLY.

Goal:
- Create and validate exactly one Godot gameplay recording request for the workspace project games/roguelike_auto_chess_mvp.
- The requested video should be 15 seconds at 60fps.
- Your completion condition is only: request JSON exists in requests/ or requests_done/ and contains the required fields.
- Do not wait for the host runner to finish recording.
- Do not send anything to Telegram in this test.

Forbidden work:
- Do not read /home/node/.openclaw/workspace/jobs/game/results.
- Do not poll status.json.
- Do not inspect recording.mp4 or video_probe.json.
- Do not call message or any Telegram/send tool.
- Do not create a second request with a new job_id.
- Do not output a tool/action JSON as text. If file work is needed, call a tool.
- Do not mention or use any qwen_planned_godot_recording_* job id. Use only ${jobId}.

Allowed work:
1. Verify that the project exists by checking for:
   /home/node/.openclaw/workspace/games/roguelike_auto_chess_mvp/project.godot
2. Ensure this request directory exists:
   /home/node/.openclaw/workspace/jobs/game/requests
3. Create one JSON request file:
   /home/node/.openclaw/workspace/jobs/game/requests/${jobId}.json
4. The file content must be exactly this JSON object. Copy the Windows path exactly; do not replace backslashes with forward slashes:

\`\`\`json
{
  "job_id": "${jobId}",
  "action": "run_and_capture",
  "project_path": "D:\\\\OpenClawWorkspace\\\\games\\\\roguelike_auto_chess_mvp",
  "scene": "scenes/combat_sandbox.tscn",
  "wait_seconds": 6,
  "startup_wait_seconds": 6,
  "record_seconds": 15,
  "record_fps": 60,
  "record_width": 1920,
  "record_height": 1080,
  "capture": {
    "video": true,
    "screenshot": false,
    "record_seconds": 15,
    "fps": 60,
    "width": 1920,
    "height": 1080
  }
}
\`\`\`

5. After creating the file, verify that the file exists and that it contains valid JSON.
   Important: the Windows host runner may consume the request immediately and move it from requests/ to requests_done/. If ${jobId}.json is missing from requests/, check requests_done/${jobId}.json and requests_failed/${jobId}.json before declaring write failure.
6. Verify both top-level runner fields and nested capture fields are present. The Windows host runner uses the top-level record_seconds/record_fps/record_width/record_height fields for actual video duration and FPS. A valid request found in requests_done/ means the request was created successfully and accepted by the runner.

Execution style:
- Prefer one tool call that performs: project check, mkdir, request write, request/readback validation.
- After that tool call succeeds, stop. Return the final JSON only.
- Do not narrate intermediate future actions such as "now I will validate"; perform the validation inside the tool call.

Failure rules:
- If the project is missing, stop and report status "blocked".
- If the request cannot be created, stop and report status "failed".
- If a valid request file is found in requests_done/, report status "done" immediately because the host runner already accepted it.
- Never wait for recording output. Waiting for recording is outside this packet.

Final answer requirements:
- Start the final visible answer with exactly: RESPONSE_MODE: final
- Then output exactly one JSON object and no extra prose.
- Do not wrap the final JSON in a markdown code fence.
- The JSON object schema is:
{
  "status": "done | blocked | failed",
  "job_id": "${jobId}",
  "steps_completed": ["..."],
  "evidence": ["..."],
  "artifacts": ["..."],
  "blocker": null,
  "needs_planner_review": false
}

Important:
- If you need to inspect or write files, call tools. Do not merely say that you will do it.
- Do not write "let me", "I'll", "I will", or similar future-action promises in the final answer.
- Efficient execution hint: if possible, complete verification, directory creation, request writing, and JSON validation in one shell/tool call.`;
}

function buildReviewerContinuationPrompt(expectedJobId) {
  return `Reviewer correction for the same execution packet:

This is still CREATE_REQUEST_ONLY.

Continue executing the packet. Do not make a new plan. Do not ask a question. Use exactly this job_id: ${expectedJobId}

This is a fresh correction for CREATE_REQUEST_ONLY only. Ignore any other packet name or qwen_planned_godot_recording_* job id that appears in previous transcript text.

If the project was already verified, continue with the remaining steps:
1. ensure /home/node/.openclaw/workspace/jobs/game/requests exists;
2. create /home/node/.openclaw/workspace/jobs/game/requests/${expectedJobId}.json;
3. validate that the file exists and contains valid JSON. If it is not in requests/, check requests_done/${expectedJobId}.json and requests_failed/${expectedJobId}.json before reporting failure. A valid file in requests_done/ is success because the host runner already accepted it;
4. only then return RESPONSE_MODE: final followed by the required JSON object.

Forbidden work:
- Do not switch to a qwen_planned_godot_recording_* job_id from earlier text.
- Do not continue POLL_STATUS, WAIT_AND_VALIDATE_RECORDING, delivery, or full godotRecording work.
- Do not poll status.json.
- Do not read jobs/game/results.
- Do not inspect recording.mp4 or video_probe.json.
- Do not call message or any Telegram/send tool.
- Do not output { "path": ..., "content": ... } or { "action": ... } as plain text. If file work is needed, call a tool.

If you need to inspect or write files, call tools now. Do not answer with a promise about the next action.
Do not wrap the final JSON in a markdown code fence.`;
}

function buildExecutePrintedFileActionPrompt(expectedJobId, printedAction) {
  return `Reviewer recovery for the same execution packet:

Recovery phase: EXECUTE_PRINTED_FILE_ACTION.

In the previous turn, you printed a file action JSON as text instead of executing it with a tool. Now execute that printed file action. Do not make a new plan. Do not ask a question. Do not choose a new job_id.

Required file path:
${printedAction.path}

Required file content:
\`\`\`json
${printedAction.content}
\`\`\`

Allowed work:
1. Ensure the parent directory exists.
2. Write exactly the required file content to the required file path.
3. Read the file back or parse it once to confirm it is valid JSON.
4. If the file has already been moved to requests_done/${expectedJobId}.json by the host runner, treat that as success.

Forbidden work:
- Do not output { "path": ..., "content": ... } as text again.
- Do not poll status.json.
- Do not read jobs/game/results.
- Do not inspect recording.mp4 or video_probe.json.
- Do not call message or any Telegram/send tool.
- Do not create a second request with a different job_id.

If file work is needed, call tools now.

Final answer requirements:
- Start with exactly: RESPONSE_MODE: final
- Then output exactly one JSON object and no markdown fence.
- The JSON object must include:
{
  "status": "done | failed",
  "job_id": "${expectedJobId}",
  "steps_completed": ["..."],
  "evidence": ["..."],
  "artifacts": ["..."],
  "blocker": null,
  "needs_planner_review": false
}`;
}

function buildReviewerFinalReportPrompt(expectedJobId, verification) {
  const requestPath =
    verification.location ||
    `/home/node/.openclaw/workspace/jobs/game/requests/${expectedJobId}.json`;
  return `Reviewer completion gate for the same execution packet:

The request artifact has already been externally verified by the reviewer. Do not call tools. Do not inspect files again. Do not say "now validating".

Verified facts:
- job_id: ${expectedJobId}
- request_path: ${requestPath}
- request JSON is valid: ${verification.jsonValid ? "true" : "false"}
- capture settings are valid: ${verification.captureValid ? "true" : "false"}

Your only task now is to output the final report.

Start with exactly:
RESPONSE_MODE: final

Then output exactly one JSON object and no markdown fence:
{
  "status": "done",
  "job_id": "${expectedJobId}",
  "request_path": "${requestPath}",
  "validated": true,
  "steps_completed": [
    "verified project.godot",
    "created request JSON",
    "read request JSON back",
    "validated required fields"
  ],
  "artifacts": [
    "${requestPath}"
  ],
  "blocker": null,
  "needs_planner_review": false
}`;
}

function buildMockMediaDeliveryPrompt(expectedJobId, recordingResult) {
  const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
  const recordingPath = recordingResult.recording_path;
  const probe = recordingResult.probe ?? recordingResult.video_probe ?? recordingResult.status?.video_probe ?? {};
  const duration = Number(probe.duration_seconds ?? 0);
  const fps = Number(probe.average_fps ?? 0);
  const frameCount = Number(probe.frame_count ?? 0);
  return `You are the EXECUTOR model in a mock media-delivery test.

The senior planner already validated the video file. Your only task is to write one JSON receipt file.

Do not send a real message. Do not redesign the task. Do not ask the user a question. Do not output a JSON action as text instead of using tools.

Validated media facts:
- job_id: ${expectedJobId}
- recording_path: ${recordingPath}
- mime_type: video/mp4
- duration_seconds: ${duration}
- average_fps: ${fps}
- frame_count: ${frameCount}

Mock media delivery receipt:
- Write this exact JSON object to:
  ${receiptPath}
- Create the parent directory if needed.
- After writing it, read it back and verify it is valid JSON.

Required JSON object:
{
  "action": "send",
  "target": "current_session",
  "message": "Validated gameplay video\\nJob: ${expectedJobId}\\n15s 60fps validation passed",
  "media": {
    "path": "${recordingPath}",
    "mimeType": "video/mp4"
  },
  "validation": {
    "job_id": "${expectedJobId}",
    "duration_seconds": ${duration},
    "average_fps": ${fps},
    "frame_count": ${frameCount}
  }
}

Final answer requirements:
- Start the final visible answer with exactly: RESPONSE_MODE: final
- Then output exactly one JSON object and no extra prose.
- Do not wrap the final JSON in a markdown code fence.
- The JSON object schema is:
{
  "status": "done | failed",
  "job_id": "${expectedJobId}",
  "mock_delivery_receipt": "${receiptPath}",
  "steps_completed": ["created mock media delivery receipt", "validated mock media delivery receipt"],
  "blocker": null
}

Important:
- If you need to write or inspect files, call tools. Do not merely say that you will do it.
- The task is not complete until the receipt file exists at ${receiptPath} and has been read back.
- Do not write "let me", "I'll", "I will", or similar future-action promises in the final answer.`;
}

function buildMockMediaDeliveryRetryPrompt(expectedJobId, recordingResult) {
  const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
  const recordingPath = recordingResult.recording_path;
  const probe = recordingResult.probe ?? recordingResult.video_probe ?? recordingResult.status?.video_probe ?? {};
  const duration = Number(probe.duration_seconds ?? 0);
  const fps = Number(probe.average_fps ?? 0);
  const frameCount = Number(probe.frame_count ?? 0);
  return `Reviewer correction for the same execution packet:

This is still DELIVER_RECORDING_OR_MOCK_MEDIA.

The previous answer was not accepted because the evaluator did not observe a valid mock media delivery receipt created by tool use.

Do not create a Godot request. Do not wait for recording. Do not send a real Telegram message. Do not ask a question.

Use tools now to:
1. ensure /home/node/.openclaw/workspace/jobs/mock_media_deliveries exists;
2. write exactly this JSON object to ${receiptPath};
3. read ${receiptPath} back and confirm it is valid JSON;
4. return RESPONSE_MODE: final followed by the final JSON object.

Required receipt JSON:
{
  "action": "send",
  "target": "current_session",
  "message": "Validated gameplay video\\nJob: ${expectedJobId}\\n15s 60fps validation passed",
  "media": {
    "path": "${recordingPath}",
    "mimeType": "video/mp4"
  },
  "validation": {
    "job_id": "${expectedJobId}",
    "duration_seconds": ${duration},
    "average_fps": ${fps},
    "frame_count": ${frameCount}
  }
}

Final answer requirements:
- Start with exactly: RESPONSE_MODE: final
- Then output exactly one JSON object and no markdown fence.
- The JSON object must include:
{
  "status": "done | failed",
  "job_id": "${expectedJobId}",
  "mock_delivery_receipt": "${receiptPath}",
  "steps_completed": ["created mock media delivery receipt", "validated mock media delivery receipt"],
  "blocker": null
}

If file work is needed, call tools now. Do not answer with a promise about the next action.`;
}

function buildWaitValidateRecordingPrompt(expectedJobId, recordingResult) {
  const resultDir = recordingResult.result_dir;
  return `You are the EXECUTOR model in a planner-executor-reviewer test.

Execution packet type: WAIT_AND_VALIDATE_RECORDING.

The senior planner has already created a Godot runner request. Your only task is to inspect the completed recording result and decide whether the video satisfies the requested 15-second 60fps requirement.

Known job_id:
${expectedJobId}

Result directory to inspect:
${resultDir}

Files to inspect:
- ${resultDir}/status.json
- ${resultDir}/video_probe.json
- ${resultDir}/recording.mp4

Validation rules:
- status.json must report status "done".
- recording.mp4 must exist.
- video_probe.json, or status.json video_probe, must show duration_seconds >= 14.5.
- average_fps must be between 59 and 61.
- frame_count must be >= 870.

Allowed work:
1. Read status.json.
2. Read video_probe.json.
3. Check that recording.mp4 exists.
4. Return a structured verdict.

Forbidden work:
- Do not create a request JSON.
- Do not run Godot.
- Do not inspect or edit project files.
- Do not call message or any Telegram/send tool.
- Do not output an action JSON as text. If file inspection is needed, call tools.

Final answer requirements:
- Start with exactly: RESPONSE_MODE: final
- Then output exactly one JSON object and no markdown fence.
- The JSON object shape is below. Replace ACTUAL_* placeholders with values read from status.json, video_probe.json, and the recording file check:
{
  "status": "done | failed",
  "job_id": "${expectedJobId}",
  "recording_valid": true | false,
  "status_path": "${resultDir}/status.json",
  "video_probe_path": "${resultDir}/video_probe.json",
  "recording_path": "${resultDir}/recording.mp4",
  "duration_seconds": ACTUAL_DURATION_SECONDS,
  "average_fps": ACTUAL_AVERAGE_FPS,
  "frame_count": ACTUAL_FRAME_COUNT,
  "checks": {
    "status_done": true | false,
    "recording_exists": true | false,
    "duration_ok": true | false,
    "fps_ok": true | false,
    "frame_count_ok": true | false
  },
  "evidence": ["..."],
  "blocker": null,
  "needs_planner_review": false
}

Important:
- If you need to inspect files, call tools. Do not merely say that you will do it.
- A final answer without at least one tool call is invalid for this phase, even if the JSON looks correct.
- Do not infer duration_seconds, average_fps, frame_count, or recording_exists from the schema; only use values observed from files.
- Do not write "let me", "I'll", "I will", or similar future-action promises in the final answer.`;
}

function buildWaitValidateRecordingRetryPrompt(expectedJobId, recordingResult) {
  const resultDir = recordingResult.result_dir;
  return `Reviewer correction for WAIT_AND_VALIDATE_RECORDING:

Your previous answer was not accepted because the evaluator did not observe a real tool call for file inspection.

Do not make a new plan. Do not ask a question. Do not create requests. Do not run Godot. Do not send messages.

Now do exactly this:
1. Call tools to read ${resultDir}/status.json.
2. Call tools to read ${resultDir}/video_probe.json.
3. Call tools to check that ${resultDir}/recording.mp4 exists.
4. Return RESPONSE_MODE: final and one JSON verdict.

Known job_id:
${expectedJobId}

Validation thresholds:
- status must be "done".
- duration_seconds >= 14.5.
- average_fps between 59 and 61.
- frame_count >= 870.
- recording.mp4 exists.

Final JSON shape:
{
  "status": "done | failed",
  "job_id": "${expectedJobId}",
  "recording_valid": true | false,
  "status_path": "${resultDir}/status.json",
  "video_probe_path": "${resultDir}/video_probe.json",
  "recording_path": "${resultDir}/recording.mp4",
  "duration_seconds": ACTUAL_DURATION_SECONDS,
  "average_fps": ACTUAL_AVERAGE_FPS,
  "frame_count": ACTUAL_FRAME_COUNT,
  "checks": {
    "status_done": true | false,
    "recording_exists": true | false,
    "duration_ok": true | false,
    "fps_ok": true | false,
    "frame_count_ok": true | false
  },
  "evidence": ["..."],
  "blocker": null,
  "needs_planner_review": false
}`;
}

function usage() {
  return `Usage: node scripts/qwen-planned-executor-harness.mjs [options]

Runs a planner-executor-reviewer style OpenClaw + Qwen execution benchmark and records
prompt/usage metrics by turn, phase, and model.

Options:
  --runs <n>                  Number of runs (default: 3)
  --phase <phase>             rewrite-smoke, create-request, wait-validate-recording, deliver-recording-or-mock-media, or full-e2e (default: create-request)
  --model <provider/model>    Model override (default: ${DEFAULT_MODEL})
  --timeout <seconds>         Per OpenClaw agent turn timeout (default: ${DEFAULT_TIMEOUT_SECONDS})
  --session-prefix <prefix>   Session key prefix (default: qwen-planned-executor)
  --docker-container <name>   Docker container with openclaw CLI (default: ${DEFAULT_CONTAINER})
  --openclaw-bin <path>       OpenClaw executable inside container (default: openclaw)
  --max-executor-turns <n>    Reviewer continuation turns per run (default: ${DEFAULT_MAX_EXECUTOR_TURNS})
  --godot-skill-path <path>   godot-runner SKILL.md to inject (default: ${DEFAULT_GODOT_SKILL_PATH})
  --wait-recording            Wait for host runner result and validate recording.mp4
  --recording-timeout <sec>   Max seconds to wait for recording result (default: ${DEFAULT_RECORDING_TIMEOUT_SECONDS})
  --delivery-mode <mode>      none, simulate, mock-media, mock-media-tool, or telegram (default: none)
  --prompt-output <path>      Write the prompt from the first run
  --output <path>             Write JSON summary
  --help                      Show this help
`;
}

function parseArgs(argv) {
  const options = {
    runs: 3,
    phase: "create-request",
    model: process.env.OPENCLAW_QWEN_SCENARIO_MODEL || DEFAULT_MODEL,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    sessionPrefix: "qwen-planned-executor",
    dockerContainer: process.env.OPENCLAW_QWEN_SCENARIO_CONTAINER || DEFAULT_CONTAINER,
    openclawBin: "openclaw",
    maxExecutorTurns: DEFAULT_MAX_EXECUTOR_TURNS,
    godotSkillPath: DEFAULT_GODOT_SKILL_PATH,
    waitRecording: false,
    recordingTimeoutSeconds: DEFAULT_RECORDING_TIMEOUT_SECONDS,
    deliveryMode: "none",
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
    } else if (arg === "--phase") {
      options.phase = readValue();
      if (
        ![
          "rewrite-smoke",
          "create-request",
          "wait-validate-recording",
          "deliver-recording-or-mock-media",
          "full-e2e",
        ].includes(options.phase)
      ) {
        throw new Error(
          "--phase must be rewrite-smoke, create-request, wait-validate-recording, deliver-recording-or-mock-media, or full-e2e",
        );
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
    } else if (arg === "--max-executor-turns") {
      options.maxExecutorTurns = Number.parseInt(readValue(), 10);
      if (!Number.isFinite(options.maxExecutorTurns) || options.maxExecutorTurns <= 0) {
        throw new Error("--max-executor-turns must be a positive integer");
      }
    } else if (arg === "--godot-skill-path") {
      options.godotSkillPath = path.resolve(readValue());
    } else if (arg === "--wait-recording") {
      options.waitRecording = true;
    } else if (arg === "--recording-timeout") {
      options.recordingTimeoutSeconds = Number.parseInt(readValue(), 10);
      if (
        !Number.isFinite(options.recordingTimeoutSeconds) ||
        options.recordingTimeoutSeconds <= 0
      ) {
        throw new Error("--recording-timeout must be a positive integer");
      }
    } else if (arg === "--delivery-mode") {
      options.deliveryMode = readValue();
      if (
        !["none", "simulate", "mock-media", "mock-media-tool", "telegram"].includes(
          options.deliveryMode,
        )
      ) {
        throw new Error(
          "--delivery-mode must be none, simulate, mock-media, mock-media-tool, or telegram",
        );
      }
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });
}

function parseAgentJson(stdout) {
  const trimmed = String(stdout ?? "").trim();
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

function estimateTokensFromChars(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function buildPromptMetrics(prompt, phase) {
  const text = String(prompt ?? "");
  return {
    phase,
    chars: text.length,
    estimatedTokens: estimateTokensFromChars(text),
    lines: text ? text.split(/\r?\n/u).length : 0,
  };
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const numberValue = (...values) => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
      }
    }
    return 0;
  };
  const input = numberValue(raw.input, raw.input_tokens, raw.prompt_tokens);
  const output = numberValue(raw.output, raw.output_tokens, raw.completion_tokens);
  const cacheRead = numberValue(
    raw.cacheRead,
    raw.cache_read_input_tokens,
    raw.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = numberValue(raw.cacheWrite, raw.cache_creation_input_tokens);
  const reasoningTokens = numberValue(
    raw.reasoningTokens,
    raw.completion_tokens_details?.reasoning_tokens,
  );
  const totalTokens = numberValue(
    raw.totalTokens,
    raw.total_tokens,
    raw.total,
    input + output + cacheRead + cacheWrite,
  );
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoningTokens,
    totalTokens,
  };
}

function emptyUsageTotals() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(total, usage) {
  const next = { ...total };
  for (const key of Object.keys(next)) {
    next[key] += Number(usage?.[key] ?? 0);
  }
  return next;
}

function diffUsage(after, before) {
  const next = emptyUsageTotals();
  for (const key of Object.keys(next)) {
    next[key] = Math.max(0, Number(after?.[key] ?? 0) - Number(before?.[key] ?? 0));
  }
  return next;
}

function diffUsageByModel(after = {}, before = {}) {
  const modelKeys = new Set([...Object.keys(after ?? {}), ...Object.keys(before ?? {})]);
  const result = {};
  for (const modelKey of modelKeys) {
    const afterEntry = after?.[modelKey] ?? {};
    const beforeEntry = before?.[modelKey] ?? {};
    const assistantCalls = Math.max(
      0,
      Number(afterEntry.assistantCalls ?? 0) - Number(beforeEntry.assistantCalls ?? 0),
    );
    const totals = diffUsage(afterEntry.totals, beforeEntry.totals);
    if (assistantCalls > 0 || usageHasAnyTokens(totals)) {
      result[modelKey] = {
        assistantCalls,
        totals,
      };
    }
  }
  return result;
}

function usageHasAnyTokens(usage) {
  return Object.values(usage ?? {}).some((value) => typeof value === "number" && value > 0);
}

async function readTranscriptUsageSnapshot(options, sessionFile) {
  if (!sessionFile) {
    return {
      available: false,
      sessionFile: null,
      error: "no sessionFile in agent metadata",
      assistantCalls: 0,
      totals: emptyUsageTotals(),
      byModel: {},
    };
  }
  const script = `cat ${JSON.stringify(sessionFile)}`;
  const processResult = await runProcess(
    "docker",
    ["exec", options.dockerContainer, "sh", "-lc", script],
    30,
  );
  if (processResult.code !== 0) {
    return {
      available: false,
      sessionFile,
      error: processResult.stderr.trim() || `docker exec exited with ${processResult.code}`,
      assistantCalls: 0,
      totals: emptyUsageTotals(),
      byModel: {},
    };
  }
  const totals = emptyUsageTotals();
  const byModel = {};
  let assistantCalls = 0;
  for (const line of processResult.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = parsed?.message;
    if (message?.role !== "assistant") {
      continue;
    }
    const usage = normalizeUsage(message.usage);
    if (!usage || !usageHasAnyTokens(usage)) {
      continue;
    }
    assistantCalls += 1;
    Object.assign(totals, addUsage(totals, usage));
    const modelKey = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    byModel[modelKey] ??= {
      assistantCalls: 0,
      totals: emptyUsageTotals(),
    };
    byModel[modelKey].assistantCalls += 1;
    byModel[modelKey].totals = addUsage(byModel[modelKey].totals, usage);
  }
  return {
    available: true,
    sessionFile,
    assistantCalls,
    totals,
    byModel,
  };
}

function extractJsonObject(text) {
  const withoutMode = String(text ?? "")
    .replace(/^\s*RESPONSE_MODE\s*:\s*final\s*/iu, "")
    .trim();
  const firstJson = withoutMode.indexOf("{");
  const lastJson = withoutMode.lastIndexOf("}");
  if (firstJson < 0 || lastJson < firstJson) {
    return null;
  }
  try {
    return JSON.parse(withoutMode.slice(firstJson, lastJson + 1));
  } catch {
    return null;
  }
}

function looksLikeUnresolvedToolIntent(text) {
  return /(?:^|[.!?。！？,;]\s+|[:：]\s*\r?\n\s*|[\u2013\u2014-]\s+)(?:but\s+|so\s+)?(?:now\s+)?(?:let me|i(?:'|’)?ll|i\s+(?:will|should|need to|am going to))\s+(?:also\s+|first\s+|now\s+|next\s+|actually\s+|continue\s+to\s+)?(?:read|inspect|examine|review|trace|find|check|search|wait|debug|look|start|restart|run|execute|call|open|edit|write|create|dispatch|verify|send|deliver)\b[^.!?。！？]*(?::|[.!?。！？])?\s*$/iu.test(
    String(text ?? ""),
  );
}

function scoreExecutorChecks(checks) {
  let score = 0;
  score += checks.statusOk ? 8 : 0;
  score += checks.toolCalls > 0 ? 15 : 0;
  score += checks.finalJsonValid ? 10 : 0;
  score += checks.statusDone ? 8 : 0;
  score += checks.expectedJobId ? 8 : 0;
  score += checks.projectVerified ? 8 : 0;
  score += checks.requestArtifact ? 7 : 0;
  score += checks.nestedCapture ? 5 : 0;
  score += checks.externalArtifactExists ? 15 : 0;
  score += checks.externalJsonValid ? 8 : 0;
  score += checks.externalCaptureValid ? 12 : 0;
  score += checks.noCompletionClaim ? 2 : 0;
  score += checks.noFuturePromise ? 2 : 0;
  if (checks.timedOut) {
    score -= 25;
  }
  if (checks.rawGuardrailVisible) {
    score -= 30;
  }
  return Math.max(0, Math.min(100, score));
}

function classify(response, processResult, expectedJobId, aggregate = {}) {
  const text = collectPayloadText(response);
  const lower = text.toLowerCase();
  const result = response?.result ?? response ?? {};
  const meta = result.meta ?? {};
  const currentToolCalls = Number(meta.toolSummary?.calls ?? 0);
  const toolCalls = currentToolCalls + Number(aggregate.previousToolCalls ?? 0);
  const tools = Array.from(
    new Set([...(aggregate.previousTools ?? []), ...(meta.toolSummary?.tools ?? [])]),
  );
  const finalJson = extractJsonObject(text);
  const statusOk = processResult.code === 0 && response?.status === "ok";
  const timedOut = processResult.timedOut === true;
  const rawGuardrailVisible = lower.includes("tool-intent guardrail:");
  const finalizationFallback = Boolean(
    meta.executionTrace?.attempts?.some(
      (attempt) => attempt.reason === "tool_intent_guardrail_finalization_fallback",
    ),
  );
  const unresolvedToolIntent = looksLikeUnresolvedToolIntent(text);
  const artifacts = Array.isArray(finalJson?.artifacts) ? finalJson.artifacts.join("\n") : "";
  const evidence = Array.isArray(finalJson?.evidence) ? finalJson.evidence.join("\n") : "";
  const allReportedText = `${text}\n${artifacts}\n${evidence}`.toLowerCase();
  const checks = {
    statusOk,
    timedOut,
    toolCalls,
    currentToolCalls,
    tools,
    finalizationFallback,
    rawGuardrailVisible,
    unresolvedToolIntent,
    finalJsonValid: Boolean(finalJson),
    statusDone: finalJson?.status === "done",
    expectedJobId: finalJson?.job_id === expectedJobId,
    projectVerified:
      allReportedText.includes("project.godot") ||
      allReportedText.includes("roguelike_auto_chess_mvp"),
    requestArtifact:
      allReportedText.includes(`${expectedJobId}.json`) ||
      allReportedText.includes("/jobs/game/requests") ||
      allReportedText.includes("jobs\\game\\requests"),
    nestedCapture:
      allReportedText.includes("capture.record_seconds") ||
      allReportedText.includes("record_seconds") ||
      allReportedText.includes("\"fps\"") ||
      allReportedText.includes("60"),
    externalArtifactExists: false,
    externalJsonValid: false,
    externalCaptureValid: false,
    noCompletionClaim:
      !/\b(recording|video)\s+(?:is\s+)?(?:complete|done|sent|delivered|uploaded)\b/iu.test(text),
    noFuturePromise: !unresolvedToolIntent,
  };
  const score = scoreExecutorChecks(checks);
  const ok =
    score >= 75 &&
    checks.statusOk &&
    toolCalls > 0 &&
    checks.finalJsonValid &&
    checks.statusDone &&
    checks.expectedJobId &&
    checks.requestArtifact &&
    checks.externalArtifactExists &&
    checks.externalJsonValid &&
    checks.externalCaptureValid &&
    !checks.rawGuardrailVisible &&
    !checks.unresolvedToolIntent;
  const artifactOk =
    checks.statusOk &&
    toolCalls > 0 &&
    checks.externalArtifactExists &&
    checks.externalJsonValid &&
    checks.externalCaptureValid &&
    !checks.rawGuardrailVisible;
  return {
    ok,
    artifactOk,
    score,
    grade: score >= 85 ? "strong" : score >= 75 ? "pass" : score >= 55 ? "partial" : "weak",
    checks,
    finalJson,
    payloadText: text.slice(0, 8000),
    executionTrace: meta.executionTrace,
    sessionFile: meta.agentMeta?.sessionFile,
    durationMs: meta.durationMs,
  };
}

function applyExternalVerification(classification, verification) {
  const checks = {
    ...classification.checks,
    externalArtifactExists: verification.exists,
    externalJsonValid: verification.jsonValid,
    externalCaptureValid: verification.captureValid,
    externalLocation: verification.location,
  };
  const score = scoreExecutorChecks(checks);
  const ok =
    score >= 75 &&
    checks.statusOk &&
    checks.toolCalls > 0 &&
    checks.finalJsonValid &&
    checks.statusDone &&
    checks.expectedJobId &&
    checks.requestArtifact &&
    checks.externalArtifactExists &&
    checks.externalJsonValid &&
    checks.externalCaptureValid &&
    !checks.rawGuardrailVisible &&
    !checks.unresolvedToolIntent;
  const artifactOk =
    checks.externalArtifactExists &&
    checks.externalJsonValid &&
    checks.externalCaptureValid &&
    !checks.rawGuardrailVisible;
  return {
    ...classification,
    ok,
    artifactOk,
    score,
    grade: score >= 85 ? "strong" : score >= 75 ? "pass" : score >= 55 ? "partial" : "weak",
    checks,
    externalVerification: verification,
  };
}

function classifyWaitValidateRecording(response, processResult, expectedJobId, recordingResult) {
  const text = collectPayloadText(response);
  const lower = text.toLowerCase();
  const result = response?.result ?? response ?? {};
  const meta = result.meta ?? {};
  const currentToolCalls = Number(meta.toolSummary?.calls ?? 0);
  const tools = meta.toolSummary?.tools ?? [];
  const finalJson = extractJsonObject(text);
  const statusOk = processResult.code === 0 && response?.status === "ok";
  const timedOut = processResult.timedOut === true;
  const rawGuardrailVisible = lower.includes("tool-intent guardrail:");
  const unresolvedToolIntent = looksLikeUnresolvedToolIntent(text);
  const duration = Number(finalJson?.duration_seconds ?? 0);
  const fps = Number(finalJson?.average_fps ?? 0);
  const frameCount = Number(finalJson?.frame_count ?? 0);
  const checksObject = finalJson?.checks ?? {};
  const checks = {
    statusOk,
    timedOut,
    toolCalls: currentToolCalls,
    currentToolCalls,
    tools,
    finalizationFallback: Boolean(
      meta.executionTrace?.attempts?.some(
        (attempt) => attempt.reason === "tool_intent_guardrail_finalization_fallback",
      ),
    ),
    rawGuardrailVisible,
    unresolvedToolIntent,
    finalJsonValid: Boolean(finalJson),
    statusDone: finalJson?.status === "done",
    expectedJobId: finalJson?.job_id === expectedJobId,
    recordingValidVerdict: finalJson?.recording_valid === true,
    statusPathOk: finalJson?.status_path === recordingResult.status_path,
    videoProbePathOk: finalJson?.video_probe_path === recordingResult.video_probe_path,
    recordingPathOk: finalJson?.recording_path === recordingResult.recording_path,
    durationOk: duration >= 14.5,
    fpsOk: fps >= 59 && fps <= 61,
    frameCountOk: frameCount >= 870,
    checksObjectOk:
      checksObject.status_done === true &&
      checksObject.recording_exists === true &&
      checksObject.duration_ok === true &&
      checksObject.fps_ok === true &&
      checksObject.frame_count_ok === true,
    actualVideoValid: recordingResult.video_valid === true,
    noFuturePromise: !unresolvedToolIntent,
  };
  let score = 0;
  score += checks.statusOk ? 8 : 0;
  score += checks.toolCalls > 0 ? 12 : 0;
  score += checks.finalJsonValid ? 10 : 0;
  score += checks.statusDone ? 8 : 0;
  score += checks.expectedJobId ? 8 : 0;
  score += checks.recordingValidVerdict ? 10 : 0;
  score += checks.statusPathOk ? 5 : 0;
  score += checks.videoProbePathOk ? 5 : 0;
  score += checks.recordingPathOk ? 5 : 0;
  score += checks.durationOk ? 8 : 0;
  score += checks.fpsOk ? 8 : 0;
  score += checks.frameCountOk ? 6 : 0;
  score += checks.checksObjectOk ? 8 : 0;
  score += checks.noFuturePromise ? 3 : 0;
  if (checks.timedOut) {
    score -= 25;
  }
  if (checks.rawGuardrailVisible || checks.unresolvedToolIntent) {
    score -= 25;
  }
  score = Math.max(0, Math.min(100, score));
  const ok =
    score >= 80 &&
    checks.statusOk &&
    checks.toolCalls > 0 &&
    checks.finalJsonValid &&
    checks.statusDone &&
    checks.expectedJobId &&
    checks.recordingValidVerdict &&
    checks.actualVideoValid &&
    checks.durationOk &&
    checks.fpsOk &&
    checks.frameCountOk &&
    checks.checksObjectOk &&
    !checks.rawGuardrailVisible &&
    !checks.unresolvedToolIntent;
  return {
    ok,
    artifactOk: ok,
    score,
    grade: score >= 90 ? "strong" : score >= 80 ? "pass" : score >= 55 ? "partial" : "weak",
    checks,
    finalJson,
    payloadText: text.slice(0, 8000),
    executionTrace: meta.executionTrace,
    sessionFile: meta.agentMeta?.sessionFile,
    durationMs: meta.durationMs,
  };
}

function classifyMockMediaDelivery(
  response,
  processResult,
  expectedJobId,
  recordingResult,
  receipt,
  validation,
) {
  const text = collectPayloadText(response);
  const lower = text.toLowerCase();
  const result = response?.result ?? response ?? {};
  const meta = result.meta ?? {};
  const currentToolCalls = Number(meta.toolSummary?.calls ?? 0);
  const tools = meta.toolSummary?.tools ?? [];
  const finalJson = extractJsonObject(text);
  const statusOk = processResult.code === 0 && response?.status === "ok";
  const timedOut = processResult.timedOut === true;
  const rawGuardrailVisible = lower.includes("tool-intent guardrail:");
  const unresolvedToolIntent = looksLikeUnresolvedToolIntent(text);
  const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
  const checks = {
    statusOk,
    timedOut,
    toolCalls: currentToolCalls,
    currentToolCalls,
    tools,
    finalizationFallback: Boolean(
      meta.executionTrace?.attempts?.some(
        (attempt) => attempt.reason === "tool_intent_guardrail_finalization_fallback",
      ),
    ),
    rawGuardrailVisible,
    unresolvedToolIntent,
    finalJsonValid: Boolean(finalJson),
    statusDone: finalJson?.status === "done",
    expectedJobId: finalJson?.job_id === expectedJobId,
    mockReceiptPathOk: finalJson?.mock_delivery_receipt === receiptPath,
    receiptExists: receipt?.exists === true,
    receiptJsonValid: receipt?.jsonValid === true,
    contractOk: validation?.ok === true,
    actionOk: validation?.checks?.actionOk === true,
    mediaPathOk: validation?.checks?.mediaPathOk === true,
    mimeTypeOk: validation?.checks?.mimeTypeOk === true,
    captionOk: validation?.checks?.captionOk === true,
    validationOk: validation?.checks?.validationOk === true,
    actualVideoValid: recordingResult.video_valid === true,
    externalArtifactExists: receipt?.exists === true,
    externalJsonValid: receipt?.jsonValid === true,
    externalCaptureValid: validation?.ok === true,
    noFuturePromise: !unresolvedToolIntent,
  };
  let score = 0;
  score += checks.statusOk ? 8 : 0;
  score += checks.toolCalls > 0 ? 12 : 0;
  score += checks.finalJsonValid ? 10 : 0;
  score += checks.statusDone ? 8 : 0;
  score += checks.expectedJobId ? 8 : 0;
  score += checks.mockReceiptPathOk ? 8 : 0;
  score += checks.receiptExists ? 10 : 0;
  score += checks.receiptJsonValid ? 8 : 0;
  score += checks.actionOk ? 6 : 0;
  score += checks.mediaPathOk ? 8 : 0;
  score += checks.mimeTypeOk ? 5 : 0;
  score += checks.captionOk ? 5 : 0;
  score += checks.validationOk ? 8 : 0;
  score += checks.actualVideoValid ? 3 : 0;
  score += checks.noFuturePromise ? 2 : 0;
  if (checks.timedOut) {
    score -= 25;
  }
  if (checks.rawGuardrailVisible || checks.unresolvedToolIntent) {
    score -= 25;
  }
  score = Math.max(0, Math.min(100, score));
  const ok =
    score >= 80 &&
    checks.statusOk &&
    checks.toolCalls > 0 &&
    checks.finalJsonValid &&
    checks.statusDone &&
    checks.expectedJobId &&
    checks.mockReceiptPathOk &&
    checks.receiptExists &&
    checks.receiptJsonValid &&
    checks.contractOk &&
    checks.actualVideoValid &&
    !checks.rawGuardrailVisible &&
    !checks.unresolvedToolIntent;
  return {
    ok,
    artifactOk: checks.receiptExists && checks.receiptJsonValid && checks.contractOk,
    score,
    grade: score >= 90 ? "strong" : score >= 80 ? "pass" : score >= 55 ? "partial" : "weak",
    checks,
    finalJson,
    payloadText: text.slice(0, 8000),
    executionTrace: meta.executionTrace,
    sessionFile: meta.agentMeta?.sessionFile,
    durationMs: meta.durationMs,
  };
}

function isToolActionJson(json) {
  return Boolean(
    json &&
      typeof json === "object" &&
      (json.action || json.path || json.filePath || json.content),
  );
}

function isMessageSchemaActionJson(json) {
  return Boolean(
    json &&
      typeof json === "object" &&
      json.action === "send" &&
      (json.filePath || !json.target),
  );
}

function normalizePrintedFileAction(json) {
  if (!json || typeof json !== "object") {
    return null;
  }
  const pathValue = typeof json.path === "string" ? json.path : "";
  if (
    !pathValue ||
    !/\/home\/node\/\.openclaw\/workspace\/jobs\/game\/requests\/[^/]+\.json$/u.test(pathValue)
  ) {
    return null;
  }
  let content = json.content;
  if (content && typeof content === "object") {
    content = JSON.stringify(content, null, 2);
  }
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }
  return {
    path: pathValue,
    content: content.trim(),
  };
}

async function applyPrintedFileAction(options, printedAction) {
  const nodeCode = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const action = JSON.parse(process.env.PRINTED_FILE_ACTION || "{}");',
    'const safePath = /^\\/home\\/node\\/\\.openclaw\\/workspace\\/jobs\\/game\\/requests\\/[^/]+\\.json$/u;',
    'if (!safePath.test(action.path || "")) {',
    '  console.error("unsafe printed file action path");',
    "  process.exit(3);",
    "}",
    "let parsed = null;",
    "try {",
    "  parsed = JSON.parse(String(action.content || ''));",
    "} catch (error) {",
    '  console.error("invalid JSON content: " + error.message);',
    "  process.exit(4);",
    "}",
    'if (!parsed || parsed.action !== "run_and_capture" || !parsed.job_id) {',
    '  console.error("printed file action content is not a run_and_capture request");',
    "  process.exit(5);",
    "}",
    "fs.mkdirSync(path.dirname(action.path), { recursive: true });",
    'fs.writeFileSync(action.path, JSON.stringify(parsed, null, 2) + "\\n", "utf8");',
    'console.log(JSON.stringify({ ok: true, path: action.path, jobId: parsed.job_id }));',
  ].join(" ");
  const script = `PRINTED_FILE_ACTION=${JSON.stringify(
    JSON.stringify(printedAction),
  )} node -e ${JSON.stringify(nodeCode)}`;
  const processResult = await runProcess(
    "docker",
    ["exec", options.dockerContainer, "sh", "-lc", script],
    30,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(processResult.stdout.trim());
  } catch {
    // Keep parsed null.
  }
  return {
    ok: processResult.code === 0 && parsed?.ok === true,
    path: parsed?.path ?? printedAction.path,
    jobId: parsed?.jobId ?? null,
    process: {
      code: processResult.code,
      timedOut: processResult.timedOut,
      stderrTail: processResult.stderr.slice(-2000),
      stdoutTail: processResult.stdout.slice(-2000),
    },
  };
}

async function createDeterministicRecordingRequest(options, expectedJobId) {
  const requestPath = `/home/node/.openclaw/workspace/jobs/game/requests/${expectedJobId}.json`;
  const request = {
    job_id: expectedJobId,
    action: "run_and_capture",
    project_path: "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp",
    scene: "scenes/combat_sandbox.tscn",
    wait_seconds: 6,
    startup_wait_seconds: 6,
    record_seconds: 15,
    record_fps: 60,
    record_width: 1920,
    record_height: 1080,
    capture: {
      video: true,
      screenshot: false,
      record_seconds: 15,
      fps: 60,
      width: 1920,
      height: 1080,
    },
  };
  const writeResult = await applyPrintedFileAction(options, {
    path: requestPath,
    content: JSON.stringify(request, null, 2),
  });
  const verification = await verifyRequestArtifact(options, expectedJobId);
  return {
    ok: writeResult.ok && verification.exists && verification.jsonValid && verification.captureValid,
    requestPath,
    request,
    writeResult,
    verification,
  };
}

function buildRunDiagnostics({
  candidateJobIds,
  finalClassification,
  turnResults,
  recordingResult,
  deliveryResult,
  ok,
}) {
  const plannedJobIdsSeen = Array.from(
    new Set(candidateJobIds.filter((jobId) => jobId.startsWith("qwen_planned_godot_recording_"))),
  );
  const acceptedJobIdsSeen = Array.from(
    new Set(
      [
        finalClassification?.externalVerification?.jobId,
        recordingResult?.status?.job_id,
      ].filter(Boolean),
    ),
  );
  const acceptedPlannedJobIdsSeen = acceptedJobIdsSeen.filter((jobId) =>
    jobId.startsWith("qwen_planned_godot_recording_"),
  );
  const executorJobIdsSeen = Array.from(
    new Set(candidateJobIds.filter((jobId) => jobId.startsWith("qwen_executor_godot_recording_"))),
  );
  const turnClassifications = turnResults.map((turn) => turn.classification).filter(Boolean);
  const unexecutedActionJson = turnClassifications.some(
    (classification) =>
      classification.checks.finalJsonValid &&
      classification.checks.currentToolCalls === 0 &&
      isToolActionJson(classification.finalJson) &&
      !classification.artifactOk,
  );
  const messageSchemaError =
    turnClassifications.some((classification) =>
      isMessageSchemaActionJson(classification.finalJson),
    ) ||
    String(deliveryResult?.agent?.stderrTail ?? "").includes("Action send requires a target");
  const noToolCall = !finalClassification?.artifactOk && finalClassification?.checks.toolCalls === 0;
  const duplicatePlannedJobIds = Math.max(0, acceptedPlannedJobIdsSeen.length - 1);
  const failureReasons = [];

  if (!ok) {
    if (finalClassification?.checks.timedOut) {
      failureReasons.push("timeout");
    }
    if (duplicatePlannedJobIds > 0) {
      failureReasons.push("duplicate_planned_job");
    }
    if (unexecutedActionJson) {
      failureReasons.push("unexecuted_action_json");
    }
    if (messageSchemaError) {
      failureReasons.push("wrong_message_schema");
    }
    if (noToolCall) {
      failureReasons.push("no_tool_call");
    }
    if (finalClassification?.artifactOk && recordingResult && !recordingResult.video_valid) {
      failureReasons.push("artifact_ok_recording_failed");
    }
    if (
      finalClassification?.artifactOk &&
      recordingResult?.video_valid &&
      deliveryResult?.attempted &&
      !deliveryResult.ok
    ) {
      failureReasons.push("artifact_ok_delivery_failed");
    }
    if (!failureReasons.length) {
      failureReasons.push("unclassified_partial");
    }
  }

  return {
    failureReasons,
    plannedJobIdsSeen,
    plannedJobIdCount: plannedJobIdsSeen.length,
    rawPlannedJobIdCount: plannedJobIdsSeen.length,
    acceptedJobIdsSeen,
    acceptedJobIdCount: acceptedJobIdsSeen.length,
    acceptedPlannedJobIdsSeen,
    acceptedPlannedJobIdCount: acceptedPlannedJobIdsSeen.length,
    duplicatePlannedJobIds,
    executorJobIdsSeen,
    executorJobIdCount: executorJobIdsSeen.length,
    unexecutedActionJson,
    messageSchemaError,
    noToolCall,
    turnCount: turnResults.length,
    turnsWithToolCalls: turnClassifications.filter(
      (classification) => classification.checks.currentToolCalls > 0,
    ).length,
  };
}

async function verifyRequestArtifact(options, expectedJobId) {
  return verifyRequestArtifactCandidates(options, [expectedJobId]);
}

async function verifyRequestArtifactCandidates(options, expectedJobIds) {
  const candidateDirs = [
    "/home/node/.openclaw/workspace/jobs/game/requests",
    "/home/node/.openclaw/workspace/jobs/game/requests_done",
    "/home/node/.openclaw/workspace/jobs/game/requests_failed",
  ];
  const nodeCode = [
    'const fs = require("fs");',
    'const path = require("path");',
    'const jobIds = JSON.parse(process.env.JOB_IDS || "[]");',
    'const sinceEpochSeconds = Number(process.env.SINCE_EPOCH_SECONDS || "0");',
    `const dirs = ${JSON.stringify(candidateDirs)};`,
    "function printCandidate(candidate) {",
    "  console.log(candidate);",
    '  process.stdout.write(fs.readFileSync(candidate, "utf8"));',
    "}",
    "for (const jobId of jobIds) {",
    "  for (const dir of dirs) {",
    '    const candidate = path.join(dir, jobId + ".json");',
    "    if (fs.existsSync(candidate)) {",
    "      printCandidate(candidate);",
    "      process.exit(0);",
    "    }",
    "  }",
    "}",
    "const fallback = [];",
    "for (const dir of dirs) {",
    "  if (!fs.existsSync(dir)) continue;",
    "  for (const name of fs.readdirSync(dir)) {",
    '    if (!/^qwen_planned_godot_recording_[A-Za-z0-9_-]+\\.json$/u.test(name)) continue;',
    "    const candidate = path.join(dir, name);",
    "    const stat = fs.statSync(candidate);",
    "    if (sinceEpochSeconds && stat.mtimeMs < sinceEpochSeconds * 1000) continue;",
    "    fallback.push({ candidate, mtimeMs: stat.mtimeMs });",
    "  }",
    "}",
    "fallback.sort((a, b) => b.mtimeMs - a.mtimeMs);",
    "if (fallback[0]) {",
    "  printCandidate(fallback[0].candidate);",
    "  process.exit(0);",
    "}",
    "process.exit(2);",
  ].join(" ");
  const script = [
    `JOB_IDS=${JSON.stringify(JSON.stringify(expectedJobIds))}`,
    `SINCE_EPOCH_SECONDS=${JSON.stringify(String(options.runStartedEpochSeconds ?? 0))}`,
    `node -e ${JSON.stringify(nodeCode)}`,
  ].join(" ");
  const processResult = await runProcess(
    "docker",
    ["exec", options.dockerContainer, "sh", "-lc", script],
    30,
  );
  if (processResult.code !== 0) {
    return {
      exists: false,
      jsonValid: false,
      captureValid: false,
      location: null,
      error: processResult.stderr.trim() || `docker exec exited with ${processResult.code}`,
    };
  }
  const output = processResult.stdout;
  const firstNewline = output.indexOf("\n");
  const location = firstNewline >= 0 ? output.slice(0, firstNewline).trim() : "";
  const jsonText = firstNewline >= 0 ? output.slice(firstNewline + 1).trim() : "";
  let parsed = null;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // Keep parsed null.
  }
  const capture = parsed?.capture ?? {};
  const jobId = typeof parsed?.job_id === "string" ? parsed.job_id : path.basename(location, ".json");
  const expectedOrRuntimeJobId =
    expectedJobIds.includes(jobId) || jobId.startsWith("qwen_planned_godot_recording_");
  const captureChecks = {
    expectedOrRuntimeJobId,
    action: parsed?.action === "run_and_capture",
    projectPath: parsed?.project_path === "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp",
    scene: parsed?.scene === "scenes/combat_sandbox.tscn",
    startupWait:
      Number.isFinite(Number(parsed?.startup_wait_seconds)) &&
      Number(parsed?.startup_wait_seconds) > 0,
    recordSeconds: parsed?.record_seconds === 15,
    recordFps: parsed?.record_fps === 60,
    recordWidth: parsed?.record_width === 1920,
    recordHeight: parsed?.record_height === 1080,
    captureVideo: capture.video === true,
    captureScreenshot: capture.screenshot === false,
    captureRecordSeconds: capture.record_seconds === 15,
    captureFps: capture.fps === 60,
    captureWidth: capture.width === 1920,
    captureHeight: capture.height === 1080,
  };
  const captureValid = Object.values(captureChecks).every(Boolean);
  return {
    exists: true,
    jsonValid: Boolean(parsed),
    captureValid,
    captureChecks,
    location,
    jobId,
    parsed,
  };
}

function extractCandidateJobIdsFromText(text) {
  return Array.from(
    new Set(
      String(text ?? "").match(/qwen_(?:executor|planned)_godot_recording_[A-Za-z0-9_-]+/g) ?? [],
    ),
  );
}

function extractCandidateJobIdsFromLogs(logText) {
  return Array.from(
    new Set(
      [
        ...(String(logText ?? "").match(/jobId=(qwen_(?:executor|planned)_godot_recording_[A-Za-z0-9_-]+)/g) ??
          []).map((entry) => entry.replace(/^jobId=/, "")),
        ...extractCandidateJobIdsFromText(logText),
      ],
    ),
  );
}

function extractCandidateJobIdsFromSessionLogs(logText, sessionKey) {
  const candidates = [];
  for (const line of String(logText ?? "").split(/\r?\n/u)) {
    if (!line.includes(sessionKey)) {
      continue;
    }
    for (const jobId of extractCandidateJobIdsFromLogs(line)) {
      if (!candidates.includes(jobId)) {
        candidates.push(jobId);
      }
    }
  }
  return candidates;
}

async function findRecentPlannedJobIds(options, sessionKey, sinceEpochSeconds) {
  const logs = await runProcess(
    "docker",
    [
      "logs",
      options.dockerContainer,
      "--since",
      `${Math.max(1, Math.floor(Date.now() / 1000 - sinceEpochSeconds + 30))}s`,
    ],
    30,
  );
  return extractCandidateJobIdsFromSessionLogs(logs.stdout, sessionKey);
}

async function inspectRecordingResult(options, expectedJobId) {
  const resultDir = `/home/node/.openclaw/workspace/jobs/game/results/${expectedJobId}`;
  const script = [
    `dir=${JSON.stringify(resultDir)}`,
    'status="$dir/status.json"',
    'probe="$dir/video_probe.json"',
    'recording="$dir/recording.mp4"',
    'if [ ! -f "$status" ]; then echo "{}"; exit 0; fi',
    "node - <<'NODE'",
    "const fs = require('fs');",
    "const dir = process.env.RESULT_DIR;",
    "const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };",
    "const statusPath = `${dir}/status.json`;",
    "const probePath = `${dir}/video_probe.json`;",
    "const recordingPath = `${dir}/recording.mp4`;",
    "const status = readJson(statusPath);",
    "const probe = readJson(probePath) || status?.video_probe || null;",
    "const recordingExists = fs.existsSync(recordingPath);",
    "const stat = recordingExists ? fs.statSync(recordingPath) : null;",
    "const duration = Number(probe?.duration_seconds ?? 0);",
    "const fps = Number(probe?.average_fps ?? 0);",
    "const frames = Number(probe?.frame_count ?? 0);",
    "const videoValid = status?.status === 'done' && recordingExists && duration >= 14.5 && fps >= 59 && fps <= 61 && frames >= 870;",
    "console.log(JSON.stringify({",
    "  exists: true,",
    "  result_dir: dir,",
    "  status_path: statusPath,",
    "  recording_path: recordingPath,",
    "  video_probe_path: probePath,",
    "  status,",
    "  probe,",
    "  recording_exists: recordingExists,",
    "  recording_bytes: stat ? stat.size : 0,",
    "  video_valid: videoValid",
    "}, null, 2));",
    "NODE",
  ].join("\n");
  const processResult = await runProcess(
    "docker",
    ["exec", "-e", `RESULT_DIR=${resultDir}`, options.dockerContainer, "sh", "-lc", script],
    30,
  );
  if (processResult.code !== 0) {
    return {
      exists: false,
      video_valid: false,
      error: processResult.stderr.trim() || `docker exec exited with ${processResult.code}`,
    };
  }
  try {
    const parsed = JSON.parse(processResult.stdout.trim() || "{}");
    return {
      exists: Boolean(parsed.exists),
      video_valid: Boolean(parsed.video_valid),
      ...parsed,
    };
  } catch {
    return {
      exists: false,
      video_valid: false,
      error: `could not parse result inspection: ${processResult.stdout.slice(0, 500)}`,
    };
  }
}

async function waitForRecordingResult(options, expectedJobId) {
  const deadline = Date.now() + options.recordingTimeoutSeconds * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await inspectRecordingResult(options, expectedJobId);
    if (last.video_valid || last.status?.status === "failed") {
      return last;
    }
    await sleep(5000);
  }
  return {
    ...(last ?? {}),
    timed_out: true,
    video_valid: false,
  };
}

function validateMockMediaContract(contract, recordingResult, expectedJobId) {
  const mediaPathOk =
    typeof contract?.media?.path === "string" &&
    contract.media.path === recordingResult.recording_path &&
    contract.media.path.endsWith("/recording.mp4") &&
    recordingResult.recording_exists === true;
  const mimeTypeOk = contract?.media?.mimeType === "video/mp4";
  const captionOk =
    typeof contract?.message === "string" &&
    contract.message.includes(expectedJobId) &&
    contract.message.includes("15s") &&
    contract.message.includes("60fps");
  const validationOk =
    contract?.validation?.job_id === expectedJobId &&
    Number(contract.validation.duration_seconds) >= 14.5 &&
    Number(contract.validation.average_fps) >= 59 &&
    Number(contract.validation.average_fps) <= 61;
  const actionOk = contract?.action === "send" && contract?.target === "current_session";
  return {
    ok: actionOk && mediaPathOk && mimeTypeOk && captionOk && validationOk,
    checks: {
      actionOk,
      mediaPathOk,
      mimeTypeOk,
      captionOk,
      validationOk,
    },
  };
}

async function inspectMockMediaReceipt(options, expectedJobId) {
  const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
  const script = [
    `path=${JSON.stringify(receiptPath)}`,
    'if [ ! -f "$path" ]; then',
    '  printf "%s\\n" "{}"',
    "  exit 0",
    "fi",
    'printf "%s\\n" "$path"',
    'cat "$path"',
  ].join("\n");
  const processResult = await runProcess(
    "docker",
    ["exec", options.dockerContainer, "sh", "-lc", script],
    30,
  );
  const stdout = processResult.stdout.trim();
  if (!stdout || stdout === "{}") {
    return {
      exists: false,
      path: receiptPath,
      jsonValid: false,
      contract: null,
      process: processResult,
    };
  }
  const newline = stdout.indexOf("\n");
  const location = newline >= 0 ? stdout.slice(0, newline).trim() : receiptPath;
  const jsonText = newline >= 0 ? stdout.slice(newline + 1).trim() : "";
  try {
    return {
      exists: true,
      path: location,
      jsonValid: true,
      contract: JSON.parse(jsonText),
      process: processResult,
    };
  } catch (error) {
    return {
      exists: true,
      path: location,
      jsonValid: false,
      contract: null,
      error: error instanceof Error ? error.message : String(error),
      process: processResult,
    };
  }
}

async function deliverRecording(options, recordingResult, expectedJobId, sessionKey) {
  if (options.deliveryMode === "none") {
    return {
      mode: "none",
      attempted: false,
      ok: null,
      evidence: "delivery disabled",
    };
  }
  if (!recordingResult?.video_valid || !recordingResult?.recording_path) {
    return {
      mode: options.deliveryMode,
      attempted: false,
      ok: false,
      evidence: "recording was not validated",
    };
  }
  if (options.deliveryMode === "simulate") {
    return {
      mode: "simulate",
      attempted: false,
      ok: true,
      recording_path: recordingResult.recording_path,
      evidence: "recording file validated; Telegram send skipped by simulate mode",
    };
  }
  if (options.deliveryMode === "mock-media") {
    const probe = recordingResult.probe ?? recordingResult.video_probe ?? recordingResult.status?.video_probe ?? {};
    const contract = {
      action: "send",
      target: "current_session",
      message: `Godot auto chess gameplay recording\nJob: ${expectedJobId}\n15s 60fps validation passed`,
      media: {
        path: recordingResult.recording_path,
        mimeType: "video/mp4",
      },
      validation: {
        job_id: expectedJobId,
        duration_seconds: probe.duration_seconds,
        average_fps: probe.average_fps,
        frame_count: probe.frame_count,
      },
    };
    const validation = validateMockMediaContract(contract, recordingResult, expectedJobId);
    return {
      mode: "mock-media",
      attempted: true,
      ok: validation.ok,
      contract,
      checks: validation.checks,
      evidence: validation.ok
        ? "mock media delivery contract accepted"
        : "mock media delivery contract rejected",
    };
  }
  if (options.deliveryMode === "mock-media-tool") {
    const prompt = buildMockMediaDeliveryPrompt(expectedJobId, recordingResult);
    const deliverySessionKey = `${sessionKey}-mock-media-${sanitizeSessionKeyPart(expectedJobId).slice(-24)}`;
    const command = commandForPrompt(options, deliverySessionKey, prompt);
    const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
    const response = parseAgentJson(processResult.stdout);
    const receipt = await inspectMockMediaReceipt(options, expectedJobId);
    const validation =
      receipt.exists && receipt.jsonValid
        ? validateMockMediaContract(receipt.contract, recordingResult, expectedJobId)
        : { ok: false, checks: {} };
    return {
      mode: "mock-media-tool",
      attempted: true,
      ok:
        processResult.code === 0 &&
        response?.status === "ok" &&
        receipt.exists &&
        receipt.jsonValid &&
        validation.ok,
      evidence: validation.ok
        ? "Qwen created a valid mock media delivery receipt"
        : "Qwen did not create a valid mock media delivery receipt",
      receipt,
      checks: validation.checks,
      agent: {
        code: processResult.code,
        timedOut: processResult.timedOut,
        stderrTail: processResult.stderr.slice(-2000),
        responseStatus: response?.status,
        payloadText: collectPayloadText(response).slice(0, 4000),
        toolSummary: response?.result?.meta?.toolSummary,
      },
    };
  }
  const caption = `Godot auto chess gameplay recording\\nJob: ${expectedJobId}\\n15s 60fps validation passed`;
  const processResult = await runProcess(
    "docker",
    [
      "exec",
      options.dockerContainer,
      options.openclawBin,
      "message",
      "send",
      "--channel",
      "telegram",
      "--target",
      "8672163720",
      "--media",
      recordingResult.recording_path,
      "--message",
      caption,
      "--force-document",
      "--json",
    ],
    120,
  );
  let parsed = null;
  try {
    parsed = JSON.parse(processResult.stdout.trim());
  } catch {
    // Keep parsed null.
  }
  return {
    mode: "telegram",
    attempted: true,
    ok: processResult.code === 0 && parsed?.ok === true,
    evidence: parsed?.ok === true ? "helper returned ok:true" : processResult.stderr || processResult.stdout,
    response: parsed,
    process: {
      code: processResult.code,
      timedOut: processResult.timedOut,
      stderrTail: processResult.stderr.slice(-2000),
    },
  };
}

function commandForPrompt(options, sessionKey, message) {
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
      message,
    ],
  };
}

function defaultOutputPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, ".artifacts", "qwen-planned-executor", `${stamp}.json`);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function runOne(options, runIndex, runId) {
  const runTag = `${runId}_${String(runIndex).padStart(2, "0")}`;
  const expectedJobId = `qwen_executor_godot_recording_${runTag}`;
  let activeJobId = expectedJobId;
  const candidateJobIds = new Set([expectedJobId]);
  const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${runIndex}-${runId}`;
  const runStartedEpochSeconds = Math.floor(Date.now() / 1000);
  const godotSkillText = fs.existsSync(options.godotSkillPath)
    ? fs.readFileSync(options.godotSkillPath, "utf8")
    : "";
  const initialPrompt = buildExecutionPacketPrompt(runTag, godotSkillText);
  if (runIndex === 1 && options.promptOutputPath) {
    fs.mkdirSync(path.dirname(options.promptOutputPath), { recursive: true });
    fs.writeFileSync(options.promptOutputPath, initialPrompt, "utf8");
  }
  const turnResults = [];
  let aggregateToolCalls = 0;
  let aggregateTools = [];
  let finalClassification = null;
  let reviewerVerifiedArtifact = null;
  let pendingPrintedFileAction = null;
  let previousUsageSnapshot = {
    available: false,
    assistantCalls: 0,
    totals: emptyUsageTotals(),
    byModel: {},
  };
  const started = Date.now();
  for (let turnIndex = 1; turnIndex <= options.maxExecutorTurns; turnIndex += 1) {
    const usedFinalReportPrompt = turnIndex > 1 && Boolean(reviewerVerifiedArtifact);
    const printedActionForTurn = pendingPrintedFileAction;
    pendingPrintedFileAction = null;
    const phase =
      turnIndex === 1
        ? "executor"
        : printedActionForTurn
          ? "execute_printed_file_action"
        : usedFinalReportPrompt
          ? "reviewer_final_report"
          : "reviewer_continuation";
    const prompt =
      turnIndex === 1
        ? initialPrompt
        : printedActionForTurn
          ? buildExecutePrintedFileActionPrompt(activeJobId, printedActionForTurn)
        : usedFinalReportPrompt
          ? buildReviewerFinalReportPrompt(activeJobId, reviewerVerifiedArtifact)
          : buildReviewerContinuationPrompt(activeJobId);
    const promptMetrics = buildPromptMetrics(prompt, phase);
    const command = commandForPrompt(options, sessionKey, prompt);
    const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
    const response = parseAgentJson(processResult.stdout);
    for (const jobId of extractCandidateJobIdsFromText(collectPayloadText(response))) {
      candidateJobIds.add(jobId);
    }
    for (const jobId of await findRecentPlannedJobIds(
      options,
      sessionKey,
      runStartedEpochSeconds,
    )) {
      candidateJobIds.add(jobId);
    }
    let classification = classify(response, processResult, expectedJobId, {
      previousToolCalls: aggregateToolCalls,
      previousTools: aggregateTools,
    });
    const currentTools = response?.result?.meta?.toolSummary?.tools ?? [];
    aggregateToolCalls += Number(response?.result?.meta?.toolSummary?.calls ?? 0);
    aggregateTools = Array.from(new Set([...aggregateTools, ...currentTools]));
    const externalVerification = await verifyRequestArtifactCandidates(
      { ...options, runStartedEpochSeconds },
      Array.from(candidateJobIds),
    );
    if (externalVerification.jobId) {
      activeJobId = externalVerification.jobId;
      candidateJobIds.add(activeJobId);
    }
    classification = applyExternalVerification(classification, externalVerification);
    if (classification.artifactOk) {
      reviewerVerifiedArtifact = externalVerification;
    }
    const priorUsageSnapshot = previousUsageSnapshot;
    const usageSnapshot = await readTranscriptUsageSnapshot(
      options,
      classification.sessionFile || priorUsageSnapshot.sessionFile,
    );
    const usageDelta =
      usageSnapshot.available && priorUsageSnapshot.available
        ? diffUsage(usageSnapshot.totals, priorUsageSnapshot.totals)
        : usageSnapshot.available
          ? usageSnapshot.totals
          : emptyUsageTotals();
    const byModelDelta = usageSnapshot.available
      ? diffUsageByModel(usageSnapshot.byModel, priorUsageSnapshot.byModel)
      : {};
    const assistantCallsDelta = usageSnapshot.available
      ? Math.max(
          0,
          Number(usageSnapshot.assistantCalls ?? 0) -
            Number(priorUsageSnapshot.assistantCalls ?? 0),
        )
      : 0;
    if (usageSnapshot.available) {
      previousUsageSnapshot = usageSnapshot;
    }
    finalClassification = classification;
    turnResults.push({
      turnIndex,
      phase,
      reviewerContinuation: turnIndex > 1,
      finalReportOnly: usedFinalReportPrompt,
      ok: classification.ok,
      promptMetrics,
      usageMetrics: {
        available: usageSnapshot.available,
        sessionFile: usageSnapshot.sessionFile,
        error: usageSnapshot.error,
        assistantCallsDelta,
        delta: usageDelta,
        byModelDelta,
        cumulative: usageSnapshot.totals,
        byModel: usageSnapshot.byModel,
      },
      process: {
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        stderrTail: processResult.stderr.slice(-3000),
      },
      classification,
      rawJsonParsed: Boolean(response),
    });
    const unexecutedActionJson =
      classification.checks.finalJsonValid &&
      classification.checks.currentToolCalls === 0 &&
      Boolean(
        classification.finalJson?.action ||
          classification.finalJson?.path ||
          classification.finalJson?.filePath ||
          classification.finalJson?.content,
      ) &&
      !classification.artifactOk;
    const printedFileAction = unexecutedActionJson
      ? normalizePrintedFileAction(classification.finalJson)
      : null;
    if (printedFileAction) {
      const printedFileActionRecovery = await applyPrintedFileAction(options, printedFileAction);
      if (printedFileActionRecovery.jobId) {
        candidateJobIds.add(printedFileActionRecovery.jobId);
      }
      const recoveredVerification = await verifyRequestArtifactCandidates(
        { ...options, runStartedEpochSeconds },
        Array.from(candidateJobIds),
      );
      if (recoveredVerification.jobId) {
        activeJobId = recoveredVerification.jobId;
        candidateJobIds.add(activeJobId);
      }
      classification = applyExternalVerification(classification, recoveredVerification);
      if (classification.artifactOk) {
        reviewerVerifiedArtifact = recoveredVerification;
      }
      finalClassification = classification;
      turnResults[turnResults.length - 1].classification = classification;
      turnResults[turnResults.length - 1].printedFileActionRecovery = printedFileActionRecovery;
      if (classification.artifactOk) {
        break;
      }
      if (turnIndex < options.maxExecutorTurns) {
        pendingPrintedFileAction = printedFileAction;
        continue;
      }
    }
    // Once the request artifact is externally verified, the harness owns
    // waiting for the host runner. If Qwen prints a tool/action JSON as final text
    // without calling tools, continuing the same scenario only re-triggers
    // planned-execution rewriting and can create duplicate Godot job ids.
    if (
      classification.ok ||
      classification.artifactOk ||
      unexecutedActionJson ||
      processResult.timedOut ||
      processResult.code !== 0
    ) {
      break;
    }
  }
  const recordingResult =
    options.waitRecording && finalClassification?.artifactOk
      ? await waitForRecordingResult(options, activeJobId)
      : null;
  const deliveryResult =
    recordingResult && options.deliveryMode !== "none"
      ? await deliverRecording(options, recordingResult, activeJobId, sessionKey)
      : null;
  const e2eOk =
    Boolean(finalClassification?.artifactOk) &&
    (!options.waitRecording || Boolean(recordingResult?.video_valid)) &&
    (options.deliveryMode === "none" || Boolean(deliveryResult?.ok));
  const diagnostics = buildRunDiagnostics({
    candidateJobIds: Array.from(candidateJobIds),
    finalClassification,
    turnResults,
    recordingResult,
    deliveryResult,
    ok: e2eOk,
  });
  return {
    runIndex,
    sessionKey,
    expectedJobId,
    activeJobId,
    candidateJobIds: Array.from(candidateJobIds),
    ok: e2eOk,
    executorOk: Boolean(finalClassification?.ok),
    e2e: {
      waitRecording: options.waitRecording,
      deliveryMode: options.deliveryMode,
      recording: recordingResult,
      delivery: deliveryResult,
    },
    process: {
      durationMs: Date.now() - started,
    },
    classification: finalClassification,
    diagnostics,
    usageSummary: summarizeUsageForTurns(turnResults),
    turns: turnResults,
  };
}

async function runWaitValidateRecording(options, runIndex, runId) {
  const runTag = `${runId}_${String(runIndex).padStart(2, "0")}`;
  const expectedJobId = `qwen_wait_validate_recording_${runTag}`;
  const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${runIndex}-${runId}`;
  const started = Date.now();
  const setupResult = await createDeterministicRecordingRequest(options, expectedJobId);
  const recordingResult = setupResult.ok
    ? await waitForRecordingResult(options, expectedJobId)
    : null;
  if (!setupResult.ok || !recordingResult?.video_valid) {
    const classification = {
      ok: false,
      artifactOk: false,
      score: 0,
      grade: "weak",
      checks: {
        statusOk: false,
        timedOut: false,
        toolCalls: 0,
        currentToolCalls: 0,
        tools: [],
        finalJsonValid: false,
        statusDone: false,
        expectedJobId: false,
        actualVideoValid: Boolean(recordingResult?.video_valid),
      },
      finalJson: null,
      payloadText: "setup did not produce a valid recording",
    };
    return {
      runIndex,
      sessionKey,
      expectedJobId,
      activeJobId: expectedJobId,
      candidateJobIds: [expectedJobId],
      ok: false,
      executorOk: false,
      e2e: {
        waitRecording: true,
        deliveryMode: "none",
        recording: recordingResult,
        delivery: null,
        setup: setupResult,
      },
      process: {
        durationMs: Date.now() - started,
      },
      classification,
      diagnostics: {
        failureReasons: ["setup_recording_failed"],
        plannedJobIdsSeen: [],
        plannedJobIdCount: 0,
        rawPlannedJobIdCount: 0,
        acceptedJobIdsSeen: [expectedJobId],
        acceptedJobIdCount: 1,
        acceptedPlannedJobIdsSeen: [],
        acceptedPlannedJobIdCount: 0,
        duplicatePlannedJobIds: 0,
        executorJobIdsSeen: [],
        executorJobIdCount: 0,
        unexecutedActionJson: false,
        messageSchemaError: false,
        noToolCall: true,
        turnCount: 0,
        turnsWithToolCalls: 0,
      },
      turns: [],
      usageSummary: summarizeUsageForTurns([]),
    };
  }
  const turns = [];
  let classification = null;
  for (let turnIndex = 1; turnIndex <= options.maxExecutorTurns; turnIndex += 1) {
    const phase = turnIndex === 1 ? "wait_validate_recording" : "wait_validate_recording_retry";
    const prompt =
      turnIndex === 1
        ? buildWaitValidateRecordingPrompt(expectedJobId, recordingResult)
        : buildWaitValidateRecordingRetryPrompt(expectedJobId, recordingResult);
    if (runIndex === 1 && turnIndex === 1 && options.promptOutputPath) {
      fs.mkdirSync(path.dirname(options.promptOutputPath), { recursive: true });
      fs.writeFileSync(options.promptOutputPath, prompt, "utf8");
    }
    const promptMetrics = buildPromptMetrics(prompt, phase);
    const command = commandForPrompt(options, sessionKey, prompt);
    const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
    const response = parseAgentJson(processResult.stdout);
    classification = classifyWaitValidateRecording(
      response,
      processResult,
      expectedJobId,
      recordingResult,
    );
    const priorUsageSummary = summarizeUsageForTurns(turns);
    const usageSnapshot = await readTranscriptUsageSnapshot(options, classification.sessionFile);
    const usageDelta = usageSnapshot.available
      ? diffUsage(usageSnapshot.totals, priorUsageSummary.usage)
      : emptyUsageTotals();
    const byModelDelta = usageSnapshot.available
      ? diffUsageByModel(
          usageSnapshot.byModel,
          Object.fromEntries(
            Object.entries(priorUsageSummary.byModel ?? {}).map(([modelKey, value]) => [
              modelKey,
              { assistantCalls: value.assistantCalls, totals: value.usage },
            ]),
          ),
        )
      : {};
    const assistantCallsDelta = usageSnapshot.available
      ? Math.max(0, Number(usageSnapshot.assistantCalls ?? 0) - priorUsageSummary.assistantCalls)
      : 0;
    turns.push({
      turnIndex,
      phase,
      reviewerContinuation: turnIndex > 1,
      finalReportOnly: false,
      ok: classification.ok,
      promptMetrics,
      usageMetrics: {
        available: usageSnapshot.available,
        sessionFile: usageSnapshot.sessionFile,
        error: usageSnapshot.error,
        assistantCallsDelta,
        delta: usageDelta,
        byModelDelta,
        cumulative: usageSnapshot.totals,
        byModel: usageSnapshot.byModel,
      },
      process: {
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        stderrTail: processResult.stderr.slice(-3000),
      },
      classification,
      rawJsonParsed: Boolean(response),
    });
    if (classification.ok || processResult.timedOut || processResult.code !== 0) {
      break;
    }
  }
  const failureReasons = [];
  if (!classification.ok) {
    if (classification.checks.timedOut) {
      failureReasons.push("timeout");
    }
    if (!classification.checks.toolCalls) {
      failureReasons.push("no_tool_call");
    }
    if (!classification.checks.finalJsonValid) {
      failureReasons.push("invalid_final_json");
    }
    if (classification.checks.finalJsonValid && !classification.checks.recordingValidVerdict) {
      failureReasons.push("wrong_recording_verdict");
    }
    if (
      !classification.checks.durationOk ||
      !classification.checks.fpsOk ||
      !classification.checks.frameCountOk
    ) {
      failureReasons.push("probe_values_missing_or_wrong");
    }
    if (!failureReasons.length) {
      failureReasons.push("unclassified_partial");
    }
  }
  return {
    runIndex,
    sessionKey,
    expectedJobId,
    activeJobId: expectedJobId,
    candidateJobIds: [expectedJobId],
    ok: classification.ok,
    executorOk: classification.ok,
    e2e: {
      waitRecording: true,
      deliveryMode: "none",
      recording: recordingResult,
      delivery: null,
      setup: setupResult,
    },
    process: {
      durationMs: Date.now() - started,
    },
    classification,
    diagnostics: {
      failureReasons,
      plannedJobIdsSeen: [],
      plannedJobIdCount: 0,
      rawPlannedJobIdCount: 0,
      acceptedJobIdsSeen: [expectedJobId],
      acceptedJobIdCount: 1,
      acceptedPlannedJobIdsSeen: expectedJobId.startsWith("qwen_planned_godot_recording_")
        ? [expectedJobId]
        : [],
      acceptedPlannedJobIdCount: expectedJobId.startsWith("qwen_planned_godot_recording_") ? 1 : 0,
      duplicatePlannedJobIds: 0,
      executorJobIdsSeen: expectedJobId.startsWith("qwen_executor_godot_recording_")
        ? [expectedJobId]
        : [],
      executorJobIdCount: expectedJobId.startsWith("qwen_executor_godot_recording_") ? 1 : 0,
      unexecutedActionJson: false,
      messageSchemaError: false,
      noToolCall: classification.checks.toolCalls === 0,
      turnCount: turns.length,
      turnsWithToolCalls: turns.filter((turn) => turn.classification?.checks.toolCalls > 0).length,
    },
    turns,
    usageSummary: summarizeUsageForTurns(turns),
  };
}

async function runDeliverRecordingOrMockMedia(options, runIndex, runId) {
  const runTag = `${runId}_${String(runIndex).padStart(2, "0")}`;
  const expectedJobId = `qwen_deliver_recording_${runTag}`;
  const sessionKey = `${sanitizeSessionKeyPart(options.sessionPrefix)}-${runIndex}-${runId}`;
  const started = Date.now();
  const setupResult = await createDeterministicRecordingRequest(options, expectedJobId);
  const recordingResult = setupResult.ok
    ? await waitForRecordingResult(options, expectedJobId)
    : null;
  if (!setupResult.ok || !recordingResult?.video_valid) {
    const classification = {
      ok: false,
      artifactOk: false,
      score: 0,
      grade: "weak",
      checks: {
        statusOk: false,
        timedOut: false,
        toolCalls: 0,
        currentToolCalls: 0,
        tools: [],
        finalJsonValid: false,
        statusDone: false,
        expectedJobId: false,
        actualVideoValid: Boolean(recordingResult?.video_valid),
      },
      finalJson: null,
      payloadText: "setup did not produce a valid recording",
    };
    return {
      runIndex,
      sessionKey,
      expectedJobId,
      activeJobId: expectedJobId,
      candidateJobIds: [expectedJobId],
      ok: false,
      executorOk: false,
      e2e: {
        waitRecording: true,
        deliveryMode: "mock-media-tool",
        recording: recordingResult,
        delivery: {
          mode: "mock-media-tool",
          attempted: false,
          ok: false,
          evidence: "recording setup failed before delivery phase",
        },
        setup: setupResult,
      },
      process: {
        durationMs: Date.now() - started,
      },
      classification,
      diagnostics: {
        failureReasons: ["setup_recording_failed"],
        plannedJobIdsSeen: [],
        plannedJobIdCount: 0,
        rawPlannedJobIdCount: 0,
        acceptedJobIdsSeen: [expectedJobId],
        acceptedJobIdCount: 1,
        acceptedPlannedJobIdsSeen: [],
        acceptedPlannedJobIdCount: 0,
        duplicatePlannedJobIds: 0,
        executorJobIdsSeen: [],
        executorJobIdCount: 0,
        unexecutedActionJson: false,
        messageSchemaError: false,
        noToolCall: true,
        turnCount: 0,
        turnsWithToolCalls: 0,
      },
      turns: [],
      usageSummary: summarizeUsageForTurns([]),
    };
  }

  const turns = [];
  let classification = null;
  let receipt = null;
  let validation = null;
  for (let turnIndex = 1; turnIndex <= options.maxExecutorTurns; turnIndex += 1) {
    const phase =
      turnIndex === 1 ? "deliver_recording_or_mock_media" : "deliver_recording_or_mock_media_retry";
    const prompt =
      turnIndex === 1
        ? buildMockMediaDeliveryPrompt(expectedJobId, recordingResult)
        : buildMockMediaDeliveryRetryPrompt(expectedJobId, recordingResult);
    if (runIndex === 1 && turnIndex === 1 && options.promptOutputPath) {
      fs.mkdirSync(path.dirname(options.promptOutputPath), { recursive: true });
      fs.writeFileSync(options.promptOutputPath, prompt, "utf8");
    }
    const promptMetrics = buildPromptMetrics(prompt, phase);
    const command = commandForPrompt(options, sessionKey, prompt);
    const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
    const response = parseAgentJson(processResult.stdout);
    receipt = await inspectMockMediaReceipt(options, expectedJobId);
    validation =
      receipt.exists && receipt.jsonValid
        ? validateMockMediaContract(receipt.contract, recordingResult, expectedJobId)
        : { ok: false, checks: {} };
    classification = classifyMockMediaDelivery(
      response,
      processResult,
      expectedJobId,
      recordingResult,
      receipt,
      validation,
    );
    const priorUsageSummary = summarizeUsageForTurns(turns);
    const usageSnapshot = await readTranscriptUsageSnapshot(options, classification.sessionFile);
    const usageDelta = usageSnapshot.available
      ? diffUsage(usageSnapshot.totals, priorUsageSummary.usage)
      : emptyUsageTotals();
    const byModelDelta = usageSnapshot.available
      ? diffUsageByModel(
          usageSnapshot.byModel,
          Object.fromEntries(
            Object.entries(priorUsageSummary.byModel ?? {}).map(([modelKey, value]) => [
              modelKey,
              { assistantCalls: value.assistantCalls, totals: value.usage },
            ]),
          ),
        )
      : {};
    const assistantCallsDelta = usageSnapshot.available
      ? Math.max(0, Number(usageSnapshot.assistantCalls ?? 0) - priorUsageSummary.assistantCalls)
      : 0;
    turns.push({
      turnIndex,
      phase,
      reviewerContinuation: turnIndex > 1,
      finalReportOnly: false,
      ok: classification.ok,
      promptMetrics,
      usageMetrics: {
        available: usageSnapshot.available,
        sessionFile: usageSnapshot.sessionFile,
        error: usageSnapshot.error,
        assistantCallsDelta,
        delta: usageDelta,
        byModelDelta,
        cumulative: usageSnapshot.totals,
        byModel: usageSnapshot.byModel,
      },
      process: {
        code: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        error: processResult.error,
        stderrTail: processResult.stderr.slice(-3000),
      },
      classification,
      receipt,
      deliveryValidation: validation,
      rawJsonParsed: Boolean(response),
    });
    if (classification.ok || processResult.timedOut || processResult.code !== 0) {
      break;
    }
  }

  const failureReasons = [];
  if (!classification.ok) {
    if (classification.checks.timedOut) {
      failureReasons.push("timeout");
    }
    if (!classification.checks.toolCalls) {
      failureReasons.push("no_tool_call");
    }
    if (!classification.checks.finalJsonValid) {
      failureReasons.push("invalid_final_json");
    }
    if (!classification.checks.receiptExists) {
      failureReasons.push("receipt_missing");
    }
    if (classification.checks.receiptExists && !classification.checks.receiptJsonValid) {
      failureReasons.push("receipt_invalid_json");
    }
    if (classification.checks.receiptJsonValid && !classification.checks.contractOk) {
      failureReasons.push("receipt_contract_invalid");
    }
    if (!classification.checks.mockReceiptPathOk) {
      failureReasons.push("final_receipt_path_missing_or_wrong");
    }
    if (!failureReasons.length) {
      failureReasons.push("unclassified_partial");
    }
  }
  const deliveryResult = {
    mode: "mock-media-tool",
    attempted: true,
    ok: classification.ok,
    evidence: classification.ok
      ? "Qwen created a valid mock media delivery receipt"
      : "Qwen did not create a valid mock media delivery receipt",
    receipt,
    checks: validation?.checks ?? {},
  };
  return {
    runIndex,
    sessionKey,
    expectedJobId,
    activeJobId: expectedJobId,
    candidateJobIds: [expectedJobId],
    ok: classification.ok,
    executorOk: classification.ok,
    e2e: {
      waitRecording: true,
      deliveryMode: "mock-media-tool",
      recording: recordingResult,
      delivery: deliveryResult,
      setup: setupResult,
    },
    process: {
      durationMs: Date.now() - started,
    },
    classification,
    diagnostics: {
      failureReasons,
      plannedJobIdsSeen: [],
      plannedJobIdCount: 0,
      rawPlannedJobIdCount: 0,
      acceptedJobIdsSeen: [expectedJobId],
      acceptedJobIdCount: 1,
      acceptedPlannedJobIdsSeen: [],
      acceptedPlannedJobIdCount: 0,
      duplicatePlannedJobIds: 0,
      executorJobIdsSeen: [],
      executorJobIdCount: 0,
      unexecutedActionJson: false,
      messageSchemaError: false,
      noToolCall: classification.checks.toolCalls === 0,
      turnCount: turns.length,
      turnsWithToolCalls: turns.filter((turn) => turn.classification?.checks.toolCalls > 0).length,
    },
    turns,
    usageSummary: summarizeUsageForTurns(turns),
  };
}

async function runFullE2E(options, runIndex, runId) {
  const started = Date.now();
  const createOptions = {
    ...options,
    waitRecording: false,
    deliveryMode: "none",
  };
  const createResult = await runOne(createOptions, runIndex, runId);
  const expectedJobId = createResult.activeJobId || createResult.expectedJobId;
  const sessionKey = createResult.sessionKey;
  const waitSessionKey = `${sessionKey}-wait`;
  const deliverySessionKey = `${sessionKey}-deliver`;
  const turns = [...(createResult.turns ?? [])];
  const phaseResults = {
    createRequest: createResult,
    waitValidate: null,
    delivery: null,
  };
  const runnerRecovery = {
    recordingResubmitted: false,
    resubmitResult: null,
  };

  let recordingResult = null;
  let waitClassification = null;
  let deliveryClassification = null;
  let deliveryReceipt = null;
  let deliveryValidation = null;

  if (createResult.classification?.artifactOk) {
    recordingResult = await waitForRecordingResult(options, expectedJobId);
    if (!recordingResult?.video_valid) {
      const resubmitResult = await createDeterministicRecordingRequest(options, expectedJobId);
      runnerRecovery.recordingResubmitted = true;
      runnerRecovery.resubmitResult = resubmitResult;
      recordingResult = resubmitResult.ok
        ? await waitForRecordingResult(options, expectedJobId)
        : recordingResult;
    }
  }

  if (recordingResult?.video_valid) {
    for (let turnIndex = 1; turnIndex <= options.maxExecutorTurns; turnIndex += 1) {
      const phase = turnIndex === 1 ? "wait_validate_recording" : "wait_validate_recording_retry";
      const prompt =
        turnIndex === 1
          ? buildWaitValidateRecordingPrompt(expectedJobId, recordingResult)
          : buildWaitValidateRecordingRetryPrompt(expectedJobId, recordingResult);
      const promptMetrics = buildPromptMetrics(prompt, phase);
      const command = commandForPrompt(options, waitSessionKey, prompt);
      const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
      const response = parseAgentJson(processResult.stdout);
      waitClassification = classifyWaitValidateRecording(
        response,
        processResult,
        expectedJobId,
        recordingResult,
      );
      const priorUsageSummary = summarizeUsageForTurns(
        turns.filter((turn) => turn.sessionKey === waitSessionKey),
      );
      const usageSnapshot = await readTranscriptUsageSnapshot(options, waitClassification.sessionFile);
      const usageDelta = usageSnapshot.available
        ? diffUsage(usageSnapshot.totals, priorUsageSummary.usage)
        : emptyUsageTotals();
      const byModelDelta = usageSnapshot.available
        ? diffUsageByModel(
            usageSnapshot.byModel,
            Object.fromEntries(
              Object.entries(priorUsageSummary.byModel ?? {}).map(([modelKey, value]) => [
                modelKey,
                { assistantCalls: value.assistantCalls, totals: value.usage },
              ]),
            ),
          )
        : {};
      const assistantCallsDelta = usageSnapshot.available
        ? Math.max(0, Number(usageSnapshot.assistantCalls ?? 0) - priorUsageSummary.assistantCalls)
        : 0;
      turns.push({
        turnIndex: turns.length + 1,
        sessionKey: waitSessionKey,
        phase,
        phaseTurnIndex: turnIndex,
        reviewerContinuation: turnIndex > 1,
        finalReportOnly: false,
        ok: waitClassification.ok,
        promptMetrics,
        usageMetrics: {
          available: usageSnapshot.available,
          sessionFile: usageSnapshot.sessionFile,
          error: usageSnapshot.error,
          assistantCallsDelta,
          delta: usageDelta,
          byModelDelta,
          cumulative: usageSnapshot.totals,
          byModel: usageSnapshot.byModel,
        },
        process: {
          code: processResult.code,
          signal: processResult.signal,
          timedOut: processResult.timedOut,
          error: processResult.error,
          stderrTail: processResult.stderr.slice(-3000),
        },
        classification: waitClassification,
        rawJsonParsed: Boolean(response),
      });
      if (waitClassification.ok || processResult.timedOut || processResult.code !== 0) {
        break;
      }
    }
  }

  if (waitClassification?.ok) {
    for (let turnIndex = 1; turnIndex <= options.maxExecutorTurns; turnIndex += 1) {
      const phase =
        turnIndex === 1
          ? "deliver_recording_or_mock_media"
          : "deliver_recording_or_mock_media_retry";
      const prompt =
        turnIndex === 1
          ? buildMockMediaDeliveryPrompt(expectedJobId, recordingResult)
          : buildMockMediaDeliveryRetryPrompt(expectedJobId, recordingResult);
      const promptMetrics = buildPromptMetrics(prompt, phase);
      const command = commandForPrompt(options, deliverySessionKey, prompt);
      const processResult = await runProcess(command.command, command.args, options.timeoutSeconds);
      const response = parseAgentJson(processResult.stdout);
      deliveryReceipt = await inspectMockMediaReceipt(options, expectedJobId);
      deliveryValidation =
        deliveryReceipt.exists && deliveryReceipt.jsonValid
          ? validateMockMediaContract(deliveryReceipt.contract, recordingResult, expectedJobId)
          : { ok: false, checks: {} };
      deliveryClassification = classifyMockMediaDelivery(
        response,
        processResult,
        expectedJobId,
        recordingResult,
        deliveryReceipt,
        deliveryValidation,
      );
      const priorUsageSummary = summarizeUsageForTurns(
        turns.filter((turn) => turn.sessionKey === deliverySessionKey),
      );
      const usageSnapshot = await readTranscriptUsageSnapshot(
        options,
        deliveryClassification.sessionFile,
      );
      const usageDelta = usageSnapshot.available
        ? diffUsage(usageSnapshot.totals, priorUsageSummary.usage)
        : emptyUsageTotals();
      const byModelDelta = usageSnapshot.available
        ? diffUsageByModel(
            usageSnapshot.byModel,
            Object.fromEntries(
              Object.entries(priorUsageSummary.byModel ?? {}).map(([modelKey, value]) => [
                modelKey,
                { assistantCalls: value.assistantCalls, totals: value.usage },
              ]),
            ),
          )
        : {};
      const assistantCallsDelta = usageSnapshot.available
        ? Math.max(0, Number(usageSnapshot.assistantCalls ?? 0) - priorUsageSummary.assistantCalls)
        : 0;
      turns.push({
        turnIndex: turns.length + 1,
        sessionKey: deliverySessionKey,
        phase,
        phaseTurnIndex: turnIndex,
        reviewerContinuation: turnIndex > 1,
        finalReportOnly: false,
        ok: deliveryClassification.ok,
        promptMetrics,
        usageMetrics: {
          available: usageSnapshot.available,
          sessionFile: usageSnapshot.sessionFile,
          error: usageSnapshot.error,
          assistantCallsDelta,
          delta: usageDelta,
          byModelDelta,
          cumulative: usageSnapshot.totals,
          byModel: usageSnapshot.byModel,
        },
        process: {
          code: processResult.code,
          signal: processResult.signal,
          timedOut: processResult.timedOut,
          error: processResult.error,
          stderrTail: processResult.stderr.slice(-3000),
        },
        classification: deliveryClassification,
        receipt: deliveryReceipt,
        deliveryValidation,
        rawJsonParsed: Boolean(response),
      });
      if (deliveryClassification.ok || processResult.timedOut || processResult.code !== 0) {
        break;
      }
    }
  }

  const createOk = Boolean(createResult.classification?.artifactOk);
  const recordingOk = Boolean(recordingResult?.video_valid);
  const waitOk = Boolean(waitClassification?.ok);
  const deliverOk = Boolean(deliveryClassification?.ok);
  const rawGuardrailVisible = turns.some((turn) => turn.classification?.checks?.rawGuardrailVisible);
  const unresolvedToolIntent = turns.some((turn) => turn.classification?.checks?.unresolvedToolIntent);
  const finalUnresolvedToolIntent = Boolean(
    deliveryClassification?.checks?.unresolvedToolIntent ||
      (!deliveryClassification && waitClassification?.checks?.unresolvedToolIntent) ||
      (!waitClassification && createResult.classification?.checks?.unresolvedToolIntent),
  );
  const recoveredTransientToolIntent = unresolvedToolIntent && !finalUnresolvedToolIntent;
  const timedOut = turns.some((turn) => turn.classification?.checks?.timedOut);
  const toolCalls = turns.reduce(
    (total, turn) => total + Number(turn.classification?.checks?.currentToolCalls ?? 0),
    0,
  );
  const tools = Array.from(
    new Set(turns.flatMap((turn) => turn.classification?.checks?.tools ?? [])),
  );
  const phaseScores = [
    createResult.classification?.score,
    waitClassification?.score,
    deliveryClassification?.score,
  ].filter((score) => Number.isFinite(score));
  const score = createOk && recordingOk && waitOk && deliverOk
    ? 100
    : Math.round(average(phaseScores) ?? 0);
  const ok = createOk && recordingOk && waitOk && deliverOk && !rawGuardrailVisible && !finalUnresolvedToolIntent;
  const checks = {
    statusOk: true,
    timedOut,
    toolCalls,
    currentToolCalls: toolCalls,
    tools,
    rawGuardrailVisible,
    unresolvedToolIntent: finalUnresolvedToolIntent,
    transientUnresolvedToolIntent: unresolvedToolIntent,
    recoveredTransientToolIntent,
    finalJsonValid: createOk && waitOk && deliverOk,
    statusDone: createOk && waitOk && deliverOk,
    expectedJobId: true,
    externalArtifactExists: createOk,
    externalJsonValid: createOk,
    externalCaptureValid: deliverOk,
    createRequestOk: createOk,
    recordingValidVerdict: waitOk,
    actualVideoValid: recordingOk,
    deliveryOk: deliverOk,
    noFuturePromise: !finalUnresolvedToolIntent,
  };
  const classification = {
    ok,
    artifactOk: createOk,
    score,
    grade: score >= 90 ? "strong" : score >= 80 ? "pass" : score >= 55 ? "partial" : "weak",
    checks,
    finalJson: {
      status: ok ? "done" : "failed",
      job_id: expectedJobId,
      phases: {
        create_request: createOk,
        wait_validate_recording: waitOk,
        deliver_recording_or_mock_media: deliverOk,
      },
    },
    payloadText: "",
  };

  const failureReasons = [];
  if (!ok) {
    if (!createOk) {
      failureReasons.push("create_request_failed");
    }
    if (createOk && !recordingOk) {
      failureReasons.push("recording_failed");
    }
    if (recordingOk && !waitOk) {
      failureReasons.push("wait_validate_failed");
    }
    if (waitOk && !deliverOk) {
      failureReasons.push("delivery_failed");
    }
    if (timedOut) {
      failureReasons.push("timeout");
    }
    if (rawGuardrailVisible || finalUnresolvedToolIntent) {
      failureReasons.push("guardrail_or_unresolved_tool_intent");
    }
    if (!failureReasons.length) {
      failureReasons.push("unclassified_partial");
    }
  }
  const deliveryResult = {
    mode: "mock-media-tool",
    attempted: Boolean(waitClassification?.ok),
    ok: deliverOk,
    evidence: deliverOk
      ? "Qwen created a valid mock media delivery receipt"
      : "Qwen did not create a valid mock media delivery receipt",
    receipt: deliveryReceipt,
    checks: deliveryValidation?.checks ?? {},
  };
  phaseResults.waitValidate = waitClassification;
  phaseResults.delivery = deliveryClassification;
  return {
    runIndex,
    sessionKey,
    expectedJobId,
    activeJobId: expectedJobId,
    candidateJobIds: createResult.candidateJobIds ?? [expectedJobId],
    ok,
    executorOk: ok,
    e2e: {
      waitRecording: true,
      deliveryMode: "mock-media-tool",
      recording: recordingResult,
      delivery: deliveryResult,
      setup: createResult.e2e?.setup,
      runnerRecovery,
      phaseResults,
    },
    process: {
      durationMs: Date.now() - started,
    },
    classification,
    diagnostics: {
      failureReasons,
      plannedJobIdsSeen: createResult.diagnostics?.plannedJobIdsSeen ?? [],
      plannedJobIdCount: createResult.diagnostics?.plannedJobIdCount ?? 0,
      rawPlannedJobIdCount: createResult.diagnostics?.rawPlannedJobIdCount ?? 0,
      acceptedJobIdsSeen: [expectedJobId],
      acceptedJobIdCount: 1,
      acceptedPlannedJobIdsSeen: createResult.diagnostics?.acceptedPlannedJobIdsSeen ?? [],
      acceptedPlannedJobIdCount: createResult.diagnostics?.acceptedPlannedJobIdCount ?? 0,
      duplicatePlannedJobIds: createResult.diagnostics?.duplicatePlannedJobIds ?? 0,
      executorJobIdsSeen: createResult.diagnostics?.executorJobIdsSeen ?? [],
      executorJobIdCount: createResult.diagnostics?.executorJobIdCount ?? 0,
      unexecutedActionJson: createResult.diagnostics?.unexecutedActionJson ?? false,
      messageSchemaError: false,
      noToolCall: toolCalls === 0,
      recoveredTransientToolIntent,
      turnCount: turns.length,
      turnsWithToolCalls: turns.filter((turn) => turn.classification?.checks.toolCalls > 0).length,
    },
    turns,
    usageSummary: summarizeUsageForTurns(turns),
  };
}

function average(values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

function summarizeUsageForTurns(turns) {
  const phases = {};
  const byModel = {};
  const totals = emptyUsageTotals();
  let promptEstimatedTokens = 0;
  let promptChars = 0;
  let assistantCalls = 0;
  let usageAvailableTurns = 0;
  for (const turn of turns) {
    const phase = turn.phase || "unknown";
    phases[phase] ??= {
      turns: 0,
      assistantCalls: 0,
      promptEstimatedTokens: 0,
      promptChars: 0,
      usage: emptyUsageTotals(),
    };
    phases[phase].turns += 1;
    phases[phase].assistantCalls += Number(turn.usageMetrics?.assistantCallsDelta ?? 0);
    phases[phase].promptEstimatedTokens += Number(turn.promptMetrics?.estimatedTokens ?? 0);
    phases[phase].promptChars += Number(turn.promptMetrics?.chars ?? 0);
    promptEstimatedTokens += Number(turn.promptMetrics?.estimatedTokens ?? 0);
    promptChars += Number(turn.promptMetrics?.chars ?? 0);
    assistantCalls += Number(turn.usageMetrics?.assistantCallsDelta ?? 0);
    if (turn.usageMetrics?.available) {
      usageAvailableTurns += 1;
    }
    for (const [modelKey, modelUsage] of Object.entries(turn.usageMetrics?.byModelDelta ?? {})) {
      byModel[modelKey] ??= {
        assistantCalls: 0,
        usage: emptyUsageTotals(),
      };
      byModel[modelKey].assistantCalls += Number(modelUsage.assistantCalls ?? 0);
      byModel[modelKey].usage = addUsage(byModel[modelKey].usage, modelUsage.totals);
    }
    phases[phase].usage = addUsage(phases[phase].usage, turn.usageMetrics?.delta);
    Object.assign(totals, addUsage(totals, turn.usageMetrics?.delta));
  }
  return {
    turns: turns.length,
    usageAvailableTurns,
    assistantCalls,
    promptChars,
    promptEstimatedTokens,
    usage: totals,
    byModel,
    phases,
  };
}

function summarizeUsageForResults(results) {
  const phases = {};
  const byModel = {};
  const totals = emptyUsageTotals();
  let promptEstimatedTokens = 0;
  let promptChars = 0;
  let assistantCalls = 0;
  let usageAvailableTurns = 0;
  let turns = 0;
  for (const result of results) {
    const runUsage = result.usageSummary ?? summarizeUsageForTurns(result.turns ?? []);
    turns += Number(runUsage.turns ?? 0);
    usageAvailableTurns += Number(runUsage.usageAvailableTurns ?? 0);
    assistantCalls += Number(runUsage.assistantCalls ?? 0);
    promptEstimatedTokens += Number(runUsage.promptEstimatedTokens ?? 0);
    promptChars += Number(runUsage.promptChars ?? 0);
    Object.assign(totals, addUsage(totals, runUsage.usage));
    for (const [modelKey, modelUsage] of Object.entries(runUsage.byModel ?? {})) {
      byModel[modelKey] ??= {
        assistantCalls: 0,
        usage: emptyUsageTotals(),
      };
      byModel[modelKey].assistantCalls += Number(modelUsage.assistantCalls ?? 0);
      byModel[modelKey].usage = addUsage(byModel[modelKey].usage, modelUsage.usage);
    }
    for (const [phase, phaseUsage] of Object.entries(runUsage.phases ?? {})) {
      phases[phase] ??= {
        turns: 0,
        assistantCalls: 0,
        promptEstimatedTokens: 0,
        promptChars: 0,
        usage: emptyUsageTotals(),
      };
      phases[phase].turns += Number(phaseUsage.turns ?? 0);
      phases[phase].assistantCalls += Number(phaseUsage.assistantCalls ?? 0);
      phases[phase].promptEstimatedTokens += Number(phaseUsage.promptEstimatedTokens ?? 0);
      phases[phase].promptChars += Number(phaseUsage.promptChars ?? 0);
      phases[phase].usage = addUsage(phases[phase].usage, phaseUsage.usage);
    }
  }
  return {
    turns,
    usageAvailableTurns,
    assistantCalls,
    promptChars,
    promptEstimatedTokens,
    usage: totals,
    byModel,
    phases,
  };
}

function summarize(results) {
  const count = (predicate) => results.filter(predicate).length;
  const scores = results.map((result) => result.classification.score);
  const failureReasons = {};
  for (const result of results) {
    for (const reason of result.diagnostics?.failureReasons ?? []) {
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
    }
  }
  const plannedJobIdCounts = results.map((result) => result.diagnostics?.plannedJobIdCount ?? 0);
  const acceptedPlannedJobIdCounts = results.map(
    (result) => result.diagnostics?.acceptedPlannedJobIdCount ?? 0,
  );
  return {
    total: results.length,
    pass: count((result) => result.ok),
    partial: count((result) => !result.ok),
    executorPass: count((result) => result.executorOk ?? result.ok),
    artifactPass: count((result) => result.classification.artifactOk),
    recordingValid: count((result) => result.e2e?.recording?.video_valid === true),
    deliveryOk: count((result) => result.e2e?.delivery?.ok === true),
    deliveryAttempted: count((result) => result.e2e?.delivery?.attempted === true),
    reviewerRecoverable: count(
      (result) => result.classification.artifactOk && !result.classification.ok,
    ),
    averageScore: average(scores),
    minScore: scores.length ? Math.min(...scores) : null,
    maxScore: scores.length ? Math.max(...scores) : null,
    toolCallRuns: count((result) => result.classification.checks.toolCalls > 0),
    validJsonRuns: count((result) => result.classification.checks.finalJsonValid),
    statusDoneRuns: count((result) => result.classification.checks.statusDone),
    expectedJobIdRuns: count((result) => result.classification.checks.expectedJobId),
    externalArtifactRuns: count((result) => result.classification.checks.externalArtifactExists),
    externalCaptureValidRuns: count(
      (result) => result.classification.checks.externalCaptureValid,
    ),
    rawGuardrailVisible: count((result) => result.classification.checks.rawGuardrailVisible),
    unresolvedToolIntent: count((result) => result.classification.checks.unresolvedToolIntent),
    timedOut: count((result) => result.classification.checks.timedOut),
    diagnostics: {
      failureReasons,
      duplicatePlannedJobRuns: count(
        (result) => (result.diagnostics?.duplicatePlannedJobIds ?? 0) > 0,
      ),
      maxPlannedJobIdsSeen: plannedJobIdCounts.length ? Math.max(...plannedJobIdCounts) : 0,
      maxAcceptedPlannedJobIdsSeen: acceptedPlannedJobIdCounts.length
        ? Math.max(...acceptedPlannedJobIdCounts)
        : 0,
      unexecutedActionJsonRuns: count((result) => result.diagnostics?.unexecutedActionJson),
      messageSchemaErrorRuns: count((result) => result.diagnostics?.messageSchemaError),
      noToolCallRuns: count((result) => result.diagnostics?.noToolCall),
    },
    usage: summarizeUsageForResults(results),
  };
}

function buildReport(options, params) {
  const results = params.results ?? [];
  const runStatus = params.runStatus ?? "running";
  return {
    ok:
      runStatus === "complete" &&
      results.length === options.runs &&
      results.every((entry) => entry.ok),
    generatedAt: new Date().toISOString(),
    startedAt: params.startedAt,
    completedAt: runStatus === "complete" || runStatus === "failed" ? new Date().toISOString() : null,
    runStatus,
    completedRuns: results.length,
    requestedRuns: options.runs,
    inProgressRun: params.inProgressRun ?? null,
    lastError: params.lastError ?? null,
    host: os.hostname(),
    model: options.model,
    dockerContainer: options.dockerContainer,
    godotSkillPath: options.godotSkillPath,
    waitRecording: options.waitRecording,
    recordingTimeoutSeconds: options.recordingTimeoutSeconds,
    deliveryMode: options.deliveryMode,
    summary: summarize(results),
    results,
  };
}

function writeReport(outputPath, options, params) {
  writeJson(outputPath, buildReport(options, params));
}

async function runRewriteSmoke(options, index, runId) {
  const sessionKey = `${options.sessionPrefix}-rewrite-smoke-${runId}-${index}`;
  const startedAt = new Date().toISOString();
  const processResult = await runProcess(
    "node",
    ["scripts/test-projects.mjs", "src/agents/planned-execution.test.ts"],
    Math.min(options.timeoutSeconds, 120),
  );
  const ok = processResult.code === 0 && !processResult.timedOut;
  const evidence = [
    processResult.stdout.includes("1 passed") ? "planned-execution test file passed" : null,
    processResult.stdout.includes("6 passed") ? "planned-execution route tests passed" : null,
  ].filter(Boolean);
  return {
    ok,
    sessionKey,
    startedAt,
    completedAt: new Date().toISOString(),
    classification: {
      score: ok ? 100 : 0,
      checks: {
        openClawRewriteSmoke: ok,
        plannedExecutionTestsPassed: ok,
      },
      evidence,
      diagnostics: {
        exitCode: processResult.code,
        signal: processResult.signal,
        timedOut: processResult.timedOut,
        stderrTail: processResult.stderr.slice(-1000),
      },
    },
    usage: {
      phases: {
        rewrite_smoke: {
          turns: 1,
          assistantCalls: 0,
          promptEstimatedTokens: 0,
          promptChars: 0,
          usage: {},
        },
      },
      total: {},
    },
  };
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runId = Date.now().toString(36);
  const outputPath = options.outputPath || defaultOutputPath();
  const startedAt = new Date().toISOString();
  const results = [];
  activeReportContext = { outputPath, options, startedAt, results };
  writeReport(outputPath, options, {
    startedAt,
    results,
    runStatus: "running",
  });
  for (let index = 1; index <= options.runs; index += 1) {
    process.stdout.write(`planned-executor ${index}/${options.runs}\n`);
    writeReport(outputPath, options, {
      startedAt,
      results,
      runStatus: "running",
      inProgressRun: {
        index,
        startedAt: new Date().toISOString(),
      },
    });
    const result =
      options.phase === "rewrite-smoke"
        ? await runRewriteSmoke(options, index, runId)
        : options.phase === "wait-validate-recording"
          ? await runWaitValidateRecording(options, index, runId)
        : options.phase === "deliver-recording-or-mock-media"
            ? await runDeliverRecordingOrMockMedia(options, index, runId)
            : options.phase === "full-e2e"
              ? await runFullE2E(options, index, runId)
              : await runOne(options, index, runId);
    results.push(result);
    writeReport(outputPath, options, {
      startedAt,
      results,
      runStatus: "running",
    });
    process.stdout.write(
      `planned-executor ${index}/${options.runs} ${result.ok ? "PASS" : "PARTIAL"} score=${result.classification.score} checks=${JSON.stringify(result.classification.checks)} session=${result.sessionKey}\n`,
    );
  }
  writeReport(outputPath, options, {
    startedAt,
    results,
    runStatus: "complete",
  });
  process.stdout.write(`qwen-planned-executor: summary ${outputPath}\n`);
}

main().catch((error) => {
  if (activeReportContext) {
    try {
      writeReport(activeReportContext.outputPath, activeReportContext.options, {
        startedAt: activeReportContext.startedAt,
        results: activeReportContext.results,
        runStatus: "failed",
        lastError: error instanceof Error ? error.stack || error.message : String(error),
      });
    } catch {
      // Keep the original error reporting path if report writing itself fails.
    }
  }
  process.stderr.write(
    `qwen-planned-executor: ${error instanceof Error ? error.stack || error.message : String(error)}\n`,
  );
  process.exit(1);
});
