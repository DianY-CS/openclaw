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

  it("treats TDLib video messages as video proof", () => {
    expect(
      inferEvidence("", {
        message: {
          contentType: "messageVideo",
        },
      }).hasVideoSignal,
    ).toBe(true);
  });
});
