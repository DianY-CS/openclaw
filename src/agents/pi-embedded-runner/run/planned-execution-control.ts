import type { ReplyPayload } from "../../../auto-reply/reply-payload.js";
import type { PlannedExecutionFinalizerResult } from "../../planned-execution.js";
import { shouldAttemptArtifactDelivery } from "../../planned-execution/delivery.js";
import type { PlannedExecutionPhase } from "../../planned-execution/phases.js";
export { PLANNED_EXECUTION_PHASES } from "../../planned-execution/phases.js";
export type { PlannedExecutionPhase } from "../../planned-execution/phases.js";

export const EXECUTION_PHASE_RETRY_INSTRUCTION =
  "Execution-phase correction: your previous assistant turn declared an execution phase but did not emit the required tool call. The phase label is useful state, but it is not a user-visible reply. Resume exactly at the declared phase and emit the required structured tool call now with no prose before or after. Do not restart earlier phases, do not infer a new job id from directory listings, and do not describe what you will do.";

const PLANNED_EXECUTION_PHASE_RETRY_INSTRUCTIONS: Record<PlannedExecutionPhase, string> = {
  PROJECT_EXISTS:
    "FAILED_PHASE=PROJECT_EXISTS. Emit the filesystem/process tool call that verifies the fixed project_godot path exists. Do not output PROJECT_EXISTS, EXEC_PHASE, or any status text.",
  CREATE_REQUEST:
    "FAILED_PHASE=CREATE_REQUEST. Emit only the write/create-file tool call that writes the fixed request_path with the exact request JSON from the planned execution packet. Do not read, validate, poll, send, exec, process, start Godot, restart PROJECT_EXISTS, or output CREATE_REQUEST/EXEC_PHASE text.",
  VALIDATE_REQUEST:
    "FAILED_PHASE=VALIDATE_REQUEST. Emit the tool call that reads the fixed request_path back and validates job_id, project_path, record_seconds, record_fps, and capture.fps. If a rewrite is needed, emit only the rewrite tool call. Do not poll status in this same turn and do not output VALIDATE_REQUEST/EXEC_PHASE text.",
  POLL_STATUS:
    "FAILED_PHASE=POLL_STATUS. Emit the tool call that reads the fixed status_path, or waits briefly then reads that same status_path. Do not list result directories, infer job ids, read probe_path, send video, or output POLL_STATUS/EXEC_PHASE text.",
  VALIDATE_VIDEO:
    "FAILED_PHASE=VALIDATE_VIDEO. Emit the tool call that reads the fixed probe_path and validates duration_seconds >= 14.5 and average_fps >= 55. Do not send the recording before this validation tool result and do not output VALIDATE_VIDEO/EXEC_PHASE text.",
  SEND_RECORDING:
    "FAILED_PHASE=SEND_RECORDING. Emit the message/send tool call using the fixed recording_path and the planned packet's exact delivery message. Do not restart earlier phases, do not revalidate files, and do not output SEND_RECORDING/EXEC_PHASE text.",
  FINAL:
    "FAILED_PHASE=FINAL. If delivery evidence already exists, output RESPONSE_MODE: final followed by the required JSON object. If delivery evidence does not exist, emit the missing SEND_RECORDING tool call now. Do not output FINAL/EXEC_PHASE text.",
};

export function buildExecutionPhaseRetryInstruction(
  phase: PlannedExecutionPhase | undefined,
): string {
  if (!phase) {
    return EXECUTION_PHASE_RETRY_INSTRUCTION;
  }

  return `${EXECUTION_PHASE_RETRY_INSTRUCTION}\n\n${PLANNED_EXECUTION_PHASE_RETRY_INSTRUCTIONS[phase]}`;
}

const TERMINAL_PLANNED_EXECUTION_FAILURE_REASONS = new Set([
  "missing_or_unsafe_job_id",
  "missing_video_probe",
  "request_missing",
  "request_job_id_mismatch",
  "request_project_path_mismatch",
  "request_startup_wait_mismatch",
  "request_record_seconds_mismatch",
  "request_record_fps_mismatch",
  "request_capture_missing",
  "request_capture_record_seconds_mismatch",
  "request_capture_fps_mismatch",
  "recording_too_short",
  "fps_too_low",
  "effective_fps_too_low",
]);

export function isTerminalPlannedExecutionFailure(
  result: PlannedExecutionFinalizerResult | undefined,
): result is Extract<PlannedExecutionFinalizerResult, { ok: false }> {
  return Boolean(result && !result.ok && TERMINAL_PLANNED_EXECUTION_FAILURE_REASONS.has(result.reason));
}

export function buildTerminalPlannedExecutionFailurePayload(
  result: Extract<PlannedExecutionFinalizerResult, { ok: false }>,
): ReplyPayload {
  const jobIdText = result.jobId ? ` job_id=${result.jobId}` : "";
  return {
    text: `Godot recording validation failed${jobIdText}: ${result.reason}. I did not send the recording because it did not meet the planned execution acceptance criteria.`,
    isError: true,
  };
}

export function shouldRetryPlannedExecutionCreateRequest(params: {
  plannedExecution?: { packetId?: string };
  plannedExecutionFinalizer?: PlannedExecutionFinalizerResult;
  toolMetas?: Array<{ toolName: string }>;
}): boolean {
  return Boolean(
    params.plannedExecutionFinalizer &&
      !params.plannedExecutionFinalizer.ok &&
      params.plannedExecution?.packetId === "godotRecording" &&
      params.plannedExecutionFinalizer.reason === "status_not_done" &&
      !params.toolMetas?.some((entry) => entry.toolName.trim().toLowerCase() === "write"),
  );
}

export function shouldEnterPlannedExecutionSendRecordingPhase(params: {
  plannedExecution?: { packetId?: string };
  plannedExecutionFinalizer?: PlannedExecutionFinalizerResult;
  didSendViaMessagingTool?: boolean;
  payloadAlreadyHasMedia: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  return (
    params.plannedExecution?.packetId === "godotRecording" &&
    shouldAttemptArtifactDelivery({
      artifactAccepted: params.plannedExecutionFinalizer?.ok === true,
      deliveryState: {
        didSendViaMessagingTool: params.didSendViaMessagingTool,
        payloadAlreadyHasMedia: params.payloadAlreadyHasMedia,
      },
      attempts: params.attempts,
      maxAttempts: params.maxAttempts,
    })
  );
}

export function shouldRetryPlannedExecutionSendRecording(params: {
  plannedExecution?: { packetId?: string };
  plannedExecutionFinalizer?: PlannedExecutionFinalizerResult;
  didSendViaMessagingTool?: boolean;
  payloadAlreadyHasMedia: boolean;
  attempts: number;
  maxAttempts: number;
}): boolean {
  return shouldEnterPlannedExecutionSendRecordingPhase(params);
}
