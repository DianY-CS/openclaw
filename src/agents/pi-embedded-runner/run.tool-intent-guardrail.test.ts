import { describe, expect, it } from "vitest";

import { __testing } from "./run.js";

const {
  evaluateToolIntentGuardrail,
  looksLikeBareToolCallText,
  looksLikeDeferredToolIntent,
  looksLikeStructuredToolIntent,
  matchesModelPattern,
  resolveToolIntentGuardrailConfig,
  shouldUseToolIntentGuardrailFinalizationAfterToolProgress,
  shouldTriggerToolIntentGuardrail,
} = __testing;

const enabledConfig = {
  enabled: true,
  models: ["llamacpp/*qwen*"],
  detectors: ["toolCallText" as const, "structuredIntent" as const, "regex" as const],
  retryCount: 2,
  maxTextChars: 600,
  judge: {
    enabled: false,
    minConfidence: 0.7,
    timeoutMs: 12_000,
    maxTokens: 180,
    temperature: 0,
  },
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
    expect(
      looksLikeDeferredToolIntent(
        "Now I'll create the recording request and dispatch it through the Godot runner.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Let me first check the project structure.", 600)).toBe(
      true,
    );
  });

  it("detects structured tool-intent template declarations", () => {
    const text = [
      "ACTION_INTENT",
      "type: tool_required",
      "action: read project files",
      "reason: I need workspace state before answering",
    ].join("\n");

    expect(looksLikeStructuredToolIntent(text, 600)).toBe(true);
    expect(shouldTriggerToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text,
    })).toBe(true);
    expect(looksLikeStructuredToolIntent("ACTION_INTENT\naction: read\nreason: missing type", 600))
      .toBe(false);
  });

  it("detects bare tool-call-shaped assistant text", async () => {
    const text =
      "<tool_call><function=read><parameter=path>MEMORY.md</parameter></function></tool_call>";

    expect(looksLikeBareToolCallText(text, 600)).toBe(true);

    const verdict = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text,
    });

    expect(verdict).toMatchObject({
      trigger: true,
      detector: "toolCallText",
    });
  });

  it("detects tool-call-shaped text that only appears in thinking", async () => {
    const thinkingText =
      "<tool_call><function=read><parameter=path>MEMORY.md</parameter></function></tool_call>";

    const verdict = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "",
      thinkingText,
    });

    expect(verdict).toMatchObject({
      trigger: true,
      detector: "toolCallText",
    });
  });

  it("does not flag explanatory prose that mentions a tool-call-shaped example", () => {
    const text =
      "Here is an example: <tool_call><function=read><parameter=path>MEMORY.md</parameter></function></tool_call>";

    expect(looksLikeBareToolCallText(text, 600)).toBe(false);
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text,
      }),
    ).toBe(false);
  });

  it("detects unfinished trailing tool-intent declarations", () => {
    expect(
      looksLikeDeferredToolIntent(
        "No `misc/art` directory exists. Let me verify the full project tree for completeness.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "I found the main project files. I will continue to check the scripts directory.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The `jobs` directory exists but the `requests` subdirectory isn't writable from Node. Let me use `mkdir` directly and then write the JSON with a different approach.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Request created. Now let me check for results.", 600))
      .toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The recording completed, but it's only 0.8 seconds long. Let me re-check the recording request to see what happened and try again with proper timing.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The helper script doesn't exist. Let me use the message tool to send the recording directly.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Recording complete. Now sending the recording to you via Telegram.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The run log shows Godot launched and recorded, but the video is only 0.43 seconds. I need to enable a demo flag so combat starts automatically. Let me check the script for the recording demo toggle.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The runner needs python3 instead of python. Let me restart with the correct command:",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "I need to check how the runner is normally invoked on the host. Let me look at how it's typically triggered:",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Now let me start the runner in the background:", 600)).toBe(
      true,
    );
  });

  it("does not flag quoted or explanatory text as tool intent", () => {
    expect(looksLikeDeferredToolIntent('The phrase "I will read MEMORY.md" is an example.', 600))
      .toBe(false);
    expect(looksLikeDeferredToolIntent("这里的“我现在读取 MEMORY.md”只是一句示例文本。", 600)).toBe(
      false,
    );
    expect(looksLikeDeferredToolIntent("> I will read MEMORY.md.", 600)).toBe(false);
    expect(
      looksLikeDeferredToolIntent(
        "The earlier answer ended with: Let me verify the full project tree for completeness.",
        600,
      ),
    ).toBe(false);
    expect(looksLikeDeferredToolIntent("Let me use a smaller example to explain it.", 600)).toBe(
      false,
    );
  });

  it("does not trigger when a tool call already happened", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "I will read MEMORY.md.",
        finalAssistantHasToolCall: true,
      }),
    ).toBe(false);
  });

  it("still triggers when only an earlier assistant step used tools", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "Request created. Now let me check for results.",
        toolMetas: [{ name: "exec" }],
        finalAssistantHasToolCall: false,
      }),
    ).toBe(true);
  });

  it("still triggers after a tool error when the assistant promises another tool action", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "The helper script doesn't exist. Let me use the message tool to send the recording directly.",
        lastToolError: new Error("MODULE_NOT_FOUND"),
      }),
    ).toBe(true);
  });

  it("switches to finalization mode after a guardrail retry makes tool progress", () => {
    expect(
      shouldUseToolIntentGuardrailFinalizationAfterToolProgress({
        retryAttempts: 2,
        toolMetas: [{ toolName: "read" }],
      }),
    ).toBe(true);
    expect(
      shouldUseToolIntentGuardrailFinalizationAfterToolProgress({
        retryAttempts: 0,
        toolMetas: [{ toolName: "read" }],
      }),
    ).toBe(false);
    expect(
      shouldUseToolIntentGuardrailFinalizationAfterToolProgress({
        retryAttempts: 2,
        toolMetas: [],
      }),
    ).toBe(false);
  });

  it("enables hybrid detector order when the LLM judge is configured", () => {
    const resolved = resolveToolIntentGuardrailConfig(
      {
        agents: {
          defaults: {
            embeddedPi: {
              toolIntentGuardrail: {
                enabled: true,
                judge: {
                  enabled: true,
                  model: "openai/gpt-4.1-mini",
                  minConfidence: 0.8,
                },
              },
            },
          },
        },
      } as never,
      "main",
    );

    expect(resolved.detectors).toEqual(["toolCallText", "structuredIntent", "regex", "llmJudge"]);
    expect(resolved.judge.enabled).toBe(true);
    expect(resolved.judge.model).toBe("openai/gpt-4.1-mini");
    expect(resolved.judge.minConfidence).toBe(0.8);
  });

  it("falls through to LLM judge when regex misses", async () => {
    const verdict = await evaluateToolIntentGuardrail({
      config: {
        ...enabledConfig,
        detectors: ["structuredIntent", "regex", "llmJudge"],
        judge: {
          ...enabledConfig.judge,
          enabled: true,
        },
      },
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "The request is prepared; next I need to inspect the generated files.",
      judge: async () => ({ trigger: true, detector: "llmJudge", reason: "promised inspect" }),
    });

    expect(verdict).toEqual({
      trigger: true,
      detector: "llmJudge",
      reason: "promised inspect",
    });
  });

  it("does not call LLM judge when regex already catches the text", async () => {
    let judgeCalled = false;
    const verdict = await evaluateToolIntentGuardrail({
      config: {
        ...enabledConfig,
        detectors: ["structuredIntent", "regex", "llmJudge"],
        judge: {
          ...enabledConfig.judge,
          enabled: true,
        },
      },
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "Let me check the project structure.",
      judge: async () => {
        judgeCalled = true;
        return { trigger: false, detector: "llmJudge" };
      },
    });

    expect(verdict.detector).toBe("regex");
    expect(verdict.trigger).toBe(true);
    expect(judgeCalled).toBe(false);
  });

  it("does not call LLM judge when structured intent already catches the text", async () => {
    let judgeCalled = false;
    const verdict = await evaluateToolIntentGuardrail({
      config: {
        ...enabledConfig,
        detectors: ["structuredIntent", "regex", "llmJudge"],
        judge: {
          ...enabledConfig.judge,
          enabled: true,
        },
      },
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: [
        "ACTION_INTENT",
        "type: tool_required",
        "action: check results folder",
        "reason: the user asked whether the recording completed",
      ].join("\n"),
      judge: async () => {
        judgeCalled = true;
        return { trigger: false, detector: "llmJudge" };
      },
    });

    expect(verdict.detector).toBe("structuredIntent");
    expect(verdict.trigger).toBe(true);
    expect(judgeCalled).toBe(false);
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
