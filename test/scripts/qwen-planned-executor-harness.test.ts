import { describe, expect, it } from "vitest";
import {
  classifyMockMediaDelivery,
  classifyMockMediaDeliveryEvidence,
  validateMockMediaContract,
} from "../../scripts/qwen-planned-executor-harness.mjs";

const expectedJobId = "qwen_planned_godot_recording_test";
const receiptPath = `/home/node/.openclaw/workspace/jobs/mock_media_deliveries/${expectedJobId}.json`;
const recordingResult = {
  video_valid: true,
  recording_exists: true,
  recording_path: `/home/node/.openclaw/workspace/jobs/game/results/${expectedJobId}/recording.mp4`,
};

function validContract() {
  return {
    action: "send",
    target: "current_session",
    message: `Godot auto chess gameplay recording\nJob: ${expectedJobId}\n15s 60fps validation passed`,
    media: {
      path: recordingResult.recording_path,
      mimeType: "video/mp4",
    },
    validation: {
      job_id: expectedJobId,
      duration_seconds: 15,
      average_fps: 60,
      frame_count: 900,
    },
  };
}

function finalResponse(receipt = receiptPath, textPrefix = "RESPONSE_MODE: final\n") {
  return {
    status: "ok",
    result: {
      payloads: [
        {
          text: `${textPrefix}${JSON.stringify({
            status: "done",
            job_id: expectedJobId,
            mock_delivery_receipt: receipt,
          })}`,
        },
      ],
      meta: {
        toolSummary: {
          calls: 1,
          tools: ["shell_command"],
        },
      },
    },
  };
}

describe("qwen planned executor mock media evidence", () => {
  it("accepts a valid receipt and media contract as reusable structured evidence", () => {
    const contract = validContract();
    const validation = validateMockMediaContract(contract, recordingResult, expectedJobId);
    const evidence = classifyMockMediaDeliveryEvidence({
      expectedJobId,
      finalJson: {
        status: "done",
        job_id: expectedJobId,
        mock_delivery_receipt: receiptPath,
      },
      recordingResult,
      receipt: {
        exists: true,
        jsonValid: true,
        contract,
      },
      validation,
    });

    expect(validation.ok).toBe(true);
    expect(evidence.ok).toBe(true);
    expect(evidence.artifactOk).toBe(true);
    expect(evidence.checks).toMatchObject({
      mockReceiptPathOk: true,
      receiptExists: true,
      receiptJsonValid: true,
      contractOk: true,
      actualVideoValid: true,
    });
  });

  it("rejects text-only delivery success claims without receipt evidence", () => {
    const classification = classifyMockMediaDelivery(
      finalResponse(receiptPath, "Qwen created a valid mock media delivery receipt.\n"),
      { code: 0, timedOut: false },
      expectedJobId,
      recordingResult,
      {
        exists: false,
        jsonValid: false,
        contract: null,
      },
      { ok: false, checks: {} },
    );

    expect(classification.ok).toBe(false);
    expect(classification.artifactOk).toBe(false);
    expect(classification.checks.receiptExists).toBe(false);
    expect(classification.deliveryEvidence.artifactOk).toBe(false);
  });

  it("requires the final JSON to point at the observed receipt path", () => {
    const contract = validContract();
    const validation = validateMockMediaContract(contract, recordingResult, expectedJobId);
    const classification = classifyMockMediaDelivery(
      finalResponse("/tmp/claimed-receipt.json"),
      { code: 0, timedOut: false },
      expectedJobId,
      recordingResult,
      {
        exists: true,
        jsonValid: true,
        contract,
      },
      validation,
    );

    expect(classification.ok).toBe(false);
    expect(classification.artifactOk).toBe(true);
    expect(classification.checks.mockReceiptPathOk).toBe(false);
    expect(classification.deliveryEvidence.ok).toBe(false);
  });
});
