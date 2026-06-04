import fs from "node:fs/promises";
import path from "node:path";

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type PlannedExecutionPacketId = "godotRecording";

export type PlannedExecutionRewrite = {
  packetId: PlannedExecutionPacketId;
  prompt: string;
  jobId?: string;
};

function wildcardPatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "iu").test(value.trim());
}

function modelMatchesPatterns(modelRef: string | undefined, patterns: string[] | undefined) {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  const normalizedModelRef = modelRef?.trim();
  if (!normalizedModelRef) {
    return false;
  }
  return patterns.some((pattern) => wildcardPatternMatches(pattern, normalizedModelRef));
}

function sanitizeJobIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18);
}

function isPacketEnabled(params: {
  config?: OpenClawConfig;
  agentId?: string;
  modelRef?: string;
  packetId: PlannedExecutionPacketId;
}): boolean {
  const defaults = params.config?.agents?.defaults?.embeddedPi?.plannedExecution;
  const agentConfig =
    params.config && params.agentId ? resolveAgentConfig(params.config, params.agentId) : undefined;
  const override = agentConfig?.embeddedPi?.plannedExecution;
  const enabled = override?.enabled ?? defaults?.enabled;
  if (enabled !== true) {
    return false;
  }
  const models = override?.models ?? defaults?.models;
  if (!modelMatchesPatterns(params.modelRef, models)) {
    return false;
  }
  const packets = override?.packets ?? defaults?.packets;
  return !packets || packets.length === 0 || packets.includes(params.packetId);
}

function normalizeForIntentMatch(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeGodotRecordingExecutionRequest(prompt: string): boolean {
  const text = normalizeForIntentMatch(prompt);
  if (!text) {
    return false;
  }
  const executeNow =
    /\b(?:execute|please do|go ahead|run it|record it|send it|please execute)\b/u.test(text) ||
    /(?:请执行|开始执行|可以执行|落实)/u.test(text);
  const planOnly =
    /\b(?:what will you do|tell me your plan|just .*plan|only .*plan|plan only)\b/u.test(text) ||
    /(?:只|先).{0,8}(?:计划|方案|想法)/u.test(text);
  if (planOnly && !executeNow) {
    return false;
  }
  const mentionsGodot = /\bgodot\b/u.test(text) || /自走棋/u.test(text);
  const mentionsAutoChess =
    /\bauto chess\b/u.test(text) ||
    /\bautochess\b/u.test(text) ||
    /\broguelike auto chess mvp\b/u.test(text) ||
    /自走棋/u.test(text);
  const asksRecording =
    /\b(?:record|recording|video|capture|gameplay)\b/u.test(text) || /(?:录制|录像|视频)/u.test(text);
  const asksDelivery =
    /\b(?:send|share|deliver)\b/u.test(text) || /(?:发送|发给|分享|传给)/u.test(text);
  const asksRun =
    /\b(?:run|play|gameplay|execute)\b/u.test(text) || /(?:运行|执行|开始)/u.test(text);
  return mentionsGodot && mentionsAutoChess && asksRecording && (asksDelivery || asksRun);
}

function buildGodotRecordingPacket(params: {
  originalPrompt: string;
  runId: string;
  messageChannel?: string;
}): PlannedExecutionRewrite {
  const jobId = `qwen_planned_godot_recording_${sanitizeJobIdPart(params.runId) || "run"}`;
  const requestPath = `/home/node/.openclaw/workspace/jobs/game/requests/${jobId}.json`;
  const resultDir = `/home/node/.openclaw/workspace/jobs/game/results/${jobId}`;
  const statusPath = `${resultDir}/status.json`;
  const recordingPath = `${resultDir}/recording.mp4`;
  const probePath = `${resultDir}/video_probe.json`;
  const prompt = `PLANNED_EXECUTION_PACKET
packet_id: godotRecording
role: executor

The senior planner has already designed this workflow. Do not redesign it. Do not ask the user a question. Use tools for every filesystem, process, validation, and delivery action.

Original user request:
${params.originalPrompt.trim()}

Goal:
- Find the Godot auto chess MVP project.
- Run gameplay through the Windows host runner.
- Record a 15-second 60fps video.
- Validate the recording.
- Send the recording to the current ${params.messageChannel ?? "message"} conversation.

Fixed paths:
- project_godot: /home/node/.openclaw/workspace/games/roguelike_auto_chess_mvp/project.godot
- request_dir: /home/node/.openclaw/workspace/jobs/game/requests
- request_path: ${requestPath}
- result_dir: ${resultDir}
- status_path: ${statusPath}
- recording_path: ${recordingPath}
- probe_path: ${probePath}

Current run identity:
- current_job_id: ${jobId}
- Use only the fixed paths above. Never infer a job id from directory listings.
- Never list request_dir or result_dir to choose a job. Existing files or directories may belong to older runs.

Request JSON to create exactly:
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

Exact JSON rules:
- The request JSON above is authoritative. Do not retype path separators from memory.
- The only valid project_path is exactly "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp".
- A mixed path such as "D:\\OpenClawWorkspace\\games/roguelike_auto_chess_mvp" is invalid even if the host runner later accepts it.
- If VALIDATE_REQUEST finds any mismatch in job_id, project_path, record_seconds, record_fps, or capture.fps, rewrite request_path with the exact JSON above and stop that turn after the write tool result.

Sequential tool protocol:
- This workflow has strict dependencies. Do not parallelize dependent steps.
- In each assistant turn, call tools for exactly one phase below.
- Wait for the tool result for the current phase before starting the next phase.
- Before choosing a phase, inspect the transcript and skip phases that already have successful tool results.
- If project_godot has already been read successfully, do not repeat PROJECT_EXISTS.
- If request_path has already been written successfully, do not repeat CREATE_REQUEST.
- If request_path has already been read successfully after creation, do not repeat VALIDATE_REQUEST.
- If status_path already says status is "done", do not repeat POLL_STATUS.
- If probe_path has already been read and passes validation, do not repeat VALIDATE_VIDEO.
- On a guardrail retry or continuation, resume at the first incomplete phase, not at Phase 1.
- Never call a tool that reads or validates an artifact in the same assistant turn that creates that artifact.
- In particular, do not read request_path until the create-request tool result has returned successfully.
- Do not poll status_path until request_path has been created and read back successfully.
- Do not read probe_path until status_path says status is "done".
- Do not send recording_path until probe_path has been read and validated.
- If status_path or probe_path already proved that current_job_id is done and valid, the next incomplete step is SEND_RECORDING only.
- If the previous assistant turn was blocked by guardrail after saying the recording was validated or it would send the video, do not restart. Call the message tool for SEND_RECORDING.
- Independent reads may be batched only when they do not depend on each other or on a just-created file.

Required order:
1. PROJECT_EXISTS. Tool-call only. Verify project_godot exists.
2. CREATE_REQUEST. Tool-call only. Create request_path with the exact JSON above. Prefer one command that creates the parent directory and writes the file. A directory-only command is not enough; this step is complete only after the write/create tool result says request_path was written successfully. Stop this turn after the create/write tool call.
3. VALIDATE_REQUEST. Tool-call only. Read request_path back and validate it is JSON with top-level job_id=current_job_id, project_path exactly "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp", record_seconds=15, record_fps=60, and capture.fps=60. If any field differs, rewrite request_path with the exact JSON above and stop. Do not poll status_path after a failed validation in the same turn.
4. POLL_STATUS. Tool-call only. Read status_path. If status_path does not exist, wait 6 seconds and read the same status_path again. If status_path exists but status is not "done", wait 6 seconds and read the same status_path again. Repeat up to 8 polls. Stop polling immediately if status is "failed" or another clear failure appears. Do not use global file searches. Do not say "Now polling status"; read status_path with a tool call.
5. VALIDATE_VIDEO. Tool-call only. Read probe_path. Success requires duration_seconds >= 14.5 and average_fps >= 55.
6. SEND_RECORDING. Tool-call only. Send recording_path with the message tool using exactly: action "send", message "Here is the 15-second Godot gameplay recording.", filePath recording_path.
7. FINAL. Final answer only after send evidence exists. Delivery evidence means a tool result with ok=true, sendVideo, deliveryKind=video, or messageId.

Blocked rules:
- If project_godot is missing, final status is "blocked".
- If status_path reports failure or recording validation fails, final status is "failed" and include the exact evidence.
- If any required tool is unavailable, final status is "blocked" with the one missing capability.
- Never claim the video was sent without message-tool delivery evidence.

Final answer format:
Start with exactly:
RESPONSE_MODE: final

Then output exactly one JSON object and no markdown fence:
{
  "status": "done | blocked | failed",
  "packet_id": "godotRecording",
  "job_id": "${jobId}",
  "request_path": "${requestPath}",
  "result_dir": "${resultDir}",
  "recording_path": "${recordingPath}",
  "recording_validated": true,
  "video_probe": {
    "duration_seconds": 15,
    "average_fps": 60
  },
  "telegram_delivery": {
    "ok": true,
    "messageId": "..."
  },
  "blocker": null,
  "needs_planner_review": false
}

Important executor discipline:
- Your next assistant action should be a tool call, not prose.
- Do not write "let me", "I'll", "I will", "now I will", or "next I will" as a visible reply.
- Do not write step labels, status narration, or progress text such as "PROJECT_EXISTS", "CREATE_REQUEST", "SEND_RECORDING", "EXEC_PHASE", "Phase 1", "Phase 2", "Project exists", "Now creating", "Request created", "Validating now", or "Project exists. Now Phase 2".
- Phase labels are invalid visible replies. A phase name alone is not completion evidence and will be treated as a failed tool-call attempt.
- A tool-call turn must contain only tool calls. Do not include prose before or after the tool call.
- If you are not done, keep using tools. If you are done, use RESPONSE_MODE: final.`;

  return { packetId: "godotRecording", prompt, jobId };
}

export type PlannedExecutionFinalizerPayload = {
  text: string;
  mediaUrl: string;
};

export type PlannedExecutionFinalizerResult =
  | {
      ok: true;
      packetId: PlannedExecutionPacketId;
      jobId: string;
      resultDir: string;
      recordingPath: string;
      probe: {
        durationSeconds: number;
        averageFps: number;
        frameCount?: number;
      };
      payload: PlannedExecutionFinalizerPayload;
    }
  | {
      ok: false;
      packetId: PlannedExecutionPacketId;
      jobId?: string;
      reason: string;
    };

const DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT = "/home/node/.openclaw/workspace";
const DEFAULT_GODOT_RECORDING_MIN_SECONDS = 14.5;
const DEFAULT_GODOT_RECORDING_MIN_FPS = 55;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeGodotRecordingJobId(jobId: unknown): string | undefined {
  const normalized = typeof jobId === "string" ? jobId.trim() : "";
  if (!/^qwen_planned_godot_recording_[a-z0-9_-]+$/iu.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export async function resolvePlannedExecutionFinalizer(params: {
  plannedExecution?: {
    packetId?: string;
    jobId?: string;
  };
  workspaceRoot?: string;
  minDurationSeconds?: number;
  minFps?: number;
}): Promise<PlannedExecutionFinalizerResult | undefined> {
  if (params.plannedExecution?.packetId !== "godotRecording") {
    return undefined;
  }

  const jobId = safeGodotRecordingJobId(params.plannedExecution.jobId);
  if (!jobId) {
    return { ok: false, packetId: "godotRecording", reason: "missing_or_unsafe_job_id" };
  }

  const workspaceRoot = params.workspaceRoot?.trim() || DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT;
  const resultDir = path.join(workspaceRoot, "jobs", "game", "results", jobId);
  const statusPath = path.join(resultDir, "status.json");
  const probePath = path.join(resultDir, "video_probe.json");
  const recordingPath = path.join(resultDir, "recording.mp4");

  const status = await readJsonRecord(statusPath);
  if (status?.status !== "done") {
    return { ok: false, packetId: "godotRecording", jobId, reason: "status_not_done" };
  }

  const probeFile = await readJsonRecord(probePath);
  const statusProbe = isRecord(status.video_probe) ? status.video_probe : undefined;
  const probe = probeFile ?? statusProbe;
  const durationSeconds = finiteNumber(probe?.duration_seconds);
  const averageFps = finiteNumber(probe?.average_fps);
  const frameCount = finiteNumber(probe?.frame_count);
  if (durationSeconds === undefined || averageFps === undefined) {
    return { ok: false, packetId: "godotRecording", jobId, reason: "missing_video_probe" };
  }

  const minDurationSeconds = params.minDurationSeconds ?? DEFAULT_GODOT_RECORDING_MIN_SECONDS;
  if (durationSeconds < minDurationSeconds) {
    return { ok: false, packetId: "godotRecording", jobId, reason: "recording_too_short" };
  }

  const minFps = params.minFps ?? DEFAULT_GODOT_RECORDING_MIN_FPS;
  if (averageFps < minFps) {
    return { ok: false, packetId: "godotRecording", jobId, reason: "fps_too_low" };
  }

  try {
    const recordingStat = await fs.stat(recordingPath);
    if (!recordingStat.isFile() || recordingStat.size <= 0) {
      return { ok: false, packetId: "godotRecording", jobId, reason: "recording_missing" };
    }
  } catch {
    return { ok: false, packetId: "godotRecording", jobId, reason: "recording_missing" };
  }

  return {
    ok: true,
    packetId: "godotRecording",
    jobId,
    resultDir,
    recordingPath,
    probe: {
      durationSeconds,
      averageFps,
      ...(frameCount !== undefined ? { frameCount } : {}),
    },
    payload: {
      text: `Here is the validated Godot gameplay recording (${durationSeconds.toFixed(1)}s at ${averageFps.toFixed(0)}fps).`,
      mediaUrl: recordingPath,
    },
  };
}
export function resolvePlannedExecutionRewrite(params: {
  prompt: string;
  intentPrompt?: string;
  config?: OpenClawConfig;
  agentId?: string;
  provider?: string;
  modelId?: string;
  runId: string;
  messageChannel?: string;
}): PlannedExecutionRewrite | undefined {
  const modelRef =
    params.provider && params.modelId ? `${params.provider}/${params.modelId}` : params.modelId;
  if (
    !isPacketEnabled({
      config: params.config,
      agentId: params.agentId,
      modelRef,
      packetId: "godotRecording",
    })
  ) {
    return undefined;
  }
  if (!looksLikeGodotRecordingExecutionRequest(params.intentPrompt ?? params.prompt)) {
    return undefined;
  }
  return buildGodotRecordingPacket({
    originalPrompt: params.prompt,
    runId: params.runId,
    messageChannel: params.messageChannel,
  });
}
