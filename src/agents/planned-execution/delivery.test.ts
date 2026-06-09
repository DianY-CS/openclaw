import { describe, expect, it } from "vitest";

import type { PlannedArtifact } from "./artifacts.js";
import {
  buildArtifactDeliveryEvidence,
  buildArtifactDeliveryRequest,
  buildPlannedArtifactDeliveryFinalEvidence,
  buildPlannedArtifactDeliveryFinalText,
  classifyPlannedArtifactDeliveryEvidence,
  hasPlannedArtifactDeliveryEvidence,
  isArtifactDeliveryEvidenceOk,
  shouldAttemptArtifactDelivery,
} from "./delivery.js";

const recordingArtifact = {
  id: "recording",
  kind: "video",
  path: "/workspace/jobs/game/results/job/recording.mp4",
  required: true,
} satisfies PlannedArtifact;

describe("planned artifact delivery helpers", () => {
  it("detects explicit delivery evidence", () => {
    expect(isArtifactDeliveryEvidenceOk(undefined)).toBe(false);
    expect(
      isArtifactDeliveryEvidenceOk({
        ok: true,
        artifactId: "recording",
        channel: "telegram",
        mode: "real",
        messageId: "42",
      }),
    ).toBe(true);
  });

  it("requires fallback media evidence to match the planned artifact path", () => {
    expect(hasPlannedArtifactDeliveryEvidence({})).toBe(false);
    expect(
      hasPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: [recordingArtifact.path],
      }),
    ).toBe(true);
    expect(
      hasPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        payloadAlreadyHasMedia: true,
        payloadMediaUrls: [`file://${recordingArtifact.path}`],
      }),
    ).toBe(true);
    expect(
      hasPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: ["/workspace/jobs/game/results/job/other.mp4"],
      }),
    ).toBe(false);
    expect(
      hasPlannedArtifactDeliveryEvidence({
        artifactPath: "C:\\OpenClawWorkspace\\jobs\\game\\results\\job\\recording.mp4",
        payloadAlreadyHasMedia: true,
        payloadMediaUrls: ["file:///C:/OpenClawWorkspace/jobs/game/results/job/recording.mp4"],
      }),
    ).toBe(true);
    expect(
      hasPlannedArtifactDeliveryEvidence({
        artifactPath: "C:\\OpenClawWorkspace\\jobs\\game\\results\\job\\recording.mp4",
        payloadAlreadyHasMedia: true,
        payloadMediaUrls: ["/C:/OpenClawWorkspace/jobs/game/results/job/recording.mp4"],
      }),
    ).toBe(true);
  });

  it("classifies delivery evidence from structured runtime state", () => {
    const evidence = buildArtifactDeliveryEvidence({
      ok: true,
      artifactId: "recording",
      channel: "telegram",
      mode: "real",
      messageId: "42",
    });

    expect(classifyPlannedArtifactDeliveryEvidence({ deliveryEvidence: evidence })).toEqual({
      ok: true,
      source: "delivery_evidence",
      evidence,
    });
    expect(
      classifyPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: [recordingArtifact.path],
      }),
    ).toEqual({
      ok: true,
      source: "messaging_tool_media",
      path: recordingArtifact.path,
    });
    expect(
      classifyPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        payloadAlreadyHasMedia: true,
        payloadMediaUrls: [recordingArtifact.path],
      }),
    ).toEqual({
      ok: true,
      source: "payload_media",
      path: recordingArtifact.path,
    });
    expect(
      classifyPlannedArtifactDeliveryEvidence({
        artifactPath: recordingArtifact.path,
        didSendViaMessagingTool: true,
        messagingToolSentMediaUrls: [],
      }),
    ).toEqual({
      ok: false,
      reason: "missing_artifact_path_match",
    });
    expect(classifyPlannedArtifactDeliveryEvidence({})).toEqual({
      ok: false,
      reason: "missing_structured_delivery_evidence",
    });
  });

  it("builds final delivery evidence bound to job and artifact path", () => {
    const delivery = classifyPlannedArtifactDeliveryEvidence({
      artifactPath: recordingArtifact.path,
      didSendViaMessagingTool: true,
      messagingToolSentMediaUrls: [recordingArtifact.path],
    });

    expect(delivery.ok).toBe(true);
    if (!delivery.ok) {
      throw new Error("expected delivery evidence");
    }

    const evidence = buildPlannedArtifactDeliveryFinalEvidence({
      packetId: "godotRecording",
      jobId: "qwen_planned_godot_recording_test",
      artifactPath: recordingArtifact.path,
      recordingValidated: true,
      videoProbe: {
        duration_seconds: 15,
        average_fps: 60,
      },
      delivery,
    });

    expect(evidence).toMatchObject({
      status: "done",
      packet_id: "godotRecording",
      job_id: "qwen_planned_godot_recording_test",
      recording_path: recordingArtifact.path,
      telegram_delivery: {
        ok: true,
      },
    });
    expect(buildPlannedArtifactDeliveryFinalText(evidence)).toBe(JSON.stringify(evidence));
  });

  it("gates delivery attempts on accepted artifacts, missing evidence, and attempt budget", () => {
    expect(
      shouldAttemptArtifactDelivery({
        artifactAccepted: true,
        deliveryState: {},
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(true);

    expect(
      shouldAttemptArtifactDelivery({
        artifactAccepted: true,
        deliveryState: {
          artifactPath: recordingArtifact.path,
          payloadAlreadyHasMedia: true,
          payloadMediaUrls: [recordingArtifact.path],
        },
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(false);

    expect(
      shouldAttemptArtifactDelivery({
        artifactAccepted: false,
        deliveryState: {},
        attempts: 0,
        maxAttempts: 1,
      }),
    ).toBe(false);

    expect(
      shouldAttemptArtifactDelivery({
        artifactAccepted: true,
        deliveryState: {},
        attempts: 1,
        maxAttempts: 1,
      }),
    ).toBe(false);
  });

  it("builds delivery request and evidence records", () => {
    expect(
      buildArtifactDeliveryRequest({
        artifact: recordingArtifact,
        channel: "telegram",
        deliveryMode: "real",
        caption: "Here is the recording.",
      }),
    ).toEqual({
      artifact: recordingArtifact,
      channel: "telegram",
      deliveryMode: "real",
      caption: "Here is the recording.",
    });

    expect(
      buildArtifactDeliveryEvidence({
        ok: true,
        artifactId: "recording",
        channel: "telegram",
        mode: "real",
        messageId: "42",
        mediaType: "video",
      }),
    ).toEqual({
      ok: true,
      artifactId: "recording",
      channel: "telegram",
      mode: "real",
      messageId: "42",
      mediaType: "video",
    });
  });
});
