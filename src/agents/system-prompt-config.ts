import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTtsSystemPromptHint } from "../tts/tts.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { buildModelAliasLines } from "./model-alias-lines.js";
import { resolveOwnerDisplaySetting } from "./owner-display.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

type AgentSystemPromptRenderParams = Parameters<typeof buildAgentSystemPrompt>[0];

export type ResolvedAgentSystemPromptConfig = Pick<
  AgentSystemPromptRenderParams,
  | "ownerDisplay"
  | "ownerDisplaySecret"
  | "subagentDelegationMode"
  | "ttsHint"
  | "modelAliasLines"
  | "memoryCitationsMode"
  | "toolIntentTemplateGuidance"
  | "plannedExecutionGuidance"
>;

export type ConfiguredAgentSystemPromptParams = AgentSystemPromptRenderParams & {
  config?: OpenClawConfig;
  agentId?: string;
};

export function resolveAgentSystemPromptConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  modelRef?: string;
}): ResolvedAgentSystemPromptConfig {
  const { config, agentId, modelRef } = params;
  const ownerDisplay = resolveOwnerDisplaySetting(config);
  const agentSubagents =
    config && agentId ? resolveAgentConfig(config, agentId)?.subagents : undefined;
  return {
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
    subagentDelegationMode:
      agentSubagents?.delegationMode ??
      config?.agents?.defaults?.subagents?.delegationMode ??
      "suggest",
    ttsHint: config ? buildTtsSystemPromptHint(config, agentId) : undefined,
    modelAliasLines: buildModelAliasLines(config),
    memoryCitationsMode: config?.memory?.citations,
    toolIntentTemplateGuidance: resolveToolIntentTemplateGuidance(config, agentId),
    plannedExecutionGuidance: resolvePlannedExecutionGuidance(config, agentId, modelRef),
  };
}

function wildcardPatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "iu").test(value.trim());
}

function modelMatchesPatterns(modelRef: string | undefined, patterns: string[] | undefined) {
  if (!patterns || patterns.length === 0) {
    return true;
  }
  const normalizedModelRef = modelRef?.trim();
  if (!normalizedModelRef) {
    return false;
  }
  return patterns.some((pattern) => wildcardPatternMatches(pattern, normalizedModelRef));
}

function resolveToolIntentTemplateGuidance(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
): boolean {
  if (!config) {
    return false;
  }
  const defaults = config.agents?.defaults?.embeddedPi?.toolIntentGuardrail;
  const agentConfig = agentId ? resolveAgentConfig(config, agentId)?.embeddedPi : undefined;
  const override = agentConfig?.toolIntentGuardrail;
  const enabled = override?.enabled ?? defaults?.enabled;
  if (enabled !== true) {
    return false;
  }
  const detectors = override?.detectors ?? defaults?.detectors;
  return !detectors || detectors.length === 0 || detectors.includes("structuredIntent");
}

function resolvePlannedExecutionGuidance(
  config: OpenClawConfig | undefined,
  agentId: string | undefined,
  modelRef: string | undefined,
): boolean {
  if (!config) {
    return false;
  }
  const defaults = config.agents?.defaults?.embeddedPi?.plannedExecution;
  const agentConfig = agentId ? resolveAgentConfig(config, agentId)?.embeddedPi : undefined;
  const override = agentConfig?.plannedExecution;
  const enabled = override?.enabled ?? defaults?.enabled;
  if (enabled !== true) {
    return false;
  }
  const models = override?.models ?? defaults?.models;
  return modelMatchesPatterns(modelRef, models);
}

export function buildConfiguredAgentSystemPrompt(params: ConfiguredAgentSystemPromptParams) {
  const { config, agentId, ...renderParams } = params;
  const configParams = config
    ? resolveAgentSystemPromptConfig({
        config,
        agentId,
        modelRef: renderParams.runtimeInfo?.model,
      })
    : {};
  return buildAgentSystemPrompt({
    ...renderParams,
    ...configParams,
  });
}
