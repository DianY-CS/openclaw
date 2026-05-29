import { describe, expect, it } from "vitest";

import { __testing } from "./run.js";

const {
  looksLikeDeferredToolIntent,
  matchesModelPattern,
  shouldTriggerToolIntentGuardrail,
} = __testing;

const enabledConfig = {
  enabled: true,
  models: ["llamacpp/*qwen*"],
  retryCount: 2,
  maxTextChars: 600,
};

describe("embedded Pi tool-intent guardrail", () => {
  it("matches configured model patterns", () => {
    expect(
      matchesModelPattern(
        "llamacpp/*qwen*",
        "llamacpp",
        "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      ),
    ).toBe(true);
    expect(matchesModelPattern("llamacpp/*qwen*", "openai-codex", "gpt-5.5")).toBe(false);
  });

  it("detects leading tool-intent declarations", () => {
    expect(looksLikeDeferredToolIntent("我现在直接读取 MEMORY.md。", 600)).toBe(true);
    expect(looksLikeDeferredToolIntent("Let me read MEMORY.md first.", 600)).toBe(true);
    expect(looksLikeDeferredToolIntent("- I will run pwd now.", 600)).toBe(true);
  });

  it("does not flag quoted or explanatory text as tool intent", () => {
    expect(looksLikeDeferredToolIntent('The phrase "I will read MEMORY.md" is an example.', 600))
      .toBe(false);
    expect(looksLikeDeferredToolIntent("这里的“我现在读取 MEMORY.md”只是一句示例文本。", 600)).toBe(
      false,
    );
    expect(looksLikeDeferredToolIntent("> I will read MEMORY.md.", 600)).toBe(false);
  });

  it("does not trigger when a tool call already happened", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "I will read MEMORY.md.",
        toolMetas: [{ name: "read" }],
      }),
    ).toBe(false);
  });

  it("is model scoped", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "I will read MEMORY.md.",
      }),
    ).toBe(true);
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "openai-codex",
        modelId: "gpt-5.5",
        text: "I will read MEMORY.md.",
      }),
    ).toBe(false);
  });
});
