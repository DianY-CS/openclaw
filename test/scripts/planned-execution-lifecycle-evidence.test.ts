import { describe, expect, it } from "vitest";

import {
  classifyMockMediaDeliveryEvidence,
  classifyStructuredTelegramDeliveryEvidence,
  classifyTelegramPlannedExecutionEvidence,
} from "../../scripts/lib/planned-execution-lifecycle-evidence.mjs";

const expectedJobId = "qwen_planned_godot_recording_test";
const recordingPath = `/home/node/.openclaw/workspace/jobs/game/results/${expectedJobId}/recording.mp4`;

describe("planned execution lifecycle evidence classifier", () => {
  it("accepts Telegram delivery finalization only when it binds job and artifact path", () => {
    const evidence = classifyStructuredTelegramDeliveryEvidence({
      parsed: {
        message: {
          text: JSON.stringify({
            status: "done",
            job_id: expectedJobId,
            recording_path: recordingPath,
            telegram_delivery: {
              ok: true,
              message_id: "123",
            },
          }),
        },
      },
      expectedJobId,
      expectedArtifactPath: recordingPath,
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.checks).toMatchObject({
      expectedJobId: true,
      expectedArtifactPath: true,
      deliveryOk: true,
      deliveryMessageIdPresent: true,
    });
  });

  it("accepts prefixed final-mode JSON when the full object is present", () => {
    const evidence = classifyStructuredTelegramDeliveryEvidence({
      parsed: {
        message: {
          text: `RESPONSE_MODE: final

${JSON.stringify({
  status: "done",
  job_id: expectedJobId,
  recording_path: recordingPath,
  telegram_delivery: {
    ok: true,
    messageId: "123",
  },
})}`,
        },
      },
    });

    expect(evidence.ok).toBe(true);
  });

  it("accepts delivery path evidence when it is bound to the artifact path", () => {
    const evidence = classifyStructuredTelegramDeliveryEvidence({
      parsed: {
        message: {
          text: JSON.stringify({
            status: "done",
            job_id: expectedJobId,
            recording_path: recordingPath,
            telegram_delivery: {
              ok: true,
              path: recordingPath,
            },
          }),
        },
      },
      expectedJobId,
      expectedArtifactPath: recordingPath,
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.checks.deliveryPathMatchesArtifact).toBe(true);
  });

  it("accepts compact runtime final evidence bound to job and artifact path", () => {
    const evidence = classifyStructuredTelegramDeliveryEvidence({
      parsed: {
        message: {
          text: JSON.stringify({
            status: "done",
            job_id: expectedJobId,
            recording_path: recordingPath,
            telegram_delivery: {
              ok: true,
            },
          }),
        },
      },
      expectedJobId,
      expectedArtifactPath: recordingPath,
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.checks.deliveryBoundToArtifact).toBe(true);
  });

  it("rejects delivery path evidence when it is not bound to the artifact path", () => {
    const evidence = classifyStructuredTelegramDeliveryEvidence({
      parsed: {
        message: {
          text: JSON.stringify({
            status: "done",
            job_id: expectedJobId,
            recording_path: recordingPath,
            telegram_delivery: {
              ok: true,
              path: "/tmp/other.mp4",
            },
          }),
        },
      },
      expectedJobId,
      expectedArtifactPath: recordingPath,
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.checks.deliveryPathMatchesArtifact).toBe(false);
  });

  it("rejects video prose and unbound media as delivery success", () => {
    expect(
      classifyTelegramPlannedExecutionEvidence("Video probe shows 60fps", {
        message: {
          contentType: "messageVideo",
        },
      }),
    ).toMatchObject({
      hasVideoSignal: true,
      hasDeliveryEvidence: false,
    });
  });

  it("classifies mock media receipts from structured receipt and contract facts", () => {
    const evidence = classifyMockMediaDeliveryEvidence({
      expectedJobId,
      finalJson: {
        job_id: expectedJobId,
        mock_delivery_receipt: `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`,
      },
      recordingResult: {
        video_valid: true,
      },
      receipt: {
        exists: true,
        jsonValid: true,
      },
      validation: {
        ok: true,
        checks: {
          actionOk: true,
          mediaPathOk: true,
          mimeTypeOk: true,
          captionOk: true,
          validationOk: true,
        },
      },
    });

    expect(evidence.ok).toBe(true);
    expect(evidence.artifactOk).toBe(true);
  });
});
