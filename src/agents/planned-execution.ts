import fs from "node:fs/promises";
import path from "node:path";

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import {
  type ArtifactAcceptanceCriteria,
  validateArtifactAcceptanceCriteria,
} from "./planned-execution/artifacts.js";
import {
  buildGodotRecordingArtifact,
  buildGodotRecordingArtifactCriteria,
  buildGodotRecordingRequestArtifact as buildGodotRecordingRequestArtifactDescriptor,
  buildGodotRecordingRequestCriteria,
  DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS,
  DEFAULT_GODOT_RECORDING_MIN_FPS,
  DEFAULT_GODOT_RECORDING_MIN_SECONDS,
  GODOT_RECORDING_ARTIFACT_ID,
  GODOT_RECORDING_PROJECT_PATH,
  type GodotRecordingRequestArtifact,
} from "./planned-execution/godot-recording.js";

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

function parseGodotRecordingSendOnlyRetryJobId(prompt: string): string | undefined {
  const match = prompt.match(
    /\bPLANNED_EXECUTION_SEND_ONLY_(?:PHASE|RETRY)\s+job_id=([A-Za-z0-9_-]+)/u,
  );
  return safeGodotRecordingJobId(match?.[1]);
}

function parseGodotRecordingCreateRequestOnlyRetryJobId(prompt: string): string | undefined {
  const match = prompt.match(/\bPLANNED_EXECUTION_CREATE_REQUEST_ONLY_RETRY\s+job_id=([A-Za-z0-9_-]+)/u);
  return safeGodotRecordingJobId(match?.[1]);
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

export function buildGodotRecordingRequestArtifact(
  jobId: string,
  workspaceRoot = "/home/node/.openclaw/workspace",
): GodotRecordingRequestArtifact {
  const safeJobId = safeGodotRecordingJobId(jobId);
  if (!safeJobId) {
    throw new Error("Unsafe Godot recording job id");
  }
  return buildGodotRecordingRequestArtifactDescriptor({ jobId: safeJobId, workspaceRoot });
}

export async function ensureGodotRecordingRequest(params: {
  jobId: string;
  workspaceRoot?: string;
}): Promise<GodotRecordingRequestArtifact> {
  const artifact = buildGodotRecordingRequestArtifact(params.jobId, params.workspaceRoot);
  await fs.mkdir(path.dirname(artifact.requestPath), { recursive: true });
  await fs.writeFile(artifact.requestPath, `${JSON.stringify(artifact.request, null, 2)}\n`, "utf8");
  return artifact;
}

export async function canonicalizeExistingGodotRecordingRequestArtifacts(params: {
  jobId: string;
  workspaceRoot?: string;
}): Promise<{
  artifact: GodotRecordingRequestArtifact;
  rewrittenPaths: string[];
}> {
  const workspaceRoot = params.workspaceRoot?.trim() || DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT;
  const artifact = buildGodotRecordingRequestArtifact(params.jobId, workspaceRoot);
  const candidatePaths = [
    path.join(workspaceRoot, "jobs", "game", "requests_done", `${artifact.jobId}.json`),
    path.join(workspaceRoot, "jobs", "game", "requests", `${artifact.jobId}.json`),
  ];
  const rewrittenPaths: string[] = [];

  for (const candidatePath of candidatePaths) {
    try {
      const stat = await fs.stat(candidatePath);
      if (!stat.isFile()) {
        continue;
      }
      await fs.writeFile(candidatePath, `${JSON.stringify(artifact.request, null, 2)}\n`, "utf8");
      rewrittenPaths.push(candidatePath);
    } catch {
      // Missing artifacts are fine here. This helper only canonicalizes files
      // that already exist for the current job; it does not create new work.
    }
  }

  return { artifact, rewrittenPaths };
}

function buildGodotRecordingPacket(params: {
  originalPrompt: string;
  runId: string;
  messageChannel?: string;
}): PlannedExecutionRewrite {
  const jobId = `qwen_planned_godot_recording_${sanitizeJobIdPart(params.runId) || "run"}`;
  const requestArtifact = buildGodotRecordingRequestArtifact(jobId);
  const requestPath = requestArtifact.requestPath;
  const resultDir = `/home/node/.openclaw/workspace/jobs/game/results/${jobId}`;
  const statusPath = `${resultDir}/status.json`;
  const recordingPath = `${resultDir}/recording.mp4`;
  const probePath = `${resultDir}/video_probe.json`;
  const requestJson = JSON.stringify(requestArtifact.request, null, 2);
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
${requestJson}

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
- After request_path has been validated successfully, wait 20 seconds before the first status_path read.
- Do not read probe_path until status_path says status is "done".
- Do not send recording_path until probe_path has been read and validated.
- If status_path or probe_path already proved that current_job_id is done and valid, the next incomplete step is SEND_RECORDING only.
- If the previous assistant turn was blocked by guardrail after saying the recording was validated or it would send the video, do not restart. Call the message tool for SEND_RECORDING.
- Independent reads may be batched only when they do not depend on each other or on a just-created file.

Required order:
1. PROJECT_EXISTS. Tool-call only. Verify project_godot exists.
2. CREATE_REQUEST. Tool-call only. Create request_path with the exact JSON above. Prefer one command that creates the parent directory and writes the file. A directory-only command is not enough; this step is complete only after the write/create tool result says request_path was written successfully. Stop this turn after the create/write tool call.
3. VALIDATE_REQUEST. Tool-call only. Read request_path back and validate it is JSON with top-level job_id=current_job_id, project_path exactly "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp", record_seconds=15, record_fps=60, and capture.fps=60. If any field differs, rewrite request_path with the exact JSON above and stop. Do not poll status_path after a failed validation in the same turn.
4. POLL_STATUS. Tool-call only. First wait 20 seconds after successful VALIDATE_REQUEST, then read status_path. If status_path does not exist, wait 5 seconds and read the same status_path again. If status_path exists but status is not "done", wait 5 seconds and read the same status_path again. Repeat up to 14 polls. Stop polling immediately if status is "failed" or another clear failure appears. Do not use global file searches. Do not say "Now polling status"; read status_path with a tool call.
5. VALIDATE_VIDEO. Tool-call only. Read probe_path. Success requires duration_seconds >= 14.5, average_fps >= 55, and effective_fps >= 10 when present.
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

function buildGodotRecordingSendOnlyPacket(params: {
  jobId: string;
  messageChannel?: string;
}): PlannedExecutionRewrite | undefined {
  const jobId = safeGodotRecordingJobId(params.jobId);
  if (!jobId) {
    return undefined;
  }
  const resultDir = `/home/node/.openclaw/workspace/jobs/game/results/${jobId}`;
  const recordingPath = `${resultDir}/recording.mp4`;
  const prompt = `PLANNED_EXECUTION_PACKET
packet_id: godotRecording
role: executor
mode: send_recording_only

The senior planner has already validated the Godot recording for this run. Do not restart earlier phases. Do not read, write, create, execute, process, poll, validate, or inspect files. Do not start Godot. Do not create a new request.

Current run identity:
- current_job_id: ${jobId}
- recording_path: ${recordingPath}

Required single action:
- Call the message tool to send recording_path to the current ${params.messageChannel ?? "message"} conversation.
- Use exactly: action "send", message "Here is the 15-second Godot gameplay recording.", filePath recording_path.

Invalid actions in this retry:
- Any read/write/exec/process/browser/search tool call.
- Any request creation or validation.
- Any visible prose before the message tool call.

After the message tool succeeds, output RESPONSE_MODE: final with one JSON object that includes status "done", job_id "${jobId}", recording_path "${recordingPath}", and telegram_delivery evidence.`;

  return { packetId: "godotRecording", prompt, jobId };
}

function buildGodotRecordingCreateRequestOnlyPacket(params: {
  jobId: string;
}): PlannedExecutionRewrite | undefined {
  const jobId = safeGodotRecordingJobId(params.jobId);
  if (!jobId) {
    return undefined;
  }
  const requestArtifact = buildGodotRecordingRequestArtifact(jobId);
  const requestJson = JSON.stringify(requestArtifact.request, null, 2);
  const prompt = `PLANNED_EXECUTION_PACKET
packet_id: godotRecording
role: executor
mode: create_request_only

The senior planner detected that the previous attempt did not create the Godot runner request file. Do not restart the full workflow. Do not validate, poll, execute, process, run Godot, or send a message.

Current run identity:
- current_job_id: ${jobId}
- request_path: ${requestArtifact.requestPath}

Request JSON to write exactly:
${requestJson}

Required single action:
- Call the write/create-file tool to write exactly the JSON above to request_path.
- Stop after the write/create-file tool result.

Invalid actions in this retry:
- Any read/exec/process/browser/search/message tool call.
- Any request validation, status polling, video validation, or recording delivery.
- Any visible prose before or after the write/create-file tool call.

After the write/create-file tool succeeds, wait for the next planner/finalizer continuation.`;

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
        effectiveFps?: number;
        effectiveFrameCount?: number;
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
const DEFAULT_GODOT_RECORDING_WAIT_MS = 60_000;
const DEFAULT_GODOT_RECORDING_POLL_INTERVAL_MS = 5_000;

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

async function readFirstJsonRecordWithPath(filePaths: string[]): Promise<
  | {
      path: string;
      record: Record<string, unknown>;
    }
  | undefined
> {
  for (const filePath of filePaths) {
    const parsed = await readJsonRecord(filePath);
    if (parsed) {
      return { path: filePath, record: parsed };
    }
  }
  return undefined;
}

async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
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

function validateGodotRecordingRequestRecord(params: {
  request: Record<string, unknown> | undefined;
  jobId: string;
  requestPath: string;
}): string | undefined {
  const request = params.request;
  if (!request) {
    return "request_missing";
  }
  const capture = isRecord(request.capture) ? request.capture : undefined;
  if (!capture) {
    return "request_capture_missing";
  }

  const criteria = buildGodotRecordingRequestCriteria({
    jobId: params.jobId,
    requestPath: params.requestPath,
  });
  const validation = validateArtifactAcceptanceCriteria({
    artifacts: [],
    criteria,
    facts: {
      jsonByPath: {
        [params.requestPath]: request,
      },
    },
  });
  if (validation.ok) {
    return undefined;
  }
  return resolveGodotRecordingRequestFailureReason({
    criteria,
    checks: validation.checks,
    requestPath: params.requestPath,
  });
}

function resolveGodotRecordingRequestFailureReason(params: {
  criteria: ArtifactAcceptanceCriteria[];
  checks: Record<string, boolean>;
  requestPath: string;
}): string {
  const reasonByField: Record<string, string> = {
    job_id: "request_job_id_mismatch",
    project_path: "request_project_path_mismatch",
    startup_wait_seconds: "request_startup_wait_mismatch",
    record_seconds: "request_record_seconds_mismatch",
    record_fps: "request_record_fps_mismatch",
    "capture.record_seconds": "request_capture_record_seconds_mismatch",
    "capture.fps": "request_capture_fps_mismatch",
  };

  for (const criterion of params.criteria) {
    if (criterion.kind !== "json_field_equals") {
      continue;
    }
    const checkId = `json_field_equals:${params.requestPath}:${criterion.field}`;
    if (params.checks[checkId] === false) {
      return reasonByField[criterion.field] ?? "request_field_mismatch";
    }
  }
  return "request_field_mismatch";
}

function resolveGodotRecordingArtifactFailureReason(params: {
  checks: Record<string, boolean>;
  evidence: Record<string, unknown>;
  minDurationSeconds: number;
  minFps: number;
  minEffectiveFps: number;
}): string {
  const fileCheckId = `file_exists:${GODOT_RECORDING_ARTIFACT_ID}`;
  if (params.checks[fileCheckId] === false) {
    return "recording_missing";
  }

  const durationCheckId = `video_duration_seconds:${GODOT_RECORDING_ARTIFACT_ID}:min=${params.minDurationSeconds}`;
  if (params.checks[durationCheckId] === false) {
    const actual = isRecord(params.evidence[durationCheckId])
      ? params.evidence[durationCheckId].actual
      : undefined;
    return actual === undefined ? "missing_video_probe" : "recording_too_short";
  }

  const fpsCheckId = `video_average_fps:${GODOT_RECORDING_ARTIFACT_ID}:min=${params.minFps}`;
  if (params.checks[fpsCheckId] === false) {
    const actual = isRecord(params.evidence[fpsCheckId])
      ? params.evidence[fpsCheckId].actual
      : undefined;
    return actual === undefined ? "missing_video_probe" : "fps_too_low";
  }

  const effectiveFpsCheckId = `video_effective_fps:${GODOT_RECORDING_ARTIFACT_ID}:min=${params.minEffectiveFps}`;
  if (params.checks[effectiveFpsCheckId] === false) {
    return "effective_fps_too_low";
  }

  return "artifact_validation_failed";
}

async function resolveGodotRecordingFinalizerOnce(params: {
  jobId: string;
  resultDir: string;
  statusPath: string;
  requestPaths: string[];
  probePath: string;
  recordingPath: string;
  minDurationSeconds: number;
  minFps: number;
  minEffectiveFps: number;
}): Promise<PlannedExecutionFinalizerResult> {
  const status = await readJsonRecord(params.statusPath);
  if (status?.status !== "done") {
    return {
      ok: false,
      packetId: "godotRecording",
      jobId: params.jobId,
      reason: "status_not_done",
    };
  }

  const requestArtifact = await readFirstJsonRecordWithPath(params.requestPaths);
  const requestValidationReason = validateGodotRecordingRequestRecord({
    request: requestArtifact?.record,
    jobId: params.jobId,
    requestPath: requestArtifact?.path ?? params.requestPaths[0] ?? "request.json",
  });
  if (requestValidationReason) {
    return {
      ok: false,
      packetId: "godotRecording",
      jobId: params.jobId,
      reason: requestValidationReason,
    };
  }

  const probeFile = await readJsonRecord(params.probePath);
  const statusProbe = isRecord(status.video_probe) ? status.video_probe : undefined;
  const probe = probeFile ?? statusProbe;
  const durationSeconds = finiteNumber(probe?.duration_seconds);
  const averageFps = finiteNumber(probe?.average_fps);
  const frameCount = finiteNumber(probe?.frame_count);
  const effectiveFps = finiteNumber(probe?.effective_fps);
  const effectiveFrameCount = finiteNumber(probe?.effective_frame_count);
  const recordingExists = await isNonEmptyFile(params.recordingPath);
  const recordingArtifact = buildGodotRecordingArtifact({
    recordingPath: params.recordingPath,
    probePath: params.probePath,
  });
  const artifactCriteria = buildGodotRecordingArtifactCriteria({
    minDurationSeconds: params.minDurationSeconds,
    minFps: params.minFps,
    minEffectiveFps: params.minEffectiveFps,
  });
  const artifactValidation = validateArtifactAcceptanceCriteria({
    artifacts: [recordingArtifact],
    criteria: artifactCriteria,
    facts: {
      existingPaths: recordingExists ? [params.recordingPath] : [],
      jsonByPath: {
        ...(probe ? { [params.probePath]: probe } : {}),
      },
    },
  });
  if (!artifactValidation.ok) {
    return {
      ok: false,
      packetId: "godotRecording",
      jobId: params.jobId,
      reason: resolveGodotRecordingArtifactFailureReason({
        checks: artifactValidation.checks,
        evidence: artifactValidation.evidence,
        minDurationSeconds: params.minDurationSeconds,
        minFps: params.minFps,
        minEffectiveFps: params.minEffectiveFps,
      }),
    };
  }

  if (durationSeconds === undefined || averageFps === undefined) {
    return {
      ok: false,
      packetId: "godotRecording",
      jobId: params.jobId,
      reason: "missing_video_probe",
    };
  }

  return {
    ok: true,
    packetId: "godotRecording",
    jobId: params.jobId,
    resultDir: params.resultDir,
    recordingPath: params.recordingPath,
    probe: {
      durationSeconds,
      averageFps,
      ...(frameCount !== undefined ? { frameCount } : {}),
      ...(effectiveFps !== undefined ? { effectiveFps } : {}),
      ...(effectiveFrameCount !== undefined ? { effectiveFrameCount } : {}),
    },
    payload: {
      text: `Here is the validated Godot gameplay recording (${durationSeconds.toFixed(1)}s at ${averageFps.toFixed(0)}fps).`,
      mediaUrl: params.recordingPath,
    },
  };
}

export async function resolvePlannedExecutionFinalizer(params: {
  plannedExecution?: {
    packetId?: string;
    jobId?: string;
  };
  workspaceRoot?: string;
  minDurationSeconds?: number;
  minFps?: number;
  minEffectiveFps?: number;
  waitMs?: number;
  pollIntervalMs?: number;
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
  const requestPaths = [
    path.join(workspaceRoot, "jobs", "game", "requests_done", `${jobId}.json`),
    path.join(workspaceRoot, "jobs", "game", "requests", `${jobId}.json`),
  ];
  const probePath = path.join(resultDir, "video_probe.json");
  const recordingPath = path.join(resultDir, "recording.mp4");
  const minDurationSeconds = params.minDurationSeconds ?? DEFAULT_GODOT_RECORDING_MIN_SECONDS;
  const minFps = params.minFps ?? DEFAULT_GODOT_RECORDING_MIN_FPS;
  const minEffectiveFps =
    params.minEffectiveFps ?? DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS;
  const waitMs = Math.max(0, params.waitMs ?? DEFAULT_GODOT_RECORDING_WAIT_MS);
  const pollIntervalMs = Math.max(
    250,
    params.pollIntervalMs ?? DEFAULT_GODOT_RECORDING_POLL_INTERVAL_MS,
  );
  const deadline = Date.now() + waitMs;
  let lastResult: PlannedExecutionFinalizerResult | undefined;

  while (true) {
    lastResult = await resolveGodotRecordingFinalizerOnce({
      jobId,
      resultDir,
      statusPath,
      requestPaths,
      probePath,
      recordingPath,
      minDurationSeconds,
      minFps,
      minEffectiveFps,
    });
    if (lastResult.ok) {
      return lastResult;
    }
    if (lastResult.reason !== "status_not_done" && lastResult.reason !== "recording_missing") {
      return lastResult;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return lastResult;
    }
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
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
  if (params.messageChannel?.trim().toLowerCase() === "heartbeat") {
    return undefined;
  }
  const modelRef =
    params.provider && params.modelId ? `${params.provider}/${params.modelId}` : params.modelId;
  const enabled = isPacketEnabled({
    config: params.config,
    agentId: params.agentId,
    modelRef,
    packetId: "godotRecording",
  });
  if (!enabled) {
    return undefined;
  }
  const createRequestOnlyJobId = parseGodotRecordingCreateRequestOnlyRetryJobId(
    [params.prompt, params.intentPrompt ?? ""].join("\n"),
  );
  if (createRequestOnlyJobId) {
    return buildGodotRecordingCreateRequestOnlyPacket({
      jobId: createRequestOnlyJobId,
    });
  }
  const sendOnlyJobId = parseGodotRecordingSendOnlyRetryJobId(
    [params.prompt, params.intentPrompt ?? ""].join("\n"),
  );
  if (sendOnlyJobId) {
    return buildGodotRecordingSendOnlyPacket({
      jobId: sendOnlyJobId,
      messageChannel: params.messageChannel,
    });
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
