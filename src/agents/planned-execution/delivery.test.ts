import { describe, expect, it } from "vitest";

import type { PlannedArtifact } from "./artifacts.js";
import {
  buildArtifactDeliveryEvidence,
  buildArtifactDeliveryRequest,
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

  it("treats existing media or message sends as delivery evidence", () => {
    expect(hasPlannedArtifactDeliveryEvidence({})).toBe(false);
    expect(hasPlannedArtifactDeliveryEvidence({ didSendViaMessagingTool: true })).toBe(true);
    expect(hasPlannedArtifactDeliveryEvidence({ payloadAlreadyHasMedia: true })).toBe(true);
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
    expect(classifyPlannedArtifactDeliveryEvidence({ didSendViaMessagingTool: true })).toEqual({
      ok: true,
      source: "messaging_tool_send",
    });
    expect(classifyPlannedArtifactDeliveryEvidence({ payloadAlreadyHasMedia: true })).toEqual({
      ok: true,
      source: "payload_media",
    });
    expect(classifyPlannedArtifactDeliveryEvidence({})).toEqual({
      ok: false,
      reason: "missing_structured_delivery_evidence",
    });
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
        deliveryState: { payloadAlreadyHasMedia: true },
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
