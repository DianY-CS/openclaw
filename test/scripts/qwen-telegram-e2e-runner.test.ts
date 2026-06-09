import { describe, expect, it } from "vitest";

import {
  inferEvidence,
  isTelegramVideoContentType,
} from "../../scripts/qwen-telegram-e2e-runner.mjs";

describe("qwen telegram e2e evidence", () => {
  it("recognizes TDLib and MTProto video content types", () => {
    expect(isTelegramVideoContentType("video")).toBe(true);
    expect(isTelegramVideoContentType("messageVideo")).toBe(true);
    expect(isTelegramVideoContentType("message-video")).toBe(true);
  });

  it("does not treat generic media as video evidence", () => {
    expect(
      inferEvidence("", {
        message: {
          contentType: "messagePhoto",
          hasMedia: true,
        },
      }).hasVideoSignal,
    ).toBe(false);
  });

  it("tracks structured Telegram delivery evidence without treating it as video proof", () => {
    const evidence = inferEvidence("", {
      message: {
        text: JSON.stringify({
          status: "done",
          job_id: "qwen_planned_godot_recording_test",
          recording_path:
            "/home/node/.openclaw/workspace/jobs/game/results/qwen_planned_godot_recording_test/recording.mp4",
          telegram_delivery: {
            ok: true,
            messageId: 42,
          },
        }),
      },
    });

    expect(evidence).toMatchObject({
      hasDeliveryEvidence: true,
      hasVideoSignal: false,
    });
  });

  it("tracks fenced structured final evidence from mirrored Telegram text", () => {
    const recordingPath =
      "/home/node/.openclaw/workspace/jobs/game/results/qwen_planned_godot_recording_test/recording.mp4";
    const evidence = inferEvidence("", {
      message: {
        text: `\`\`\`json
{"status":"done","job_id":"qwen_planned_godot_recording_test","recording_path":"${recordingPath}","telegram_delivery":{"ok":true,"messageId":"2986","chatId":"8672163720"}}
\`\`\``,
      },
    });

    expect(evidence.hasDeliveryEvidence).toBe(true);
  });

  it("rejects text-only video claims as delivery evidence", () => {
    expect(inferEvidence("Status is done. Video probe shows 60fps.", null)).toMatchObject({
      hasDeliveryEvidence: false,
      hasVideoSignal: false,
    });
  });

  it("requires final delivery evidence to name a job and artifact path", () => {
    const evidence = inferEvidence("", {
      message: {
        text: JSON.stringify({
          telegram_delivery: {
            ok: true,
            messageId: 42,
          },
        }),
      },
    });

    expect(evidence.hasDeliveryEvidence).toBe(false);
    expect(evidence.deliveryEvidence.checks).toMatchObject({
      jobIdPresent: false,
      artifactPathPresent: false,
      deliveryOk: true,
    });
  });

  it("treats TDLib video messages as video proof", () => {
    expect(
      inferEvidence("", {
        message: {
          contentType: "messageVideo",
        },
      }).hasVideoSignal,
    ).toBe(true);
  });

  it("aggregates transcript video and edited final JSON evidence", () => {
    const jobId = "qwen_planned_godot_recording_test";
    const recordingPath = `/home/node/.openclaw/workspace/jobs/game/results/${jobId}/recording.mp4`;
    const evidence = inferEvidence("", {
      messages: [
        {
          messageId: 10,
          contentType: "video",
          hasMedia: true,
          text: "Here is the 15-second Godot gameplay recording.",
        },
        {
          messageId: 11,
          contentType: "text",
          text: JSON.stringify({
            status: "done",
            packet_id: "godotRecording",
            job_id: jobId,
            recording_path: recordingPath,
            recording_validated: true,
            telegram_delivery: { ok: true },
          }),
        },
      ],
    });

    expect(evidence).toMatchObject({
      hasVideoSignal: true,
      hasDeliveryEvidence: true,
    });
  });
});
