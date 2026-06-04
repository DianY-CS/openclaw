import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildConfiguredAgentSystemPrompt,
  resolveAgentSystemPromptConfig,
} from "./system-prompt-config.js";

vi.mock("../tts/tts.js", () => ({
  buildTtsSystemPromptHint: vi.fn(() => undefined),
}));

describe("resolveAgentSystemPromptConfig", () => {
  it("defaults sub-agent delegation mode to suggest", () => {
    expect(resolveAgentSystemPromptConfig({ config: {} }).subagentDelegationMode).toBe("suggest");
  });

  it("inherits default sub-agent delegation mode", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "prefer",
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveAgentSystemPromptConfig({ config, agentId: "main" }).subagentDelegationMode).toBe(
      "prefer",
    );
  });

  it("lets per-agent sub-agent delegation mode override defaults", () => {
    const config = {
      agents: {
        defaults: {
          subagents: {
            delegationMode: "suggest",
          },
        },
        list: [
          {
            id: "coordinator",
            subagents: {
              delegationMode: "prefer",
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentSystemPromptConfig({ config, agentId: "coordinator" }).subagentDelegationMode,
    ).toBe("prefer");
  });

  it("enables tool-intent template guidance when structured guardrail is active", () => {
    const config = {
      agents: {
        defaults: {
          embeddedPi: {
            toolIntentGuardrail: {
              enabled: true,
              models: ["llamacpp/*qwen*"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveAgentSystemPromptConfig({ config, agentId: "main" }).toolIntentTemplateGuidance)
      .toBe(true);
  });

  it("lets per-agent detector overrides disable tool-intent template guidance", () => {
    const config = {
      agents: {
        defaults: {
          embeddedPi: {
            toolIntentGuardrail: {
              enabled: true,
              detectors: ["structuredIntent"],
            },
          },
        },
        list: [
          {
            id: "regex-only",
            embeddedPi: {
              toolIntentGuardrail: {
                detectors: ["regex"],
              },
            },
          },
        ],
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentSystemPromptConfig({ config, agentId: "regex-only" })
        .toolIntentTemplateGuidance,
    ).toBe(false);
  });

  it("enables planned execution guidance for matching local executor models", () => {
    const config = {
      agents: {
        defaults: {
          embeddedPi: {
            plannedExecution: {
              enabled: true,
              models: ["llamacpp/*qwen*"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveAgentSystemPromptConfig({
        config,
        agentId: "main",
        modelRef: "llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      }).plannedExecutionGuidance,
    ).toBe(true);
    expect(
      resolveAgentSystemPromptConfig({
        config,
        agentId: "main",
        modelRef: "openai-codex/gpt-5.5",
      }).plannedExecutionGuidance,
    ).toBe(false);
  });
});

describe("buildConfiguredAgentSystemPrompt", () => {
  it("applies config-backed prompt parameters through the canonical facade", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            subagents: {
              delegationMode: "prefer",
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["sessions_spawn", "subagents"],
    });

    expect(prompt).toContain("## Sub-Agent Delegation");
    expect(prompt).toContain("Mode: prefer");
  });

  it("renders the structured tool-intent contract from config", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              toolIntentGuardrail: {
                enabled: true,
                detectors: ["structuredIntent", "regex"],
              },
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read"],
    });

    expect(prompt).toContain("## Tool Intent Contract");
    expect(prompt).toContain("RESPONSE_MODE: final");
    expect(prompt).toContain("RESPONSE_MODE: tool_required");
    expect(prompt).toContain("ACTION_INTENT");
    expect(prompt).toContain("type: tool_required");
  });

  it("renders planned execution guidance for matching configured models", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              plannedExecution: {
                enabled: true,
                models: ["llamacpp/*qwen*"],
              },
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read", "exec", "message"],
      runtimeInfo: {
        model: "llamacpp/Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      },
    });

    expect(prompt).toContain("## Planned Execution Mode");
    expect(prompt).toContain("act as an executor");
    expect(prompt).toContain("do not claim delivery without send evidence");
  });

  it("does not render planned execution guidance for non-matching models", () => {
    const prompt = buildConfiguredAgentSystemPrompt({
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              plannedExecution: {
                enabled: true,
                models: ["llamacpp/*qwen*"],
              },
            },
          },
        },
      },
      agentId: "main",
      workspaceDir: "/tmp/openclaw",
      toolNames: ["read", "exec", "message"],
      runtimeInfo: {
        model: "openai-codex/gpt-5.5",
      },
    });

    expect(prompt).not.toContain("## Planned Execution Mode");
  });
});
