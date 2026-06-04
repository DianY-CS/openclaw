import { describe, expect, it } from "vitest";

import { __testing } from "./run.js";

const {
  evaluateToolIntentGuardrail,
  buildToolIntentFinalizationFallbackText,
  looksLikeBareToolCallText,
  looksLikeDeferredToolIntent,
  looksLikeFinalizationRequest,
  looksLikeNonAnswerPlaceholder,
  looksLikeUnsupportedToolCompletionClaim,
  parseExecutionPhaseLabel,
  parseResponseMode,
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
    expect(
      looksLikeDeferredToolIntent(
        "Now I have the full picture. Let me examine the screenshot and video probe.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Let me find the request validation code.", 600)).toBe(
      true,
    );
    expect(looksLikeDeferredToolIntent("Now let me wait for the runner to pick it up.", 600))
      .toBe(true);
    expect(looksLikeDeferredToolIntent("I wrote the request JSON. Let me do that now.", 600))
      .toBe(true);
  });

  it("detects user requests that should force finalization recovery", () => {
    expect(
      looksLikeFinalizationRequest(
        "Please continue until you have a concrete debugging conclusion and a suggested fix.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeFinalizationRequest("Can you summarize the root cause?", 600)).toBe(true);
    expect(looksLikeFinalizationRequest("那么对于这些问题的修改建议是什么呢？", 600)).toBe(true);

    expect(looksLikeFinalizationRequest("Please execute it.", 600)).toBe(false);
    expect(looksLikeFinalizationRequest("What will you do? Just tell me your plan.", 600)).toBe(
      false,
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

  it("parses execution phase labels as recovery anchors", async () => {
    expect(parseExecutionPhaseLabel("EXEC_PHASE: SEND_RECORDING", 600)).toBe("SEND_RECORDING");
    expect(parseExecutionPhaseLabel("EXECUTION_PHASE: poll-status", 600)).toBe("POLL_STATUS");
    expect(parseExecutionPhaseLabel("Phase CREATE_REQUEST:", 600)).toBe("CREATE_REQUEST");
    expect(parseExecutionPhaseLabel("Phase 2 - VALIDATE_REQUEST:", 600)).toBe(
      "VALIDATE_REQUEST",
    );
    expect(parseExecutionPhaseLabel("Phase UNKNOWN:", 600)).toBeNull();

    const verdict = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "EXEC_PHASE: SEND_RECORDING",
    });

    expect(verdict).toMatchObject({
      trigger: true,
      detector: "phaseLabel",
      reason: "execution phase declared without tool call: SEND_RECORDING",
      phase: "SEND_RECORDING",
    });
  });

  it("detects response-mode protocol violations", async () => {
    expect(parseResponseMode("RESPONSE_MODE: final\nKnown: enough evidence", 600)).toBe("final");
    expect(parseResponseMode("RESPONSE_MODE: tool_required\nACTION_INTENT", 600)).toBe(
      "tool_required",
    );

    const toolRequired = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "RESPONSE_MODE: tool_required\nACTION_INTENT\ntype: tool_required\naction: inspect results\nreason: missing evidence",
    });
    expect(toolRequired).toMatchObject({
      trigger: true,
      detector: "responseMode",
    });

    const missingMode = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "Let me actually check the results before concluding.",
      requireResponseMode: true,
    });
    expect(missingMode).toMatchObject({
      trigger: true,
      detector: "responseMode",
      reason: "missing response mode for finalization request",
    });

    const finalButStillInvestigating = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "RESPONSE_MODE: final\nThe result directory exists. Let me actually inspect the files.",
      requireResponseMode: true,
    });
    expect(finalButStillInvestigating).toMatchObject({
      trigger: true,
      detector: "responseMode",
      reason: "final response mode still promised more tool work",
    });
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

  it("detects placeholder-only non-answers narrowly", () => {
    expect(looksLikeNonAnswerPlaceholder("...", 600)).toBe(true);
    expect(looksLikeNonAnswerPlaceholder("…", 600)).toBe(true);
    expect(looksLikeNonAnswerPlaceholder("。。。", 600)).toBe(true);
    expect(looksLikeNonAnswerPlaceholder(" . . . ", 600)).toBe(true);

    expect(looksLikeNonAnswerPlaceholder("OK", 600)).toBe(false);
    expect(looksLikeNonAnswerPlaceholder("Yes, it is there.", 600)).toBe(false);
    expect(looksLikeNonAnswerPlaceholder("... checking", 600)).toBe(false);
    expect(looksLikeNonAnswerPlaceholder("The log says ...", 600)).toBe(false);
  });

  it("detects completion claims that need same-turn tool evidence", async () => {
    expect(
      looksLikeUnsupportedToolCompletionClaim(
        "The recording request has been dispatched to the Windows host runner.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeUnsupportedToolCompletionClaim("Request created: auto_chess.json", 600)).toBe(
      true,
    );
    expect(
      looksLikeUnsupportedToolCompletionClaim(
        "The request will be created under jobs/game/requests.",
        600,
      ),
    ).toBe(false);

    const noEvidence = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "The recording request has been dispatched to the Windows host runner.",
      toolMetas: [],
    });
    expect(noEvidence).toMatchObject({
      trigger: true,
      detector: "regex",
      reason: "completion claim without tool evidence",
    });

    const withEvidence = await evaluateToolIntentGuardrail({
      config: enabledConfig,
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      text: "The recording request has been dispatched to the Windows host runner.",
      toolMetas: [{ toolName: "exec" }],
    });
    expect(withEvidence.trigger).toBe(false);
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
    expect(looksLikeDeferredToolIntent("Here's what I need to do now:\n\nLet me execute that now:", 600))
      .toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Let me dig deeper into what's happening — check the screenshot and inspect the scripts.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        `${"Known evidence. ".repeat(80)}Now I have a clear picture. Let me check the screenshot from the most recent run to see what the game looks like.`,
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Now I have the full picture. Let me trace the `_ready()` flow:",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "The result directory exists with files, but let me check what's actually in them - especially the video probe and run log.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Request file created. Validating its contents now.", 600))
      .toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Project exists, request dir confirmed, request file written. Now reading it back to validate.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Request validated — `record_seconds=15`, `record_fps=60`, `capture.fps=60`. Now polling status.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "A previous job already completed successfully with a valid 15-second 60fps recording. Let me read the existing request, then proceed to send the recording.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Recording validated. Sending it to you via Telegram now.", 600))
      .toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Project exists. Now creating the request directory and writing the request JSON.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Project exists. Now Phase 2 - ensure request directory exists, and Phase 3 - create the request JSON.",
        600,
      ),
    ).toBe(true);
    expect(
      looksLikeDeferredToolIntent(
        "Request validated. Phase 5 - poll status_path until the host runner is done.",
        600,
      ),
    ).toBe(true);
    expect(looksLikeDeferredToolIntent("Now let me validate the request was written correctly.", 600))
      .toBe(true);
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

  it("can still trigger during explicit finalization even when the same turn has tool calls", () => {
    expect(
      shouldTriggerToolIntentGuardrail({
        config: enabledConfig,
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        text: "Now I have the full picture. Let me trace the `_ready()` flow:",
        finalAssistantHasToolCall: true,
        allowFinalizationTextAfterToolCall: true,
      }),
    ).toBe(true);
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
    expect(
      shouldUseToolIntentGuardrailFinalizationAfterToolProgress({
        retryAttempts: 2,
        toolMetas: [],
        sawToolProgressAfterRetry: true,
      }),
    ).toBe(true);
  });

  it("preserves a useful finalization candidate instead of replacing it with the conservative fallback", () => {
    const text = buildToolIntentFinalizationFallbackText({
      lastAssistantText: [
        "RESPONSE_MODE: final",
        "",
        "Root cause 1: the request used capture.record_seconds=15, but the runner only read the top-level record_seconds field, so the requested duration was ignored.",
        "Root cause 2: capture_region was always computed from the Godot window, which bypassed the FFmpeg full-screen path and used the Python/mss frame capture path instead.",
        "Fix: read the nested capture fields, only request a window region when explicitly configured, and add an ffmpeg fps=60 filter so frame_count / fps matches the requested recording duration.",
      ].join("\n"),
      toolMetas: [{ toolName: "exec" }, { toolName: "read" }],
    });

    expect(text).toContain("Root cause 1");
    expect(text).toContain("capture.record_seconds=15");
    expect(text).toContain("capture_region");
    expect(text).toContain("fps=60");
    expect(text).not.toContain("RESPONSE_MODE");
    expect(text).not.toContain("Debugging conclusion");
  });

  it("builds a conservative finalization fallback instead of exposing guardrail internals", () => {
    const text = buildToolIntentFinalizationFallbackText({
      lastAssistantText: "Let me inspect the run log and scene to debug the recording issue.",
      toolMetas: [{ toolName: "exec" }, { toolName: "read" }],
    });

    expect(text).toContain("Debugging conclusion");
    expect(text).toContain("Recommended next change");
    expect(text).toContain("exec, read");
    expect(text).toContain("recording issue");
    expect(text.toLowerCase()).not.toContain("tool-intent guardrail");
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
