import { describe, expect, it } from "vitest";

import {
  buildExecutionPhaseRetryInstruction,
  buildTerminalPlannedExecutionFailurePayload,
  isTerminalPlannedExecutionFailure,
  shouldEnterPlannedExecutionSendRecordingPhase,
  shouldRetryPlannedExecutionCreateRequest,
  shouldRetryPlannedExecutionSendRecording,
} from "./planned-execution-control.js";

const validRecordingFinalizer = {
  ok: true,
  packetId: "godotRecording",
  jobId: "qwen_planned_godot_recording_abc",
  resultDir: "/workspace/jobs/game/results/qwen_planned_godot_recording_abc",
  recordingPath: "/workspace/jobs/game/results/qwen_planned_godot_recording_abc/recording.mp4",
  probe: {
    durationSeconds: 15,
    averageFps: 60,
    frameCount: 900,
  },
  payload: {
    text: "Here is the 15-second Godot gameplay recording.",
    mediaUrl: "/workspace/jobs/game/results/qwen_planned_godot_recording_abc/recording.mp4",
  },
} as const;

describe("planned execution control", () => {
  it("builds phase-specific retry instructions", () => {
    const instruction = buildExecutionPhaseRetryInstruction("SEND_RECORDING");

    expect(instruction).toContain("Execution-phase correction");
    expect(instruction).toContain("FAILED_PHASE=SEND_RECORDING");
    expect(instruction).toContain("message/send tool call");
  });

  it("detects valid recordings that need a send phase", () => {
    expect(
      shouldEnterPlannedExecutionSendRecordingPhase({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: validRecordingFinalizer,
        didSendViaMessagingTool: false,
        payloadAlreadyHasMedia: false,
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(true);

    expect(
      shouldEnterPlannedExecutionSendRecordingPhase({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: validRecordingFinalizer,
        didSendViaMessagingTool: true,
        payloadAlreadyHasMedia: false,
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(true);

    expect(
      shouldEnterPlannedExecutionSendRecordingPhase({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: validRecordingFinalizer,
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: [validRecordingFinalizer.recordingPath],
        payloadAlreadyHasMedia: false,
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(false);

    expect(
      shouldEnterPlannedExecutionSendRecordingPhase({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: validRecordingFinalizer,
        didSendViaMessagingTool: false,
        payloadAlreadyHasMedia: true,
        payloadMediaUrls: [validRecordingFinalizer.recordingPath],
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(false);
  });

  it("uses the same validity gate for send retry fallback", () => {
    expect(
      shouldRetryPlannedExecutionSendRecording({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: validRecordingFinalizer,
        didSendViaMessagingTool: false,
        payloadAlreadyHasMedia: false,
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(true);
  });

  it("retries create request only when no write tool ran", () => {
    const statusNotDone = {
      ok: false,
      packetId: "godotRecording",
      jobId: "qwen_planned_godot_recording_abc",
      reason: "status_not_done",
    } as const;

    expect(
      shouldRetryPlannedExecutionCreateRequest({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: statusNotDone,
        toolMetas: [{ toolName: "read" }],
      }),
    ).toBe(true);

    expect(
      shouldRetryPlannedExecutionCreateRequest({
        plannedExecution: { packetId: "godotRecording" },
        plannedExecutionFinalizer: statusNotDone,
        toolMetas: [{ toolName: "write" }],
      }),
    ).toBe(false);
  });

  it("turns terminal finalizer failures into error payloads", () => {
    const failure = {
      ok: false,
      packetId: "godotRecording",
      jobId: "qwen_planned_godot_recording_abc",
      reason: "recording_too_short",
    } as const;

    expect(isTerminalPlannedExecutionFailure(failure)).toBe(true);

    const payload = buildTerminalPlannedExecutionFailurePayload(failure);
    expect(payload.isError).toBe(true);
    expect(payload.text).toContain("recording_too_short");
  });
});
