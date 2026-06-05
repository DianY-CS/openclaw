import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  resolveContextEngine,
  resolveContextEngineOwnerPluginId,
} from "../../context-engine/registry.js";
import { emitAgentPlanEvent } from "../../infra/agent-events.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { freezeDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveProviderAuthProfileId } from "../../plugins/provider-runtime.js";
import { enqueueCommandInLane } from "../../process/command-queue.js";
import type { CommandQueueEnqueueOptions } from "../../process/command-queue.types.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { detectToolCallShapedText } from "../../shared/text/tool-call-shaped-text.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { sanitizeForLog } from "../../terminal/ansi.js";
import { resolveUserPath } from "../../utils.js";
import { isMarkdownCapableMessageChannel } from "../../utils/message-channel.js";
import {
  resolveAgentConfig,
  resolveAgentExecutionContract,
  resolveAgentDir,
  resolveSessionAgentIds,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import {
  type AuthProfileFailureReason,
  type AuthProfileStore,
  isProfileInCooldown,
  markAuthProfileFailure,
  markAuthProfileSuccess,
  resolveAuthProfileEligibility,
} from "../auth-profiles.js";
import { listActiveProcessSessionReferences } from "../bash-process-references.js";
import {
  resolveSessionKeyForRequest,
  resolveStoredSessionKeyForSessionId,
} from "../command/session.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { isStrictAgenticExecutionContractActive } from "../execution-contract.js";
import {
  canonicalizeExistingGodotRecordingRequestArtifacts,
  ensureGodotRecordingRequest,
  resolvePlannedExecutionFinalizer,
} from "../planned-execution.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  FailoverError,
  resolveFailoverStatus,
} from "../failover-error.js";
import { ensureSelectedAgentHarnessPlugin } from "../harness/runtime-plugin.js";
import { selectAgentHarness } from "../harness/selection.js";
import { LiveSessionModelSwitchError } from "../live-model-switch-error.js";
import { shouldSwitchToLiveModel, clearLiveModelSwitchPending } from "../live-model-switch.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  type ResolvedProviderAuth,
  resolveAuthProfileOrder,
  shouldPreferExplicitConfigApiKeyAuth,
} from "../model-auth.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  listOpenAIAuthProfileProvidersForAgentRuntime,
  resolveContextConfigProviderForRuntime,
  resolveSelectedOpenAIPiRuntimeProvider,
} from "../openai-codex-routing.js";
import {
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "../pi-bundle-mcp-tools.js";
import {
  classifyFailoverReason,
  extractObservedOverflowTokenCount,
  type FailoverReason,
  formatAssistantErrorText,
  isAuthAssistantError,
  isBillingAssistantError,
  isCompactionFailureError,
  isFailoverAssistantError,
  isFailoverErrorMessage,
  isLikelyContextOverflowError,
  isRateLimitAssistantError,
  parseImageDimensionError,
  parseImageSizeError,
  pickFallbackThinkingLevel,
} from "../pi-embedded-helpers.js";
import { extractAssistantThinking } from "../pi-embedded-utils.js";
import { resolveProcessToolScopeKey } from "../pi-tools.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import { buildAgentRuntimeAuthPlan } from "../runtime-plan/auth.js";
import { buildAgentRuntimePlan } from "../runtime-plan/build.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { resolveSessionSuspensionReason, suspendSession } from "../session-suspension.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { derivePromptTokens, normalizeUsage, type UsageLike } from "../usage.js";
import { redactRunIdentifier, resolveRunWorkspaceDir } from "../workspace-run.js";
import { runPostCompactionSideEffects } from "./compaction-hooks.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { resolveContextEngineCapabilities } from "./context-engine-capabilities.js";
import { runContextEngineMaintenance } from "./context-engine-maintenance.js";
import {
  hasMessagingToolDeliveryEvidence,
  hasOutboundDeliveryEvidence,
} from "./delivery-evidence.js";
import { resolveEmbeddedRunFailureSignal } from "./failure-signal.js";
import { resolveGlobalLane, resolveSessionLane } from "./lanes.js";
import { log } from "./logger.js";
import { resolveModelAsync } from "./model.js";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
  type PostCompactionGuardObservation,
} from "./post-compaction-loop-guard.js";
import { createEmbeddedRunReplayState, observeReplayMetadata } from "./replay-state.js";
import { handleAssistantFailover } from "./run/assistant-failover.js";
import {
  createEmbeddedRunStageTracker,
  EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE,
  formatEmbeddedRunStageSummary,
  shouldWarnEmbeddedRunStageSummary,
} from "./run/attempt-stage-timing.js";
import { forgetPromptBuildDrainCacheForRun } from "./run/attempt.prompt-helpers.js";
import { createEmbeddedRunAuthController } from "./run/auth-controller.js";
import { resolveAuthProfileFailureReason } from "./run/auth-profile-failure-policy.js";
import { runEmbeddedAttemptWithBackend } from "./run/backend.js";
import { resolveCodexAppServerClientCloseRetry } from "./run/codex-app-server-recovery.js";
import { createFailoverDecisionLogger } from "./run/failover-observation.js";
import { mergeRetryFailoverReason, resolveRunFailoverDecision } from "./run/failover-policy.js";
import { hasEmbeddedRunConfiguredModelFallbacks } from "./run/fallbacks.js";
import {
  buildErrorAgentMeta,
  buildUsageAgentMetaFields,
  createCompactionDiagId,
  resolveActiveErrorContext,
  resolveFinalAssistantRawText,
  resolveFinalAssistantVisibleText,
  resolveMaxRunRetryIterations,
  resolveReportedModelRef,
  resolveOverloadFailoverBackoffMs,
  resolveOverloadProfileRotationLimit,
  resolveRateLimitProfileRotationLimit,
  type RuntimeAuthState,
  scrubAnthropicRefusalMagic,
} from "./run/helpers.js";
import {
  MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT,
  createIdleTimeoutBreakerState,
  stepIdleTimeoutBreaker,
} from "./run/idle-timeout-breaker.js";
import {
  DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT,
  DEFAULT_REASONING_ONLY_RETRY_LIMIT,
  resolveAckExecutionFastPathInstruction,
  resolveAttemptReplayMetadata,
  extractPlanningOnlyPlanDetails,
  resolveEmptyResponseRetryInstruction,
  resolveIncompleteTurnPayloadText,
  resolvePlanningOnlyRetryLimit,
  resolvePlanningOnlyRetryInstruction,
  resolveReasoningOnlyRetryInstruction,
  resolveSilentToolResultReplyPayload,
  STRICT_AGENTIC_BLOCKED_TEXT,
  resolveReplayInvalidFlag,
  resolveRunLivenessState,
  shouldTreatEmptyAssistantReplyAsSilent,
} from "./run/incomplete-turn.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import { buildEmbeddedRunPayloads } from "./run/payloads.js";
import { handleRetryLimitExhaustion } from "./run/retry-limit.js";
import {
  buildBeforeModelResolveAttachments,
  resolveEffectiveRuntimeModel,
  resolveHookModelSelection,
} from "./run/setup.js";
import { mergeAttemptToolMediaPayloads } from "./run/tool-media-payloads.js";
import {
  resolveLiveToolResultMaxChars,
  sessionLikelyHasOversizedToolResults,
  truncateOversizedToolResultsInSession,
} from "./tool-result-truncation.js";
import type {
  EmbeddedPiAgentMeta,
  EmbeddedPiRunResult,
  TraceAttempt,
  ToolSummaryTrace,
  EmbeddedRunLivenessState,
} from "./types.js";
import { createUsageAccumulator, mergeUsageIntoAccumulator } from "./usage-accumulator.js";

type ApiKeyInfo = ResolvedProviderAuth;

const MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES = 1;
const EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS = 30_000;
const MID_TURN_PRECHECK_CONTINUATION_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";
const COMPACTION_CONTINUATION_RETRY_INSTRUCTION =
  "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript and produce the final answer now. Do not restart from scratch, do not repeat completed work, and do not rerun tools unless the transcript clearly lacks required evidence.";
type EmbeddedRunAttemptForRunner = Awaited<ReturnType<typeof runEmbeddedAttemptWithBackend>>;

function resolveAttemptDispatchApiKey(params: {
  apiKeyInfo: ApiKeyInfo | null;
  runtimeAuthState: RuntimeAuthState | null;
}): string | undefined {
  if (params.runtimeAuthState) {
    return undefined;
  }
  return params.apiKeyInfo?.apiKey;
}

function resolveEmbeddedRunLaneTimeoutMs(timeoutMs: number): number | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return undefined;
  }
  return Math.floor(timeoutMs) + EMBEDDED_RUN_LANE_TIMEOUT_GRACE_MS;
}

function withEmbeddedRunLaneTimeout(
  opts: CommandQueueEnqueueOptions | undefined,
  laneTaskTimeoutMs: number | undefined,
): CommandQueueEnqueueOptions | undefined {
  if (laneTaskTimeoutMs === undefined || opts?.taskTimeoutMs !== undefined) {
    return opts;
  }
  return { ...opts, taskTimeoutMs: laneTaskTimeoutMs };
}

function resolveEmbeddedRunSessionQueuePriority(
  trigger: RunEmbeddedPiAgentParams["trigger"],
): CommandQueueEnqueueOptions["priority"] {
  switch (trigger) {
    case "user":
    case "manual":
      return "foreground";
    case "cron":
    case "heartbeat":
    case "memory":
    case "overflow":
      return "background";
    default:
      return "normal";
  }
}

function normalizeEmbeddedRunAttemptResult(
  attempt: EmbeddedRunAttemptForRunner,
): EmbeddedRunAttemptForRunner {
  const raw = attempt as EmbeddedRunAttemptForRunner & {
    assistantTexts?: EmbeddedRunAttemptForRunner["assistantTexts"] | null;
    toolMetas?: EmbeddedRunAttemptForRunner["toolMetas"] | null;
    acceptedSessionSpawns?: EmbeddedRunAttemptForRunner["acceptedSessionSpawns"] | null;
    messagesSnapshot?: EmbeddedRunAttemptForRunner["messagesSnapshot"] | null;
    messagingToolSentTexts?: EmbeddedRunAttemptForRunner["messagingToolSentTexts"] | null;
    messagingToolSentMediaUrls?: EmbeddedRunAttemptForRunner["messagingToolSentMediaUrls"] | null;
    messagingToolSentTargets?: EmbeddedRunAttemptForRunner["messagingToolSentTargets"] | null;
    messagingToolSourceReplyPayloads?:
      | EmbeddedRunAttemptForRunner["messagingToolSourceReplyPayloads"]
      | null;
    itemLifecycle?: EmbeddedRunAttemptForRunner["itemLifecycle"] | null;
  };
  return {
    ...attempt,
    assistantTexts: raw.assistantTexts ?? [],
    toolMetas: raw.toolMetas ?? [],
    acceptedSessionSpawns: raw.acceptedSessionSpawns ?? [],
    messagesSnapshot: raw.messagesSnapshot ?? [],
    messagingToolSentTexts: raw.messagingToolSentTexts ?? [],
    messagingToolSentMediaUrls: raw.messagingToolSentMediaUrls ?? [],
    messagingToolSentTargets: raw.messagingToolSentTargets ?? [],
    messagingToolSourceReplyPayloads: raw.messagingToolSourceReplyPayloads ?? [],
    itemLifecycle: raw.itemLifecycle ?? {
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    },
    replayMetadata: resolveAttemptReplayMetadata(raw),
  };
}

function hasCompletedModelProgressForIdleBreaker(attempt: EmbeddedRunAttemptForRunner): boolean {
  return (
    attempt.assistantTexts.some((text) => text.trim().length > 0) ||
    attempt.toolMetas.length > 0 ||
    (attempt.clientToolCalls?.length ?? 0) > 0 ||
    hasOutboundDeliveryEvidence(attempt) ||
    attempt.itemLifecycle.completedCount > 0
  );
}

function createEmptyAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {},
  };
}

function createScopedAuthProfileStore(
  store: AuthProfileStore,
  profileIds: string | undefined | string[],
): AuthProfileStore {
  const profiles = store.profiles ?? {};
  const normalizedProfileIds = (Array.isArray(profileIds) ? profileIds : [profileIds])
    .map((profileId) => profileId?.trim())
    .filter((profileId): profileId is string => !!profileId);
  const scopedProfiles = Object.fromEntries(
    normalizedProfileIds.flatMap((profileId) => {
      const credential = profiles[profileId];
      return credential ? [[profileId, credential] as const] : [];
    }),
  );
  return Object.keys(scopedProfiles).length > 0
    ? {
        version: store.version,
        profiles: scopedProfiles,
      }
    : createEmptyAuthProfileStore();
}

function buildTraceToolSummary(params: {
  toolMetas?: Array<{ toolName: string; meta?: string }>;
  hadFailure: boolean;
}): ToolSummaryTrace | undefined {
  if (!params.toolMetas?.length) {
    return undefined;
  }
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of params.toolMetas) {
    const toolName = normalizeOptionalString(entry.toolName);
    if (!toolName || seen.has(toolName)) {
      continue;
    }
    seen.add(toolName);
    tools.push(toolName);
  }
  return {
    calls: params.toolMetas?.length ?? 0,
    tools,
    failures: params.hadFailure ? 1 : 0,
  };
}

const TOOL_INTENT_GUARDRAIL_MESSAGE =
  "Tool-intent guardrail: model described a tool action but did not emit a tool call.";
const NON_ANSWER_GUARDRAIL_MESSAGE =
  "Non-answer guardrail: model produced only an ellipsis or placeholder instead of a usable response.";
const TOOL_INTENT_RETRY_INSTRUCTION =
  "Tool-call correction: your previous assistant turn described an action that requires an OpenClaw tool, but no tool call was emitted. If the next step requires reading/checking/searching/running/opening/creating/writing/dispatching/validating/verifying/sending anything, your entire next assistant message must be one or more structured tool calls and no prose before or after. Do not say what you will do. Do not write \"let me\", \"I'll\", \"I will\", or similar future-action text. If no tool is actually needed, answer directly and finally without promising any future action.";
const TOOL_INTENT_FINALIZATION_INSTRUCTION =
  "Tool-call finalization correction: the user is asking for a conclusion, summary, or suggested fix, or this turn has already made tool progress. Your previous assistant message promised more tool work without emitting a tool call. Do not start another investigation loop. Based only on the evidence already in the transcript, produce a concise final answer now. Start the visible answer with `RESPONSE_MODE: final`. If evidence is incomplete, say exactly what is known, what remains uncertain, and the single recommended next change or test. Do not write \"let me\", \"I'll\", \"I will\", or similar future-action text.";
const TOOL_INTENT_FINALIZATION_FALLBACK_TRACE_REASON =
  "tool_intent_guardrail_finalization_fallback";
const RESPONSE_MODE_PROTOCOL_INSTRUCTION =
  "Qwen response-mode protocol: when this turn asks for a conclusion, summary, final answer, root cause, or suggested fix, any visible non-tool answer must start with `RESPONSE_MODE: final`. In `RESPONSE_MODE: final`, do not promise more checking/reading/running/rewriting/sending. If more tool work is truly required, emit the tool call now; if you cannot emit a tool call, output `RESPONSE_MODE: tool_required` followed by ACTION_INTENT/type/action/reason.";
const RESPONSE_MODE_RETRY_INSTRUCTION =
  "Response-mode correction: this turn requires a structured response mode. If you can answer from the transcript, start with `RESPONSE_MODE: final` and give the final answer without promising future tool work. If more tool work is required, emit the actual tool call now with no prose. If you cannot emit the tool call, output `RESPONSE_MODE: tool_required` followed by ACTION_INTENT/type/action/reason.";
const EXECUTION_PHASE_RETRY_INSTRUCTION =
  "Execution-phase correction: your previous assistant turn declared an execution phase but did not emit the required tool call. The phase label is useful state, but it is not a user-visible reply. Resume exactly at the declared phase and emit the required structured tool call now with no prose before or after. Do not restart earlier phases, do not infer a new job id from directory listings, and do not describe what you will do.";
const USER_REQUESTS_FINALIZATION_PATTERNS = [
  /\b(?:conclusion|conclude|summary|summari[sz]e|final\s+(?:answer|result|report)|what\s+happened|what\s+went\s+wrong|root\s+cause|suggested\s+fix|modification\s+suggestion|recommend(?:ation|ed)?|next\s+change)\b/iu,
  /(?:\u7ed3\u8bba|\u603b\u7ed3|\u6536\u675f|\u6700\u540e|\u539f\u56e0|\u95ee\u9898\u5728\u54ea|\u4fee\u6539\u5efa\u8bae|\u5efa\u8bae|\u65b9\u6848|\u4e0b\u4e00\u6b65)/u,
] as const;
const TOOL_CALL_TEXT_RETRY_INSTRUCTION =
  "Tool-call correction: your previous assistant turn printed text that looked like a tool call, but the runtime did not receive a structured tool call. Your entire next assistant message must be one or more actual structured tool calls and no prose before or after. Do not print <tool_call>, JSON tool payloads, or ReAct Action text as prose. Use the available tool interface now, or answer directly and finally if no tool is needed.";
const NON_ANSWER_RETRY_INSTRUCTION =
  "Non-answer correction: your previous assistant message contained only an ellipsis or placeholder text. Do not repeat it. If the task requires a tool, emit the required structured tool call now with no prose before or after. If no tool is needed, provide a concise user-visible answer now.";
const DEFAULT_TOOL_INTENT_GUARDRAIL_RETRY_COUNT = 1;
const DEFAULT_TOOL_INTENT_GUARDRAIL_MAX_TEXT_CHARS = 600;
const TOOL_INTENT_GUARDRAIL_PATTERNS = [
  /^\s*(?:[-*]\s*)?(?:\u6211(?:\u73b0\u5728|\u4f1a|\u5c06|\u6765|\u53bb)?|\u8ba9\u6211|\u63a5\u4e0b\u6765|\u9a6c\u4e0a|\u76f4\u63a5|\u5148)\s*(?:\u53bb|\u6765|\u76f4\u63a5)?\s*(?:\u8bfb|\u8bfb\u53d6|\u67e5\u770b|\u68c0\u67e5|\u641c\u7d22|\u67e5\u627e|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528|\u6253\u5f00|\u4fee\u6539|\u5199\u5165|\u521b\u5efa|\u7f16\u8f91|\u5206\u6790|\u786e\u8ba4|\u9a8c\u8bc1)/iu,
  /^\s*(?:[-*]\s*)?(?:now\s+)?(?:I\s+(?:will|am going to|can|should|need to|now)|Let me|I(?:'|\u2019)ll)\s+(?:also\s+|first\s+|now\s+|next\s+|actually\s+|continue\s+to\s+)?(?:read|inspect|examine|review|find|check|re-?check|search|wait|dig\s+deeper|debug|look(?:\s+(?:up|at|into))?|start|restart|run|execute|call|open|edit|write|rewrite|fix|compare|create|dispatch|validate|verify|analy[sz]e|send|deliver|share|upload)/iu,
  /^\s*(?:[-*]\s*)?(?:read|exec|write|edit|message|browser|web_search|web_fetch|process|session_status|shell|terminal)\s*(?:tool|\u5de5\u5177|call|\u8c03\u7528)/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s+|[:\uff1a]\s*\r?\n\s*)(?:now\s+)?(?:Let me|I(?:'|\u2019)ll|I\s+(?:will|should|need to|am going to))\s+(?:also\s+|first\s+|now\s+|next\s+|actually\s+|continue\s+to\s+)?(?:read|inspect|examine|review|find|check|re-?check|search|wait|dig\s+deeper|debug|look(?:\s+(?:up|at|into))?|start|restart|run|execute|call|open|edit|write|rewrite|fix|compare|create|dispatch|validate|verify|analy[sz]e|send|deliver|share|upload)\b[^.!?\u3002\uff01\uff1f]*(?::|[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f,;]\s+|[:\uff1a]\s*\r?\n\s*|[\u2013\u2014-]\s+)(?:but\s+|so\s+)?(?:now\s+)?(?:Let me|I(?:'|\u2019)ll|I\s+(?:will|should|need to|am going to))\s+(?:also\s+|first\s+|now\s+|next\s+|actually\s+|continue\s+to\s+)?(?:read|inspect|examine|review|trace|find|check|re-?check|search|wait|dig\s+deeper|debug|look(?:\s+(?:up|at|into))?|start|restart|run|execute|call|open|edit|write|rewrite|fix|compare|create|dispatch|validate|verify|analy[sz]e|send|deliver|share|upload)\b[^.!?\u3002\uff01\uff1f]*(?::|[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s+|[:\uff1a]\s*\r?\n\s*)(?:now\s+)?(?:Let me|I(?:'|\u2019)ll|I\s+(?:will|should|need to|am going to))\s+(?:do|execute|run|start)\s+(?:that|this|it)\s+now(?::|[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s+|[:\uff1a]\s*\r?\n\s*)(?:now\s+)?(?:Let me|I(?:'|\u2019)ll|I\s+(?:will|should|need to|am going to))\s+use\s+`?[\w.-]+`?(?:\s+tool)?[^.!?\u3002\uff01\uff1f]*\b(?:write|create|dispatch|start|restart|run|execute|call|send|deliver|share|upload)\b[^.!?\u3002\uff01\uff1f]*(?::|[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s+|[:\uff1a]\s*\r?\n\s*)(?:now\s+)?(?:creating|writing|validating|checking|re-?checking|verifying|polling|waiting|reading|inspecting|sending|delivering|sharing|uploading)\b[^.!?\u3002\uff01\uff1f]*(?:now|next|shortly|for\s+(?:results?|status|completion)|via\s+(?:telegram|message)|to\s+(?:you|telegram)|(?:request|json|file|directory|dir))[^.!?\u3002\uff01\uff1f]*(?:[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:project|request|status|recording|video|probe|result|directory|file)\s+(?:exists|validated|complete|completed|ready|available|created|written)\b[^.!?\u3002\uff01\uff1f]*(?:now|next|phase\s*\d+|ensure|create|write|read|validate|poll|send|deliver|check|verify)\b[^.!?\u3002\uff01\uff1f]*(?:[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:project|request|recording|video|probe|status|result|file|directory|dir)\s+(?:exists|confirmed|validated|created|written|ready|available|complete|completed)\b[\s\S]{0,240}\b(?:now\s+)?(?:polling|reading|checking|validating|sending|delivering|sharing)\b[\s\S]{0,120}$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:project|request|recording|video|probe|status|result|file|directory|dir)\s+(?:exists|confirmed|validated|created|written|ready|available|complete|completed)\b[\s\S]{0,240}\b(?:now\s+)?(?:poll|read|check|validate|send|deliver|share)\b[\s\S]{0,120}$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:project|request|recording|video|probe|status|result|file|directory|dir)\b[\s\S]{0,240}\b(?:now\s+)?reading\s+it\s+back\b[\s\S]{0,120}$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:now\s+)?(?:polling|reading|checking|validating|sending|delivering|sharing)\s+(?:status|request|recording|video|probe|result|file)\b[\s\S]{0,120}$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:now\s+)?phase\s*\d+\b[^.!?\u3002\uff01\uff1f]*(?:ensure|create|write|read|validate|poll|send|deliver|check|verify|request|status|recording|video|probe|result)\b[^.!?\u3002\uff01\uff1f]*(?:[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s+|[:\uff1a]\s*\r?\n\s*)(?:now\s+)?(?:sending|delivering|sharing|uploading)\b[^.!?\u3002\uff01\uff1f]*(?:recording|video|file|artifact|screenshot|to\s+(?:you|telegram))[^.!?\u3002\uff01\uff1f]*(?:[.!?\u3002\uff01\uff1f])?\s*$/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:\u6211(?:\u518d|\u7ee7\u7eed|\u63a5\u7740)?|\u8ba9\u6211(?:\u518d|\u7ee7\u7eed)?|\u63a5\u4e0b\u6765)\s*(?:\u53bb|\u6765)?\s*(?:\u8bfb|\u8bfb\u53d6|\u67e5\u770b|\u68c0\u67e5|\u641c\u7d22|\u67e5\u627e|\u8fd0\u884c|\u6267\u884c|\u8c03\u7528|\u6253\u5f00|\u4fee\u6539|\u5199\u5165|\u521b\u5efa|\u7f16\u8f91|\u5206\u6790|\u786e\u8ba4|\u9a8c\u8bc1|\u53d1\u9001|\u5206\u4eab|\u4e0a\u4f20)[^\u3002\uff01\uff1f.!?]*(?:[\u3002\uff01\uff1f.!?])?\s*$/iu,
] as const;
const TOOL_COMPLETION_CLAIM_GUARDRAIL_PATTERNS = [
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:the\s+)?(?:(?:recording|gameplay|godot|runner|telegram|video|screenshot)\s+)?(?:request|job|file|recording|video|screenshot|message|artifact)\s+(?:has\s+been\s+|was\s+|is\s+)?(?:created|written|dispatched|submitted|queued|sent|delivered|shared|uploaded)\b/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:created|wrote|written|dispatched|submitted|queued|sent|delivered|shared|uploaded)\s+(?:the\s+)?(?:request|job|file|recording|video|screenshot|message|artifact)\b/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:I(?:'|\u2019)?ve|I\s+have)\s+(?:created|written|dispatched|submitted|queued|sent|delivered|shared|uploaded)\b/iu,
  /(?:^|[.!?\u3002\uff01\uff1f]\s*)(?:\u8bf7\u6c42|\u4efb\u52a1|\u6587\u4ef6|\u5f55\u50cf|\u89c6\u9891|\u622a\u56fe|\u6d88\u606f)\s*(?:\u5df2|\u5df2\u7ecf)?\s*(?:\u521b\u5efa|\u5199\u5165|\u63d0\u4ea4|\u6d3e\u53d1|\u6392\u961f|\u53d1\u9001|\u4ea4\u4ed8|\u5206\u4eab|\u4e0a\u4f20)/iu,
] as const;
const PLANNED_EXECUTION_PHASES = [
  "PROJECT_EXISTS",
  "CREATE_REQUEST",
  "VALIDATE_REQUEST",
  "POLL_STATUS",
  "VALIDATE_VIDEO",
  "SEND_RECORDING",
  "FINAL",
] as const;
type PlannedExecutionPhase = (typeof PLANNED_EXECUTION_PHASES)[number];

function buildExecutionPhaseRetryInstruction(phase: PlannedExecutionPhase | undefined): string {
  if (!phase) {
    return EXECUTION_PHASE_RETRY_INSTRUCTION;
  }

  const phaseInstructions: Record<PlannedExecutionPhase, string> = {
    PROJECT_EXISTS:
      "FAILED_PHASE=PROJECT_EXISTS. Emit the filesystem/process tool call that verifies the fixed project_godot path exists. Do not output PROJECT_EXISTS, EXEC_PHASE, or any status text.",
    CREATE_REQUEST:
      "FAILED_PHASE=CREATE_REQUEST. Emit only the write/create-file tool call that writes the fixed request_path with the exact request JSON from the planned execution packet. Do not read, validate, poll, send, exec, process, start Godot, restart PROJECT_EXISTS, or output CREATE_REQUEST/EXEC_PHASE text.",
    VALIDATE_REQUEST:
      "FAILED_PHASE=VALIDATE_REQUEST. Emit the tool call that reads the fixed request_path back and validates job_id, project_path, record_seconds, record_fps, and capture.fps. If a rewrite is needed, emit only the rewrite tool call. Do not poll status in this same turn and do not output VALIDATE_REQUEST/EXEC_PHASE text.",
    POLL_STATUS:
      "FAILED_PHASE=POLL_STATUS. Emit the tool call that reads the fixed status_path, or waits briefly then reads that same status_path. Do not list result directories, infer job ids, read probe_path, send video, or output POLL_STATUS/EXEC_PHASE text.",
    VALIDATE_VIDEO:
      "FAILED_PHASE=VALIDATE_VIDEO. Emit the tool call that reads the fixed probe_path and validates duration_seconds >= 14.5 and average_fps >= 55. Do not send the recording before this validation tool result and do not output VALIDATE_VIDEO/EXEC_PHASE text.",
    SEND_RECORDING:
      "FAILED_PHASE=SEND_RECORDING. Emit the message/send tool call using the fixed recording_path and the planned packet's exact delivery message. Do not restart earlier phases, do not revalidate files, and do not output SEND_RECORDING/EXEC_PHASE text.",
    FINAL:
      "FAILED_PHASE=FINAL. If delivery evidence already exists, output RESPONSE_MODE: final followed by the required JSON object. If delivery evidence does not exist, emit the missing SEND_RECORDING tool call now. Do not output FINAL/EXEC_PHASE text.",
  };

  return `${EXECUTION_PHASE_RETRY_INSTRUCTION}\n\n${phaseInstructions[phase]}`;
}


type ToolIntentGuardrailConfig = NonNullable<
  NonNullable<NonNullable<RunEmbeddedPiAgentParams["config"]>["agents"]>["defaults"]
>["embeddedPi"] extends infer EmbeddedPi
  ? EmbeddedPi extends { toolIntentGuardrail?: infer Guardrail }
    ? Guardrail
    : never
  : never;

type ResolvedToolIntentGuardrailConfig = {
  enabled: boolean;
  models: string[];
  detectors: Array<"toolCallText" | "structuredIntent" | "regex" | "llmJudge">;
  retryCount: number;
  maxTextChars: number;
  judge: {
    enabled: boolean;
    model?: string;
    minConfidence: number;
    timeoutMs: number;
    maxTokens: number;
    temperature: number;
  };
};

function clampNonNegativeInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, max)
    : fallback;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function shouldUseToolIntentGuardrailFinalizationAfterToolProgress(params: {
  retryAttempts: number;
  toolMetas?: unknown[] | null;
  clientToolCalls?: unknown;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  sawToolProgressAfterRetry?: boolean;
}): boolean {
  if (params.retryAttempts <= 0) {
    return false;
  }
  if (params.sawToolProgressAfterRetry) {
    return true;
  }
  return hasToolIntentGuardrailToolProgress(params);
}

function hasToolIntentGuardrailToolProgress(params: {
  toolMetas?: unknown[] | null;
  clientToolCalls?: unknown;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
}): boolean {
  return (
    (params.toolMetas?.length ?? 0) > 0 ||
    Boolean(params.clientToolCalls) ||
    params.didSendViaMessagingTool === true ||
    params.didSendDeterministicApprovalPrompt === true
  );
}

function sanitizeToolIntentFinalizationCandidate(text: string): string | null {
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (!normalized) {
    return null;
  }

  const lines = normalized
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return true;
      }
      if (/^RESPONSE_MODE\s*:\s*(final|tool_required)\s*$/iu.test(trimmed)) {
        return false;
      }
      if (/<\/?(tool_call|function|parameter)\b/iu.test(trimmed)) {
        return false;
      }
      if (/^(?:now\s+)?(?:let me|i(?:'|’)ll|i will)\s+/iu.test(trimmed)) {
        return false;
      }
      if (/^(?:我(?:现在|接下来)?(?:会|要|来)|让我|先让我|接下来我(?:会|要|来))/u.test(trimmed)) {
        return false;
      }
      return true;
    });

  const sanitized = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (sanitized.length < 80) {
    return null;
  }
  if (/tool-intent guardrail/iu.test(sanitized)) {
    return null;
  }
  if (looksLikeNonAnswerPlaceholder(sanitized, 600)) {
    return null;
  }

  const evidenceSignals = [
    /\b(root cause|cause|reason|issue|problem|diagnos|evidence|observed|fix|recommend)/iu,
    /\b(record(?:ing)?|duration|frame_count|fps|ffmpeg|mss|gdigrab|capture_region|record_seconds|runner|request|json)\b/iu,
    /(原因|问题|证据|录像|录制|帧|修复|建议|诊断|结论|请求|配置)/u,
  ].filter((pattern) => pattern.test(sanitized)).length;
  if (evidenceSignals < 2) {
    return null;
  }

  return sanitized;
}

function buildToolIntentFinalizationFallbackText(params: {
  lastAssistantText?: string | null;
  toolMetas?: Array<{ toolName?: string; name?: string }> | null;
}): string {
  const sanitizedCandidate = sanitizeToolIntentFinalizationCandidate(
    String(params.lastAssistantText ?? ""),
  );
  if (sanitizedCandidate) {
    return sanitizedCandidate;
  }

  const attemptedAction = String(params.lastAssistantText ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 240);
  const toolNames = Array.from(
    new Set(
      (params.toolMetas ?? [])
        .map((entry) => entry.toolName ?? entry.name)
        .map((name) => String(name ?? "").trim())
        .filter(Boolean),
    ),
  );
  const evidence =
    toolNames.length > 0
      ? `the transcript already contains tool progress (${toolNames.join(", ")})`
      : "the transcript contains the user's request and the model's latest attempted next step";

  return [
    "Debugging conclusion: the run reached finalization, but the model tried to continue with another tool action instead of giving a final answer.",
    `Known: ${evidence}, and OpenClaw intercepted the latest action promise before sending it as a normal reply.`,
    `Uncertain: the exact task-level root cause still needs direct log or artifact evidence${attemptedAction ? `; the blocked attempted next step was: "${attemptedAction}"` : ""}.`,
    "Recommended next change: run one explicit follow-up tool turn to inspect the relevant status/log/artifact file, then summarize only from that evidence.",
  ].join("\n");
}

function resolveToolIntentGuardrailConfig(
  cfg: RunEmbeddedPiAgentParams["config"] | undefined,
  agentId?: string | null,
): ResolvedToolIntentGuardrailConfig {
  const defaults = cfg?.agents?.defaults?.embeddedPi?.toolIntentGuardrail;
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId)?.embeddedPi : undefined;
  const override = agentConfig?.toolIntentGuardrail;
  const merged: ToolIntentGuardrailConfig = {
    ...(defaults ?? {}),
    ...(override ?? {}),
    judge: {
      ...(defaults?.judge ?? {}),
      ...(override?.judge ?? {}),
    },
  };
  const judgeEnabled = merged.judge?.enabled === true;
  const configuredDetectors = Array.isArray(merged.detectors)
    ? merged.detectors.filter(
        (entry): entry is ResolvedToolIntentGuardrailConfig["detectors"][number] =>
          entry === "toolCallText" ||
          entry === "structuredIntent" ||
          entry === "regex" ||
          entry === "llmJudge",
      )
    : [];
  const detectors: ResolvedToolIntentGuardrailConfig["detectors"] =
    configuredDetectors.length > 0
      ? configuredDetectors
      : judgeEnabled
        ? ["toolCallText", "structuredIntent", "regex", "llmJudge"]
        : ["toolCallText", "structuredIntent", "regex"];
  return {
    enabled: merged.enabled === true,
    models: Array.isArray(merged.models)
      ? merged.models.map((entry) => entry.trim()).filter(Boolean)
      : [],
    detectors,
    retryCount: clampNonNegativeInteger(
      merged.retryCount,
      DEFAULT_TOOL_INTENT_GUARDRAIL_RETRY_COUNT,
      5,
    ),
    maxTextChars: clampNonNegativeInteger(
      merged.maxTextChars,
      DEFAULT_TOOL_INTENT_GUARDRAIL_MAX_TEXT_CHARS,
      4000,
    ),
    judge: {
      enabled: judgeEnabled,
      ...(typeof merged.judge?.model === "string" && merged.judge.model.trim()
        ? { model: merged.judge.model.trim() }
        : {}),
      minConfidence: clampNumber(merged.judge?.minConfidence, 0.7, 0, 1),
      timeoutMs: clampNonNegativeInteger(merged.judge?.timeoutMs, 12_000, 60_000) || 12_000,
      maxTokens: clampNonNegativeInteger(merged.judge?.maxTokens, 180, 1000) || 180,
      temperature: clampNumber(merged.judge?.temperature, 0, 0, 2),
    },
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesModelPattern(pattern: string, provider: unknown, modelId: unknown): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  if (!normalizedPattern) {
    return false;
  }
  if (normalizedPattern === "*") {
    return true;
  }
  const providerText = String(provider ?? "").toLowerCase();
  const modelText = String(modelId ?? "").toLowerCase();
  const refText = providerText ? `${providerText}/${modelText}` : modelText;
  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${normalizedPattern.split("*").map(escapeRegExpLiteral).join(".*")}$`);
    return regex.test(refText) || regex.test(modelText);
  }
  return (
    refText === normalizedPattern ||
    modelText === normalizedPattern ||
    providerText === normalizedPattern ||
    refText.includes(normalizedPattern) ||
    modelText.includes(normalizedPattern)
  );
}

function isToolIntentGuardrailEnabledForModel(params: {
  config: ResolvedToolIntentGuardrailConfig;
  provider: unknown;
  modelId: unknown;
}): boolean {
  if (!params.config.enabled) {
    return false;
  }
  if (params.config.models.length === 0) {
    return true;
  }
  return params.config.models.some((pattern) =>
    matchesModelPattern(pattern, params.provider, params.modelId),
  );
}

function buildGuardrailTextScanCandidates(text: unknown, maxTextChars: number): string[] {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return [];
  }
  return trimmed.length <= maxTextChars
    ? [trimmed]
    : [
        trimmed.slice(0, maxTextChars).trim(),
        trimmed.slice(Math.max(0, trimmed.length - maxTextChars)).trim(),
      ].filter(Boolean);
}

function looksLikeDeferredToolIntent(text: unknown, maxTextChars: number): boolean {
  return buildGuardrailTextScanCandidates(text, maxTextChars).some((candidate) =>
    TOOL_INTENT_GUARDRAIL_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

function looksLikeUnsupportedToolCompletionClaim(text: unknown, maxTextChars: number): boolean {
  return buildGuardrailTextScanCandidates(text, maxTextChars).some((candidate) =>
    TOOL_COMPLETION_CLAIM_GUARDRAIL_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

function looksLikeFinalizationRequest(text: unknown, maxTextChars: number): boolean {
  return buildGuardrailTextScanCandidates(text, maxTextChars).some((candidate) =>
    USER_REQUESTS_FINALIZATION_PATTERNS.some((pattern) => pattern.test(candidate)),
  );
}

function looksLikeStructuredToolIntent(text: unknown, maxTextChars: number): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > maxTextChars) {
    return false;
  }
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length >= 4 &&
    lines[0] === "ACTION_INTENT" &&
    /^type:\s*tool_required\s*$/iu.test(lines[1] ?? "") &&
    /^action:\s*\S.+$/iu.test(lines[2] ?? "") &&
    /^reason:\s*\S.+$/iu.test(lines[3] ?? "")
  );
}

function normalizeExecutionPhase(value: string | undefined): PlannedExecutionPhase | null {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return PLANNED_EXECUTION_PHASES.includes(normalized as PlannedExecutionPhase)
    ? (normalized as PlannedExecutionPhase)
    : null;
}

function parseExecutionPhaseLabel(text: unknown, maxTextChars: number): PlannedExecutionPhase | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > maxTextChars) {
    return null;
  }
  const unfenced = stripMarkdownFence(trimmed);
  const firstNonEmptyLine = unfenced
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmptyLine) {
    return null;
  }

  const explicit =
    /^EXEC_PHASE\s*:\s*([A-Z0-9_-]+)\s*\.?$/iu.exec(firstNonEmptyLine) ??
    /^EXECUTION_PHASE\s*:\s*([A-Z0-9_-]+)\s*\.?$/iu.exec(firstNonEmptyLine);
  if (explicit) {
    return normalizeExecutionPhase(explicit[1]);
  }

  const legacy =
    /^Phase\s+([A-Z0-9_-]+)\s*:?\s*$/iu.exec(firstNonEmptyLine) ??
    /^Phase\s+\d+\s*[-:]\s*([A-Z0-9_-]+)\s*:?\s*$/iu.exec(firstNonEmptyLine);
  if (legacy) {
    return normalizeExecutionPhase(legacy[1]);
  }

  return null;
}

function detectExecutionPhaseGuardrail(params: {
  text: unknown;
  maxTextChars: number;
}): ToolIntentGuardrailVerdict | null {
  const phase = parseExecutionPhaseLabel(params.text, params.maxTextChars);
  return phase
    ? {
        trigger: true,
        detector: "phaseLabel",
        reason: `execution phase declared without tool call: ${phase}`,
        phase,
      }
    : null;
}

type ResponseMode = "final" | "tool_required";

function parseResponseMode(text: unknown, maxTextChars: number): ResponseMode | null {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > maxTextChars) {
    return null;
  }
  const match = /^RESPONSE_MODE:\s*(final|tool_required)\s*$/imu.exec(trimmed);
  return (match?.[1]?.toLowerCase() as ResponseMode | undefined) ?? null;
}

function detectResponseModeGuardrail(params: {
  text: unknown;
  maxTextChars: number;
  requireResponseMode?: boolean;
}): ToolIntentGuardrailVerdict | null {
  const mode = parseResponseMode(params.text, params.maxTextChars);
  if (mode === "tool_required") {
    return {
      trigger: true,
      detector: "responseMode",
      reason: "response mode requested a tool without a structured tool call",
    };
  }
  if (mode === "final") {
    return looksLikeDeferredToolIntent(params.text, params.maxTextChars)
      ? {
          trigger: true,
          detector: "responseMode",
          reason: "final response mode still promised more tool work",
        }
      : null;
  }
  if (params.requireResponseMode === true) {
    return {
      trigger: true,
      detector: "responseMode",
      reason: "missing response mode for finalization request",
    };
  }
  return null;
}

function stripMarkdownFence(text: string): string {
  const match = /^```[A-Za-z0-9_-]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/u.exec(text.trim());
  return match?.[1]?.trim() ?? text.trim();
}

function looksLikeBareToolCallText(text: unknown, maxTextChars: number): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > maxTextChars) {
    return false;
  }
  const candidate = stripMarkdownFence(trimmed);
  if (
    !/^(?:<\s*tool_call\b|\{\s*"(?:(?:tool_)?calls?|name)"\s*:|\[\s*\{|\[\s*TOOL_CALL\s*\]|Action\s*:)/iu.test(
      candidate,
    )
  ) {
    return false;
  }
  return Boolean(detectToolCallShapedText(candidate));
}

function looksLikeNonAnswerPlaceholder(text: unknown, maxTextChars: number): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed || trimmed.length > Math.min(maxTextChars, 24)) {
    return false;
  }
  const normalized = trimmed
    .replace(/```[\s\S]*?```/gu, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/gu, "");
  if (!normalized) {
    return false;
  }
  return /^[.…。．.]+$/u.test(normalized);
}

function detectToolCallTextGuardrail(params: {
  text: unknown;
  thinkingText?: unknown;
  maxTextChars: number;
}): ToolIntentGuardrailVerdict | null {
  if (looksLikeBareToolCallText(params.text, params.maxTextChars)) {
    const detection = detectToolCallShapedText(stripMarkdownFence(String(params.text ?? "")));
    return {
      trigger: true,
      detector: "toolCallText",
      reason: detection?.toolName
        ? `visible ${detection.kind}:${detection.toolName}`
        : "visible tool-call-shaped text",
    };
  }

  const visibleText = String(params.text ?? "").trim();
  if (visibleText) {
    return null;
  }
  const thinking = String(params.thinkingText ?? "").trim();
  if (!thinking || thinking.length > params.maxTextChars) {
    return null;
  }
  const detection = detectToolCallShapedText(thinking);
  if (!detection) {
    return null;
  }
  return {
    trigger: true,
    detector: "toolCallText",
    reason: detection.toolName
      ? `thinking ${detection.kind}:${detection.toolName}`
      : "thinking tool-call-shaped text",
  };
}

type ToolIntentGuardrailCommonParams = {
  config: ResolvedToolIntentGuardrailConfig;
  provider: unknown;
  modelId: unknown;
  text: unknown;
  thinkingText?: unknown;
  toolMetas?: unknown[];
  finalAssistantHasToolCall?: boolean;
  clientToolCalls?: unknown;
  allowFinalizationTextAfterToolCall?: boolean;
  requireResponseMode?: boolean;
  yieldDetected?: boolean;
  didSendViaMessagingTool?: boolean;
  didSendDeterministicApprovalPrompt?: boolean;
  lastToolError?: unknown;
};

type ToolIntentGuardrailVerdict = {
  trigger: boolean;
  detector:
    | "none"
    | "toolCallText"
    | "phaseLabel"
    | "responseMode"
    | "structuredIntent"
    | "regex"
    | "llmJudge";
  reason?: string;
  phase?: PlannedExecutionPhase;
};

type ToolIntentJudgeFn = (params: {
  cfg: RunEmbeddedPiAgentParams["config"] | undefined;
  agentId?: string | null;
  config: ResolvedToolIntentGuardrailConfig;
  assistantText: string;
}) => Promise<ToolIntentGuardrailVerdict>;

function assistantMessageHasToolCall(message: unknown): boolean {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  return (
    Array.isArray(content) &&
    content.some((block) => (block as { type?: unknown } | null | undefined)?.type === "toolCall")
  );
}

function shouldConsiderToolIntentGuardrail(params: ToolIntentGuardrailCommonParams): boolean {
  if (
    !isToolIntentGuardrailEnabledForModel({
      config: params.config,
      provider: params.provider,
      modelId: params.modelId,
    })
  ) {
    return false;
  }
  if (
    (params.finalAssistantHasToolCall || params.clientToolCalls) &&
    !params.allowFinalizationTextAfterToolCall
  ) {
    return false;
  }
  if (
    params.yieldDetected ||
    params.didSendViaMessagingTool ||
    params.didSendDeterministicApprovalPrompt
  ) {
    return false;
  }
  const trimmed = String(params.text ?? "").trim();
  const thinking = String(params.thinkingText ?? "").trim();
  return Boolean(
    trimmed ||
      (thinking && thinking.length <= params.config.maxTextChars),
  );
}

function shouldTriggerToolIntentGuardrail(params: ToolIntentGuardrailCommonParams): boolean {
  const hasToolEvidence = (params.toolMetas?.length ?? 0) > 0;
  return (
    shouldConsiderToolIntentGuardrail(params) &&
    ((params.config.detectors.includes("toolCallText") &&
      detectToolCallTextGuardrail({
        text: params.text,
        thinkingText: params.thinkingText,
        maxTextChars: params.config.maxTextChars,
      })?.trigger === true) ||
      (params.config.detectors.includes("structuredIntent") &&
        detectExecutionPhaseGuardrail({
          text: params.text,
          maxTextChars: params.config.maxTextChars,
        })?.trigger === true) ||
      (params.config.detectors.includes("structuredIntent") &&
        detectResponseModeGuardrail({
          text: params.text,
          maxTextChars: params.config.maxTextChars,
          requireResponseMode: params.requireResponseMode,
        })?.trigger === true) ||
      (params.config.detectors.includes("structuredIntent") &&
      looksLikeStructuredToolIntent(params.text, params.config.maxTextChars)) ||
      (params.config.detectors.includes("regex") &&
        (looksLikeDeferredToolIntent(params.text, params.config.maxTextChars) ||
          (!hasToolEvidence &&
            looksLikeUnsupportedToolCompletionClaim(
              params.text,
              params.config.maxTextChars,
            )))))
  );
}

async function evaluateToolIntentGuardrail(
  params: ToolIntentGuardrailCommonParams & {
    cfg?: RunEmbeddedPiAgentParams["config"];
    agentId?: string | null;
    judge?: ToolIntentJudgeFn;
  },
): Promise<ToolIntentGuardrailVerdict> {
  if (!shouldConsiderToolIntentGuardrail(params)) {
    return { trigger: false, detector: "none" };
  }
  if (params.config.detectors.includes("toolCallText")) {
    const toolCallTextVerdict = detectToolCallTextGuardrail({
      text: params.text,
      thinkingText: params.thinkingText,
      maxTextChars: params.config.maxTextChars,
    });
    if (toolCallTextVerdict) {
      return toolCallTextVerdict;
    }
  }
  if (
    params.config.detectors.includes("structuredIntent")
  ) {
    const executionPhaseVerdict = detectExecutionPhaseGuardrail({
      text: params.text,
      maxTextChars: params.config.maxTextChars,
    });
    if (executionPhaseVerdict) {
      return executionPhaseVerdict;
    }
    const responseModeVerdict = detectResponseModeGuardrail({
      text: params.text,
      maxTextChars: params.config.maxTextChars,
      requireResponseMode: params.requireResponseMode,
    });
    if (responseModeVerdict) {
      return responseModeVerdict;
    }
  }
  if (
    params.config.detectors.includes("structuredIntent") &&
    looksLikeStructuredToolIntent(params.text, params.config.maxTextChars)
  ) {
    return { trigger: true, detector: "structuredIntent", reason: "structured intent" };
  }
  if (
    params.config.detectors.includes("regex") &&
    looksLikeDeferredToolIntent(params.text, params.config.maxTextChars)
  ) {
    return { trigger: true, detector: "regex", reason: "regex" };
  }
  if (
    params.config.detectors.includes("regex") &&
    (params.toolMetas?.length ?? 0) === 0 &&
    looksLikeUnsupportedToolCompletionClaim(params.text, params.config.maxTextChars)
  ) {
    return { trigger: true, detector: "regex", reason: "completion claim without tool evidence" };
  }
  if (
    !params.config.detectors.includes("llmJudge") ||
    !params.config.judge.enabled ||
    String(params.text ?? "").trim().length > params.config.maxTextChars
  ) {
    return { trigger: false, detector: "none" };
  }
  return await (params.judge ?? judgeToolIntentWithLlm)({
    cfg: params.cfg,
    agentId: params.agentId,
    config: params.config,
    assistantText: String(params.text ?? "").trim(),
  });
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) {
    return direct;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJsonObject(trimmed.slice(start, end + 1));
  }
  return null;
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJudgeBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function readJudgeConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

async function judgeToolIntentWithLlm(params: {
  cfg: RunEmbeddedPiAgentParams["config"] | undefined;
  agentId?: string | null;
  config: ResolvedToolIntentGuardrailConfig;
  assistantText: string;
}): Promise<ToolIntentGuardrailVerdict> {
  if (!params.cfg || !params.agentId) {
    return { trigger: false, detector: "llmJudge", reason: "judge unavailable" };
  }
  try {
    const { prepareSimpleCompletionModelForAgent, completeWithPreparedSimpleCompletionModel } =
      await import("../simple-completion-runtime.js");
    const prepared = await prepareSimpleCompletionModelForAgent({
      cfg: params.cfg,
      agentId: params.agentId,
      modelRef: params.config.judge.model,
      allowMissingApiKeyModes: ["aws-sdk"],
    });
    if ("error" in prepared) {
      log.warn(`tool-intent guardrail judge unavailable: ${prepared.error}`);
      return { trigger: false, detector: "llmJudge", reason: "judge unavailable" };
    }
    const result = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      cfg: params.cfg,
      context: {
        systemPrompt:
          "You are a strict classifier for an agent runtime guardrail. Decide whether the assistant text promises or announces a concrete action that requires a tool or external state access, but no tool call was emitted in that final assistant message. Return only compact JSON with keys: requires_tool, promised_action, should_retry, confidence, reason. Do not include markdown.",
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content:
              `Assistant text:\n${params.assistantText}\n\n` +
              "Classify as should_retry=true only when the assistant is saying it will now read/check/search/run/open/create/write/dispatch/verify something, or continue investigating, and that action would require a tool or external state. Do not flag explanations, examples, quotes, or direct final answers.",
          },
        ],
      },
      options: {
        maxTokens: params.config.judge.maxTokens,
        temperature: params.config.judge.temperature,
        signal: AbortSignal.timeout(params.config.judge.timeoutMs),
      },
    });
    const text = result.content
      .filter((entry): entry is { type: "text"; text: string } => entry.type === "text")
      .map((entry) => entry.text)
      .join("");
    const parsed = extractJsonObject(text);
    if (!parsed) {
      log.warn("tool-intent guardrail judge returned non-JSON output");
      return { trigger: false, detector: "llmJudge", reason: "judge non-json" };
    }
    const confidence = readJudgeConfidence(parsed.confidence);
    const trigger =
      readJudgeBoolean(parsed.should_retry) &&
      readJudgeBoolean(parsed.requires_tool) &&
      confidence >= params.config.judge.minConfidence;
    return {
      trigger,
      detector: "llmJudge",
      reason:
        typeof parsed.reason === "string"
          ? parsed.reason
          : typeof parsed.promised_action === "string"
            ? parsed.promised_action
            : undefined,
    };
  } catch (err) {
    log.warn(`tool-intent guardrail judge failed: ${formatErrorMessage(err)}`);
    return { trigger: false, detector: "llmJudge", reason: "judge failed" };
  }
}

/**
 * Best-effort backfill of sessionKey from sessionId when not explicitly provided.
 * The return value is normalized: whitespace-only inputs collapse to undefined, and
 * successful resolution returns a trimmed session key. This is a read-only lookup
 * with no side effects.
 * See: https://github.com/openclaw/openclaw/issues/60552
 */
function backfillSessionKey(params: {
  config: RunEmbeddedPiAgentParams["config"];
  sessionId: string;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const trimmed = normalizeOptionalString(params.sessionKey);
  if (trimmed) {
    return trimmed;
  }
  if (!params.config || !params.sessionId) {
    return undefined;
  }
  try {
    const resolved = normalizeOptionalString(params.agentId)
      ? resolveStoredSessionKeyForSessionId({
          cfg: params.config,
          sessionId: params.sessionId,
          agentId: params.agentId,
        })
      : resolveSessionKeyForRequest({
          cfg: params.config,
          sessionId: params.sessionId,
        });
    return normalizeOptionalString(resolved.sessionKey);
  } catch (err) {
    log.warn(
      `[backfillSessionKey] Failed to resolve sessionKey for sessionId=${redactRunIdentifier(sanitizeForLog(params.sessionId))}: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

function buildHandledReplyPayloads(reply?: ReplyPayload) {
  const normalized = reply ?? { text: SILENT_REPLY_TOKEN };
  return [
    {
      text: normalized.text,
      mediaUrl: normalized.mediaUrl,
      mediaUrls: normalized.mediaUrls,
      replyToId: normalized.replyToId,
      audioAsVoice: normalized.audioAsVoice,
      isError: normalized.isError,
      isReasoning: normalized.isReasoning,
    },
  ];
}

const TERMINAL_PLANNED_EXECUTION_FAILURE_REASONS = new Set([
  "missing_or_unsafe_job_id",
  "missing_video_probe",
  "request_missing",
  "request_job_id_mismatch",
  "request_project_path_mismatch",
  "request_startup_wait_mismatch",
  "request_record_seconds_mismatch",
  "request_record_fps_mismatch",
  "request_capture_missing",
  "request_capture_record_seconds_mismatch",
  "request_capture_fps_mismatch",
  "recording_too_short",
  "fps_too_low",
  "effective_fps_too_low",
]);

const CANONICALIZABLE_PLANNED_EXECUTION_REQUEST_REASONS = new Set([
  "request_job_id_mismatch",
  "request_project_path_mismatch",
  "request_startup_wait_mismatch",
  "request_record_seconds_mismatch",
  "request_record_fps_mismatch",
  "request_capture_record_seconds_mismatch",
  "request_capture_fps_mismatch",
]);

function isTerminalPlannedExecutionFailure(
  result: Awaited<ReturnType<typeof resolvePlannedExecutionFinalizer>>,
): result is Extract<
  NonNullable<Awaited<ReturnType<typeof resolvePlannedExecutionFinalizer>>>,
  { ok: false }
> {
  return Boolean(result && !result.ok && TERMINAL_PLANNED_EXECUTION_FAILURE_REASONS.has(result.reason));
}

function buildTerminalPlannedExecutionFailurePayload(
  result: Extract<NonNullable<Awaited<ReturnType<typeof resolvePlannedExecutionFinalizer>>>, { ok: false }>,
): ReplyPayload {
  const jobIdText = result.jobId ? ` job_id=${result.jobId}` : "";
  return {
    text: `Godot recording validation failed${jobIdText}: ${result.reason}. I did not send the recording because it did not meet the planned execution acceptance criteria.`,
    isError: true,
  };
}

export async function runEmbeddedPiAgent(
  params: RunEmbeddedPiAgentParams,
): Promise<EmbeddedPiRunResult> {
  // Resolve sessionKey early so all downstream consumers (hooks, LCM, compaction)
  // receive a non-null key even when callers omit it. See #60552.
  const effectiveSessionKey = backfillSessionKey({
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (effectiveSessionKey !== params.sessionKey) {
    params = { ...params, sessionKey: effectiveSessionKey };
  }
  const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
  const globalLane = resolveGlobalLane(params.lane);
  const sessionQueuePriority = resolveEmbeddedRunSessionQueuePriority(params.trigger);
  const laneTaskTimeoutMs = resolveEmbeddedRunLaneTimeoutMs(params.timeoutMs);
  let laneTaskProgressAtMs = Date.now();
  const noteLaneTaskProgress = () => {
    laneTaskProgressAtMs = Date.now();
  };
  const withLaneTimeout = (opts?: CommandQueueEnqueueOptions) =>
    withEmbeddedRunLaneTimeout(
      {
        ...opts,
        taskTimeoutProgressAtMs: () => laneTaskProgressAtMs,
      },
      laneTaskTimeoutMs,
    );
  const enqueueGlobal = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) =>
    params.enqueue
      ? params.enqueue(task, withLaneTimeout(opts))
      : enqueueCommandInLane(globalLane, task, withLaneTimeout(opts));
  const enqueueSession = <T>(task: () => Promise<T>, opts?: CommandQueueEnqueueOptions) => {
    const sessionOpts: CommandQueueEnqueueOptions = { ...opts, priority: sessionQueuePriority };
    return params.enqueue
      ? params.enqueue(task, sessionOpts)
      : enqueueCommandInLane(sessionLane, task, sessionOpts);
  };
  const channelHint = params.messageChannel ?? params.messageProvider;
  const resolvedToolResultFormat =
    params.toolResultFormat ??
    (channelHint
      ? isMarkdownCapableMessageChannel(channelHint)
        ? "markdown"
        : "plain"
      : "markdown");
  const isProbeSession = params.sessionId?.startsWith("probe-") ?? false;

  const throwIfAborted = () => {
    if (!params.abortSignal?.aborted) {
      return;
    }
    const reason = params.abortSignal.reason;
    if (reason instanceof Error) {
      throw reason;
    }
    const abortErr =
      reason !== undefined
        ? new Error("Operation aborted", { cause: reason })
        : new Error("Operation aborted");
    abortErr.name = "AbortError";
    throw abortErr;
  };

  throwIfAborted();

  return enqueueSession(() => {
    throwIfAborted();
    return enqueueGlobal(async () => {
      throwIfAborted();
      const started = Date.now();
      const startupStages = createEmbeddedRunStageTracker();
      let startupStagesEmitted = false;
      const notifyExecutionPhase = (
        phase: Parameters<NonNullable<RunEmbeddedPiAgentParams["onExecutionPhase"]>>[0]["phase"],
        extra?: Omit<
          Parameters<NonNullable<RunEmbeddedPiAgentParams["onExecutionPhase"]>>[0],
          "phase"
        >,
      ) => {
        noteLaneTaskProgress();
        params.onExecutionPhase?.({ phase, ...extra });
      };
      const notifyRunProgress = (
        info: Parameters<NonNullable<RunEmbeddedPiAgentParams["onRunProgress"]>>[0],
      ) => {
        noteLaneTaskProgress();
        params.onRunProgress?.(info);
      };
      const emitStartupStageSummary = (phase: string) => {
        const summary = startupStages.snapshot();
        const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary);
        if (!shouldWarn && !log.isEnabled("trace")) {
          return;
        }
        const message = formatEmbeddedRunStageSummary(
          `[trace:embedded-run] startup stages: runId=${params.runId} sessionId=${params.sessionId} phase=${phase}`,
          summary,
        );
        if (shouldWarn) {
          log.warn(message);
        } else {
          log.trace(message);
        }
      };
      params.onExecutionStarted?.();
      notifyExecutionPhase("runner_entered");
      const workspaceResolution = resolveRunWorkspaceDir({
        workspaceDir: params.workspaceDir,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        config: params.config,
      });
      const resolvedWorkspace = workspaceResolution.workspaceDir;
      const canonicalWorkspace = resolveUserPath(
        resolveAgentWorkspaceDir(params.config ?? {}, workspaceResolution.agentId),
      );
      const isCanonicalWorkspace = canonicalWorkspace === resolvedWorkspace;
      const redactedSessionId = redactRunIdentifier(params.sessionId);
      const redactedSessionKey = redactRunIdentifier(params.sessionKey);
      const redactedWorkspace = redactRunIdentifier(resolvedWorkspace);
      if (workspaceResolution.usedFallback) {
        log.warn(
          `[workspace-fallback] caller=runEmbeddedPiAgent reason=${workspaceResolution.fallbackReason} run=${params.runId} session=${redactedSessionId} sessionKey=${redactedSessionKey} agent=${workspaceResolution.agentId} workspace=${redactedWorkspace}`,
        );
      }
      startupStages.mark("workspace");
      notifyExecutionPhase("workspace");
      ensureRuntimePluginsLoaded({
        config: params.config,
        workspaceDir: resolvedWorkspace,
        allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      });
      startupStages.mark("runtime-plugins");
      notifyExecutionPhase("runtime_plugins");

      let provider = (params.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
      let modelId = (params.model ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
      const agentDir =
        params.agentDir ?? resolveAgentDir(params.config ?? {}, workspaceResolution.agentId);
      const normalizedSessionKey = params.sessionKey?.trim();
      const fallbackConfigured = hasEmbeddedRunConfiguredModelFallbacks({
        cfg: params.config,
        agentId: params.agentId,
        sessionKey: normalizedSessionKey,
        modelFallbacksOverride: params.modelFallbacksOverride,
      });
      const resolvedSessionKey = normalizedSessionKey;
      const hookRunner = getGlobalHookRunner();
      const hookCtx = {
        runId: params.runId,
        jobId: params.jobId,
        agentId: workspaceResolution.agentId,
        sessionKey: resolvedSessionKey,
        sessionId: params.sessionId,
        workspaceDir: resolvedWorkspace,
        modelProviderId: provider,
        modelId,
        trigger: params.trigger,
        ...buildAgentHookContextChannelFields(params),
      };
      if (params.trigger === "cron" && hookRunner?.hasHooks("before_agent_reply")) {
        notifyExecutionPhase("before_agent_reply", { provider, model: modelId });
        const hookResult = await hookRunner.runBeforeAgentReply(
          { cleanedBody: params.prompt },
          hookCtx,
        );
        if (hookResult?.handled) {
          return {
            payloads: buildHandledReplyPayloads(hookResult.reply),
            meta: {
              durationMs: Date.now() - started,
              agentMeta: {
                sessionId: params.sessionId,
                provider,
                model: modelId,
              },
              finalAssistantVisibleText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
              finalAssistantRawText: hookResult.reply?.text ?? SILENT_REPLY_TOKEN,
            },
          };
        }
        notifyExecutionPhase("runtime_plugins", { provider, model: modelId });
      }

      const hookSelection = await resolveHookModelSelection({
        prompt: params.prompt,
        attachments: buildBeforeModelResolveAttachments(params.images),
        provider,
        modelId,
        hookRunner,
        hookContext: hookCtx,
      });
      provider = hookSelection.provider;
      modelId = hookSelection.modelId;
      const legacyBeforeAgentStartResult = hookSelection.legacyBeforeAgentStartResult;
      startupStages.mark("hooks");
      await ensureSelectedAgentHarnessPlugin({
        provider,
        modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
        workspaceDir: resolvedWorkspace,
      });
      const agentHarness = selectAgentHarness({
        provider,
        modelId,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        agentHarnessId: params.agentHarnessId,
        agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
      });
      const pluginHarnessOwnsTransport = agentHarness.id !== "pi";
      const modelConfigProvider = provider;
      const selectedPiRuntimeProvider = resolveSelectedOpenAIPiRuntimeProvider({
        provider,
        harnessRuntime: agentHarness.id,
        agentHarnessId: agentHarness.id,
        authProfileProvider: params.authProfileId?.split(":", 1)[0],
        authProfileId: params.authProfileId,
        config: params.config,
        workspaceDir: resolvedWorkspace,
      });
      const dynamicModelResolution = await resolveModelAsync(
        provider,
        modelId,
        agentDir,
        params.config,
        {
          // Plugin dynamic model hooks can resolve explicit model refs without
          // first generating PI models.json. This keeps one-shot model runs from
          // blocking on unrelated provider discovery.
          skipPiDiscovery: true,
          workspaceDir: resolvedWorkspace,
        },
      );
      let modelResolution =
        dynamicModelResolution.model || pluginHarnessOwnsTransport
          ? dynamicModelResolution
          : await (async () => {
              await ensureOpenClawModelsJson(params.config, agentDir, {
                workspaceDir: resolvedWorkspace,
              });
              return await resolveModelAsync(provider, modelId, agentDir, params.config, {
                workspaceDir: resolvedWorkspace,
              });
            })();
      if (selectedPiRuntimeProvider !== provider && modelResolution.model) {
        const runtimeModelResolution = await resolveModelAsync(
          selectedPiRuntimeProvider,
          modelId,
          agentDir,
          params.config,
          {
            skipPiDiscovery: true,
            workspaceDir: resolvedWorkspace,
          },
        );
        if (runtimeModelResolution.model) {
          provider = selectedPiRuntimeProvider;
          modelResolution = runtimeModelResolution;
        }
      }
      const { model, error, authStorage, modelRegistry } = modelResolution;
      if (!model) {
        throw new FailoverError(error ?? `Unknown model: ${provider}/${modelId}`, {
          reason: "model_not_found",
          provider,
          model: modelId,
          sessionId: params.sessionId,
          lane: globalLane,
        });
      }
      let runtimeModel = model;

      const resolvedRuntimeModel = resolveEffectiveRuntimeModel({
        cfg: params.config,
        provider,
        contextConfigProvider: resolveContextConfigProviderForRuntime({
          provider: modelConfigProvider,
          runtimeId: agentHarness.id,
        }),
        modelId,
        runtimeModel,
      });
      const ctxInfo = resolvedRuntimeModel.ctxInfo;
      let effectiveModel = resolvedRuntimeModel.effectiveModel;
      startupStages.mark("model-resolution");
      notifyExecutionPhase("model_resolution", { provider, model: modelId });

      const pluginHarnessNeedsOpenClawAuthBootstrap =
        pluginHarnessOwnsTransport &&
        provider === OPENAI_CODEX_PROVIDER_ID &&
        effectiveModel.api === "openai-codex-responses";
      const authStore =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? createEmptyAuthProfileStore()
          : pluginHarnessNeedsOpenClawAuthBootstrap
            ? ensureAuthProfileStore(agentDir, {
                externalCliProviderIds: [OPENAI_CODEX_PROVIDER_ID],
                allowKeychainPrompt: false,
              })
            : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
                allowKeychainPrompt: false,
              });
      const attemptAuthProfileStore =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
              allowKeychainPrompt: false,
            })
          : authStore;
      const requestedProfileId = params.authProfileId?.trim();
      const requestedProfileIsUserLocked = params.authProfileIdSource === "user";
      const isForwardablePluginHarnessAuthProfile = (
        profileId: string | undefined,
      ): profileId is string => {
        if (!pluginHarnessOwnsTransport || !profileId) {
          return false;
        }
        const credential = attemptAuthProfileStore.profiles?.[profileId];
        const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
          provider,
          authProfileProvider: credential?.provider ?? profileId.split(":", 1)[0],
          authProfileMode: credential?.type,
          sessionAuthProfileId: profileId,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          harnessId: agentHarness.id,
          harnessRuntime: agentHarness.id,
          allowHarnessAuthProfileForwarding: true,
        });
        return runtimeAuthPlan.forwardedAuthProfileId === profileId;
      };
      const resolvePluginHarnessProfileOrder = (): string[] => {
        if (requestedProfileId && requestedProfileIsUserLocked) {
          return isForwardablePluginHarnessAuthProfile(requestedProfileId)
            ? [requestedProfileId]
            : [];
        }
        if (!pluginHarnessOwnsTransport) {
          return [];
        }
        const runtimeAuthPlan = buildAgentRuntimeAuthPlan({
          provider,
          config: params.config,
          workspaceDir: resolvedWorkspace,
          harnessId: agentHarness.id,
          harnessRuntime: agentHarness.id,
          allowHarnessAuthProfileForwarding: true,
        });
        const harnessAuthProvider = runtimeAuthPlan.harnessAuthProvider;
        if (!harnessAuthProvider) {
          return [];
        }
        const resolvedOrder = resolveAuthProfileOrder({
          cfg: params.config,
          store: attemptAuthProfileStore,
          provider: harnessAuthProvider,
        }).filter(isForwardablePluginHarnessAuthProfile);
        if (resolvedOrder.length > 0) {
          return resolvedOrder;
        }
        if (requestedProfileId && isForwardablePluginHarnessAuthProfile(requestedProfileId)) {
          return [requestedProfileId];
        }
        return [];
      };
      const pluginHarnessProfileOrder = pluginHarnessOwnsTransport
        ? resolvePluginHarnessProfileOrder()
        : [];
      const resolvePluginHarnessPreferredProfileId = (): string | undefined =>
        pluginHarnessProfileOrder[0];
      const preferredProfileId = pluginHarnessOwnsTransport
        ? resolvePluginHarnessPreferredProfileId()
        : requestedProfileId;
      let lockedProfileId = requestedProfileIsUserLocked ? preferredProfileId : undefined;
      if (lockedProfileId) {
        if (pluginHarnessOwnsTransport) {
          if (!isForwardablePluginHarnessAuthProfile(lockedProfileId)) {
            lockedProfileId = undefined;
          }
        } else {
          const lockedProfile = authStore.profiles[lockedProfileId];
          const lockedProfileProvider = lockedProfile
            ? resolveProviderIdForAuth(lockedProfile.provider, {
                config: params.config,
                workspaceDir: resolvedWorkspace,
              })
            : undefined;
          const runProvider = resolveProviderIdForAuth(provider, {
            config: params.config,
            workspaceDir: resolvedWorkspace,
          });
          if (!lockedProfile || !lockedProfileProvider || lockedProfileProvider !== runProvider) {
            lockedProfileId = undefined;
          }
        }
      }
      const forwardedPluginHarnessProfileId =
        pluginHarnessOwnsTransport &&
        !lockedProfileId &&
        isForwardablePluginHarnessAuthProfile(preferredProfileId)
          ? preferredProfileId
          : undefined;
      if (lockedProfileId && !pluginHarnessOwnsTransport) {
        const eligibility = resolveAuthProfileEligibility({
          cfg: params.config,
          store: authStore,
          provider,
          profileId: lockedProfileId,
        });
        if (!eligibility.eligible) {
          throw new Error(`Auth profile "${lockedProfileId}" is not configured for ${provider}.`);
        }
      }
      const profileOrder = shouldPreferExplicitConfigApiKeyAuth(params.config, provider)
        ? []
        : [
            ...new Set(
              listOpenAIAuthProfileProvidersForAgentRuntime({
                provider,
                harnessRuntime: agentHarness.id,
                agentHarnessId: agentHarness.id,
                config: params.config,
              }).flatMap((authProvider) =>
                resolveAuthProfileOrder({
                  cfg: params.config,
                  store: authStore,
                  provider: authProvider,
                  preferredProfile: preferredProfileId,
                }),
              ),
            ),
          ];
      const providerPreferredProfileId = lockedProfileId
        ? undefined
        : resolveProviderAuthProfileId({
            provider,
            config: params.config,
            workspaceDir: resolvedWorkspace,
            context: {
              config: params.config,
              agentDir,
              workspaceDir: resolvedWorkspace,
              provider,
              modelId,
              preferredProfileId,
              lockedProfileId,
              profileOrder,
              authStore,
            },
          });
      const providerOrderedProfiles =
        providerPreferredProfileId && profileOrder.includes(providerPreferredProfileId)
          ? [
              providerPreferredProfileId,
              ...profileOrder.filter((profileId) => profileId !== providerPreferredProfileId),
            ]
          : profileOrder;
      const profileCandidates = pluginHarnessOwnsTransport
        ? lockedProfileId
          ? [lockedProfileId]
          : pluginHarnessProfileOrder.length > 0
            ? pluginHarnessProfileOrder
            : [undefined]
        : lockedProfileId
          ? [lockedProfileId]
          : providerOrderedProfiles.length > 0
            ? providerOrderedProfiles
            : [undefined];
      const pluginHarnessForwardedProfileCandidates = pluginHarnessOwnsTransport
        ? profileCandidates.filter(isForwardablePluginHarnessAuthProfile)
        : [];
      const profileFailureStore = pluginHarnessOwnsTransport ? attemptAuthProfileStore : authStore;
      let profileIndex = 0;
      const traceAttempts: TraceAttempt[] = [];

      const initialThinkLevel = params.thinkLevel ?? "off";
      let thinkLevel = initialThinkLevel;
      const attemptedThinking = new Set<ThinkLevel>();
      let apiKeyInfo: ApiKeyInfo | null = null;
      let lastProfileId: string | undefined;
      let runtimeAuthState: RuntimeAuthState | null = null;
      let runtimeAuthRefreshCancelled = false;
      const {
        advanceAuthProfile,
        initializeAuthProfile,
        maybeRefreshRuntimeAuthForAuthError,
        stopRuntimeAuthRefreshTimer,
      } = createEmbeddedRunAuthController({
        config: params.config,
        agentDir,
        workspaceDir: resolvedWorkspace,
        authStore,
        authStorage,
        profileCandidates,
        lockedProfileId,
        initialThinkLevel,
        attemptedThinking,
        fallbackConfigured,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe === true,
        getProvider: () => provider,
        getModelId: () => modelId,
        getRuntimeModel: () => runtimeModel,
        setRuntimeModel: (next) => {
          runtimeModel = next;
        },
        getEffectiveModel: () => effectiveModel,
        setEffectiveModel: (next) => {
          effectiveModel = next;
        },
        getApiKeyInfo: () => apiKeyInfo,
        setApiKeyInfo: (next) => {
          apiKeyInfo = next;
        },
        getLastProfileId: () => lastProfileId,
        setLastProfileId: (next) => {
          lastProfileId = next;
        },
        getRuntimeAuthState: () => runtimeAuthState,
        setRuntimeAuthState: (next) => {
          runtimeAuthState = next;
        },
        getRuntimeAuthRefreshCancelled: () => runtimeAuthRefreshCancelled,
        setRuntimeAuthRefreshCancelled: (next) => {
          runtimeAuthRefreshCancelled = next;
        },
        getProfileIndex: () => profileIndex,
        setProfileIndex: (next) => {
          profileIndex = next;
        },
        setThinkLevel: (next) => {
          thinkLevel = next;
        },
        log,
      });
      const advancePluginHarnessAuthProfile = async (): Promise<boolean> => {
        if (!pluginHarnessOwnsTransport || lockedProfileId) {
          return false;
        }
        let nextIndex = profileIndex + 1;
        while (nextIndex < profileCandidates.length) {
          const candidate = profileCandidates[nextIndex];
          if (!candidate || !isForwardablePluginHarnessAuthProfile(candidate)) {
            nextIndex += 1;
            continue;
          }
          if (isProfileInCooldown(attemptAuthProfileStore, candidate, undefined, modelId)) {
            nextIndex += 1;
            continue;
          }
          profileIndex = nextIndex;
          lastProfileId = candidate;
          thinkLevel = initialThinkLevel;
          attemptedThinking.clear();
          return true;
        }
        return false;
      };
      const advanceAttemptAuthProfile =
        pluginHarnessOwnsTransport && !pluginHarnessNeedsOpenClawAuthBootstrap
          ? advancePluginHarnessAuthProfile
          : advanceAuthProfile;

      // Plugin harnesses own their model transport/auth. Running PI's generic
      // auth bootstrap here can turn synthetic provider markers into real
      // vendor-token refresh attempts before the plugin gets control.
      if (!pluginHarnessOwnsTransport || pluginHarnessNeedsOpenClawAuthBootstrap) {
        await initializeAuthProfile();
      } else if (lockedProfileId) {
        lastProfileId = lockedProfileId;
      } else if (forwardedPluginHarnessProfileId) {
        lastProfileId = forwardedPluginHarnessProfileId;
      }
      startupStages.mark("auth");
      notifyExecutionPhase("auth", { provider, model: modelId });
      const runAttemptAuthProfileStore = pluginHarnessOwnsTransport
        ? createScopedAuthProfileStore(
            attemptAuthProfileStore,
            pluginHarnessForwardedProfileCandidates.length > 0
              ? pluginHarnessForwardedProfileCandidates
              : lastProfileId,
          )
        : attemptAuthProfileStore;
      const { sessionAgentId } = resolveSessionAgentIds({
        sessionKey: params.sessionKey,
        config: params.config,
        agentId: params.agentId,
      });
      const configuredExecutionContract = resolveAgentExecutionContract(
        params.config,
        sessionAgentId,
      );
      const toolIntentGuardrailConfig = resolveToolIntentGuardrailConfig(
        params.config,
        sessionAgentId,
      );
      const strictAgenticActive = isStrictAgenticExecutionContractActive({
        config: params.config,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        provider,
        modelId,
      });
      const executionContract = strictAgenticActive ? "strict-agentic" : "default";
      const configuredExecutionContractForLog = configuredExecutionContract ?? "unspecified";
      const maxPlanningOnlyRetryAttempts = resolvePlanningOnlyRetryLimit(executionContract);
      const maxReasoningOnlyRetryAttempts = DEFAULT_REASONING_ONLY_RETRY_LIMIT;
      const maxEmptyResponseRetryAttempts = DEFAULT_EMPTY_RESPONSE_RETRY_LIMIT;

      const MAX_TIMEOUT_COMPACTION_ATTEMPTS = 2;
      const MAX_OVERFLOW_COMPACTION_ATTEMPTS = 3;
      const MAX_RUN_LOOP_ITERATIONS = resolveMaxRunRetryIterations(
        profileCandidates.length,
        params.config,
        sessionAgentId,
      );
      let overflowCompactionAttempts = 0;
      let toolResultTruncationAttempted = false;
      let bootstrapPromptWarningSignaturesSeen =
        params.bootstrapPromptWarningSignaturesSeen ??
        (params.bootstrapPromptWarningSignature ? [params.bootstrapPromptWarningSignature] : []);
      const usageAccumulator = createUsageAccumulator();
      let lastRunPromptUsage: ReturnType<typeof normalizeUsage> | undefined;
      let autoCompactionCount = 0;
      let lastCompactionTokensAfter: number | undefined;
      let runLoopIterations = 0;
      let overloadProfileRotations = 0;
      let planningOnlyRetryAttempts = 0;
      let reasoningOnlyRetryAttempts = 0;
      let emptyResponseRetryAttempts = 0;
      let toolIntentGuardrailRetryAttempts = 0;
      let toolIntentGuardrailSawToolProgressAfterRetry = false;
      const toolIntentGuardrailExplicitFinalizationMode = looksLikeFinalizationRequest(
        params.prompt,
        toolIntentGuardrailConfig.maxTextChars,
      );
      let toolIntentGuardrailFinalizationMode = toolIntentGuardrailExplicitFinalizationMode;
      let compactionContinuationRetryAttempts = 0;
      let sameModelIdleTimeoutRetries = 0;
      // Cost-runaway breaker for #76293. State lives at the run-loop level
      // on purpose so it survives across attempt boundaries and across
      // profile/auth retries within this embedded run (a wrapper-local
      // counter would reset on every iteration). The helper is pure and
      // unit-tested in run/idle-timeout-breaker.test.ts; the run loop just
      // feeds it the outcome of each attempt.
      const idleTimeoutBreakerState = createIdleTimeoutBreakerState();
      // Post-compaction loop guard for #77474. Armed at each compaction-success
      // site below; observed from the live tool-outcome path so it can abort
      // while the post-compaction prompt is still running.
      const resolvedLoopDetectionConfig = resolveToolLoopDetectionConfig({
        cfg: params.config,
        agentId: sessionAgentId,
      });
      const postCompactionGuard = createPostCompactionLoopGuard(
        resolvedLoopDetectionConfig?.postCompactionGuard,
        { enabled: resolvedLoopDetectionConfig?.enabled !== false },
      );
      let postCompactionAbortController: AbortController | undefined;
      let postCompactionAbortError: PostCompactionLoopPersistedError | undefined;
      const observePostCompactionToolOutcome = (
        observation: PostCompactionGuardObservation,
      ): void => {
        const verdict = postCompactionGuard.observe(observation);
        if (verdict.shouldAbort) {
          postCompactionAbortError ??= PostCompactionLoopPersistedError.fromVerdict(verdict);
          postCompactionAbortController?.abort(postCompactionAbortError);
        }
      };
      let lastRetryFailoverReason: FailoverReason | null = null;
      let planningOnlyRetryInstruction: string | null = null;
      let reasoningOnlyRetryInstruction: string | null = null;
      let emptyResponseRetryInstruction: string | null = null;
      let toolIntentGuardrailRetryInstruction: string | null = null;
      let plannedExecutionRetryInstruction: string | null = null;
      let nonAnswerRetryInstruction: string | null = null;
      let compactionContinuationRetryInstruction: string | null = null;
      let nextAttemptPromptOverride: string | null = null;
      const ackExecutionFastPathInstruction = resolveAckExecutionFastPathInstruction({
        provider,
        modelId,
        prompt: params.prompt,
      });
      let rateLimitProfileRotations = 0;
      let timeoutCompactionAttempts = 0;
      let codexAppServerClientCloseRetries = 0;
      // Silent-error retry: non-strict-agentic models (e.g. ollama/glm-5.1) can
      // end a turn with stopReason="error" + zero output tokens, producing no
      // user-visible text. This is an orthogonal, model-agnostic resubmission
      // for errored turns; stopReason="stop" empty zero-token turns use the
      // visible-answer retry instruction instead.
      const MAX_EMPTY_ERROR_RETRIES = 3;
      let emptyErrorRetries = 0;
      const MAX_NON_ANSWER_RETRIES = 1;
      let nonAnswerRetries = 0;
      const MAX_PLANNED_EXECUTION_RECOVERY_RETRIES = 1;
      let plannedExecutionRecoveryAttempts = 0;
      const MAX_PLANNED_EXECUTION_SEND_RECOVERY_RETRIES = 1;
      let plannedExecutionSendRecoveryAttempts = 0;
      const overloadFailoverBackoffMs = resolveOverloadFailoverBackoffMs(params.config);
      const overloadProfileRotationLimit = resolveOverloadProfileRotationLimit(params.config);
      const rateLimitProfileRotationLimit = resolveRateLimitProfileRotationLimit(params.config);
      let activeSessionId = params.sessionId;
      let activeSessionFile = params.sessionFile;
      let suppressNextUserMessagePersistence = params.suppressNextUserMessagePersistence ?? false;
      // Pi owns JSONL persistence; this marker only lets the outer retry avoid
      // replaying the same inbound channel message after overflow compaction.
      let lastPersistedCurrentMessageId: string | number | undefined;
      const onUserMessagePersisted: RunEmbeddedPiAgentParams["onUserMessagePersisted"] = (
        message,
      ) => {
        if (params.currentMessageId !== undefined) {
          lastPersistedCurrentMessageId = params.currentMessageId;
        }
        params.onUserMessagePersisted?.(message);
      };
      const continueFromCurrentTranscript = () => {
        nextAttemptPromptOverride = MID_TURN_PRECHECK_CONTINUATION_PROMPT;
        suppressNextUserMessagePersistence = true;
      };
      const maybeEscalateRateLimitProfileFallback = (params: {
        failoverProvider: string;
        failoverModel: string;
        logFallbackDecision: (decision: "fallback_model", extra?: { status?: number }) => void;
      }) => {
        rateLimitProfileRotations += 1;
        if (rateLimitProfileRotations <= rateLimitProfileRotationLimit || !fallbackConfigured) {
          return;
        }
        const status = resolveFailoverStatus("rate_limit");
        log.warn(
          `rate-limit profile rotation cap reached for ${sanitizeForLog(provider)}/${sanitizeForLog(modelId)} after ${rateLimitProfileRotations} rotations; escalating to model fallback`,
        );
        params.logFallbackDecision("fallback_model", { status });
        throw new FailoverError(
          "The AI service is temporarily rate-limited. Please try again in a moment.",
          {
            reason: "rate_limit",
            provider: params.failoverProvider,
            model: params.failoverModel,
            profileId: lastProfileId,
            sessionId: activeSessionId,
            lane: globalLane,
            status,
          },
        );
      };
      const maybeMarkAuthProfileFailure = async (failure: {
        profileId?: string;
        reason?: AuthProfileFailureReason | null;
        config?: RunEmbeddedPiAgentParams["config"];
        agentDir?: RunEmbeddedPiAgentParams["agentDir"];
        modelId?: string;
      }) => {
        const { profileId, reason } = failure;
        if (!profileId || !reason) {
          return;
        }
        await markAuthProfileFailure({
          store: profileFailureStore,
          profileId,
          reason,
          cfg: params.config,
          agentDir,
          runId: params.runId,
          modelId: failure.modelId,
        });
      };
      const resolveRunAuthProfileFailureReason = (
        failoverReason: FailoverReason | null,
        opts?: { providerStarted?: boolean },
      ) =>
        resolveAuthProfileFailureReason({
          failoverReason,
          providerStarted: opts?.providerStarted,
          policy: params.authProfileFailurePolicy,
        });
      const maybeBackoffBeforeOverloadFailover = async (reason: FailoverReason | null) => {
        if (reason !== "overloaded" || overloadFailoverBackoffMs <= 0) {
          return;
        }
        log.warn(
          `overload backoff before failover for ${provider}/${modelId}: delayMs=${overloadFailoverBackoffMs}`,
        );
        try {
          await sleepWithAbort(overloadFailoverBackoffMs, params.abortSignal);
        } catch (err) {
          if (params.abortSignal?.aborted) {
            const abortErr = new Error("Operation aborted", { cause: err });
            abortErr.name = "AbortError";
            throw abortErr;
          }
          throw err;
        }
      };
      // Resolve the context engine once and reuse across retries to avoid
      // repeated initialization/connection overhead per attempt.
      ensureContextEnginesInitialized();
      const contextEngine = await resolveContextEngine(params.config, {
        agentDir,
        workspaceDir: resolvedWorkspace,
      });
      const contextEnginePluginId = resolveContextEngineOwnerPluginId(contextEngine);
      startupStages.mark("context-engine");
      notifyExecutionPhase("context_engine", { provider, model: modelId });
      try {
        const resolveActiveHookContext = () => ({
          ...hookCtx,
          sessionId: activeSessionId,
        });
        const adoptCompactionTranscript = (
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
        ) => {
          const nextSessionId = compactResult.result?.sessionId;
          const nextSessionFile = compactResult.result?.sessionFile;
          if (nextSessionId && nextSessionId !== activeSessionId) {
            activeSessionId = nextSessionId;
          }
          if (nextSessionFile && nextSessionFile !== activeSessionFile) {
            activeSessionFile = nextSessionFile;
          }
        };
        const onCompactionHookMessages = async (payload: {
          phase: "before" | "after";
          messages: string[];
        }) => {
          const messages = payload.messages.filter((message) => message.trim().length > 0);
          if (messages.length === 0) {
            return;
          }
          await params.onAgentEvent?.({
            stream: "compaction",
            data: {
              phase: payload.phase === "before" ? "start" : "end",
              ...(payload.phase === "after" ? { completed: true } : {}),
              messages,
            },
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          });
        };
        // When the engine owns compaction, compactEmbeddedPiSessionDirect is
        // bypassed. Fire lifecycle hooks here so recovery paths still notify
        // subscribers like memory extensions and usage trackers.
        const runOwnsCompactionBeforeHook = async (reason: string) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !hookRunner?.hasHooks("before_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runBeforeCompaction(
              { messageCount: -1, sessionFile: activeSessionFile },
              resolveActiveHookContext(),
            );
          } catch (hookErr) {
            log.warn(`before_compaction hook failed during ${reason}: ${String(hookErr)}`);
          }
        };
        const runOwnsCompactionAfterHook = async (
          reason: string,
          compactResult: Awaited<ReturnType<typeof contextEngine.compact>>,
        ) => {
          if (
            contextEngine.info.ownsCompaction !== true ||
            !compactResult.ok ||
            !compactResult.compacted ||
            !hookRunner?.hasHooks("after_compaction")
          ) {
            return;
          }
          try {
            await hookRunner.runAfterCompaction(
              {
                messageCount: -1,
                compactedCount: -1,
                tokenCount: compactResult.result?.tokensAfter,
                sessionFile: compactResult.result?.sessionFile ?? activeSessionFile,
              },
              resolveActiveHookContext(),
            );
          } catch (hookErr) {
            log.warn(`after_compaction hook failed during ${reason}: ${String(hookErr)}`);
          }
        };
        let authRetryPending = false;
        let accumulatedReplayState = createEmbeddedRunReplayState();
        // Hoisted so the retry-limit error path can use the most recent API total.
        let lastTurnTotal: number | undefined;
        while (true) {
          if (runLoopIterations >= MAX_RUN_LOOP_ITERATIONS) {
            const message =
              `Exceeded retry limit after ${runLoopIterations} attempts ` +
              `(max=${MAX_RUN_LOOP_ITERATIONS}).`;
            log.error(
              `[run-retry-limit] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} attempts=${runLoopIterations} ` +
                `maxAttempts=${MAX_RUN_LOOP_ITERATIONS}`,
            );
            const retryLimitDecision = resolveRunFailoverDecision({
              stage: "retry_limit",
              fallbackConfigured,
              failoverReason: lastRetryFailoverReason,
            });
            return handleRetryLimitExhaustion({
              message,
              decision: retryLimitDecision,
              provider,
              model: modelId,
              profileId: lastProfileId,
              durationMs: Date.now() - started,
              agentMeta: buildErrorAgentMeta({
                sessionId: activeSessionId,
                sessionFile: activeSessionFile,
                provider,
                model: model.id,
                contextTokens: ctxInfo.tokens,
                usageAccumulator,
                lastRunPromptUsage,
                lastTurnTotal,
              }),
              replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
              livenessState: "blocked",
            });
          }
          runLoopIterations += 1;
          const runtimeAuthRetry = authRetryPending;
          authRetryPending = false;
          attemptedThinking.add(thinkLevel);
          await fs.mkdir(resolvedWorkspace, { recursive: true });
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.workspace);
          }

          const basePrompt =
            nextAttemptPromptOverride ??
            (provider === "anthropic" ? scrubAnthropicRefusalMagic(params.prompt) : params.prompt);
          nextAttemptPromptOverride = null;
          const responseModeProtocolInstruction =
            toolIntentGuardrailExplicitFinalizationMode &&
            toolIntentGuardrailConfig.detectors.includes("structuredIntent") &&
            isToolIntentGuardrailEnabledForModel({
              config: toolIntentGuardrailConfig,
              provider,
              modelId,
            })
              ? RESPONSE_MODE_PROTOCOL_INSTRUCTION
              : null;
          const promptAdditions = [
            responseModeProtocolInstruction,
            ackExecutionFastPathInstruction,
            planningOnlyRetryInstruction,
            reasoningOnlyRetryInstruction,
            emptyResponseRetryInstruction,
            plannedExecutionRetryInstruction,
            toolIntentGuardrailRetryInstruction,
            nonAnswerRetryInstruction,
            compactionContinuationRetryInstruction,
          ].filter(
            (value): value is string => typeof value === "string" && value.trim().length > 0,
          );
          const prompt =
            promptAdditions.length > 0
              ? `${basePrompt}\n\n${promptAdditions.join("\n\n")}`
              : basePrompt;
          const resolvedStreamApiKey = resolveAttemptDispatchApiKey({
            apiKeyInfo,
            runtimeAuthState,
          });
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.prompt);
          }
          const runtimePlan = buildAgentRuntimePlan({
            provider,
            modelId,
            model: effectiveModel,
            modelApi: effectiveModel.api,
            harnessId: agentHarness.id,
            harnessRuntime: agentHarness.id,
            allowHarnessAuthProfileForwarding: pluginHarnessOwnsTransport,
            authProfileProvider:
              (lastProfileId
                ? attemptAuthProfileStore.profiles?.[lastProfileId]?.provider
                : undefined) ?? lastProfileId?.split(":", 1)[0],
            authProfileMode: lastProfileId
              ? attemptAuthProfileStore.profiles?.[lastProfileId]?.type
              : undefined,
            sessionAuthProfileId: lastProfileId,
            sessionAuthProfileCandidateIds: pluginHarnessOwnsTransport
              ? pluginHarnessForwardedProfileCandidates
              : undefined,
            config: params.config,
            workspaceDir: resolvedWorkspace,
            agentDir,
            agentId: workspaceResolution.agentId,
            thinkingLevel: thinkLevel,
            extraParamsOverride: {
              ...params.streamParams,
              fastMode: params.fastMode,
            },
          });
          if (!startupStagesEmitted) {
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.runtimePlan);
            startupStages.mark(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
            notifyExecutionPhase("attempt_dispatch", { provider, model: modelId });
            emitStartupStageSummary(EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE.dispatch);
            startupStagesEmitted = true;
          }

          const attemptAbortController = new AbortController();
          postCompactionAbortController = attemptAbortController;
          const parentAbortSignal = params.abortSignal;
          const relayParentAbort = (): void => {
            attemptAbortController.abort(parentAbortSignal?.reason);
          };
          if (parentAbortSignal?.aborted) {
            relayParentAbort();
          } else {
            parentAbortSignal?.addEventListener("abort", relayParentAbort, { once: true });
          }
          const rawAttempt = await runEmbeddedAttemptWithBackend({
            sessionId: activeSessionId,
            sessionKey: resolvedSessionKey,
            sandboxSessionKey: params.sandboxSessionKey,
            trigger: params.trigger,
            memoryFlushWritePath: params.memoryFlushWritePath,
            messageChannel: params.messageChannel,
            messageProvider: params.messageProvider,
            agentAccountId: params.agentAccountId,
            messageTo: params.messageTo,
            messageThreadId: params.messageThreadId,
            groupId: params.groupId,
            groupChannel: params.groupChannel,
            groupSpace: params.groupSpace,
            memberRoleIds: params.memberRoleIds,
            spawnedBy: params.spawnedBy,
            isCanonicalWorkspace,
            senderId: params.senderId,
            senderName: params.senderName,
            senderUsername: params.senderUsername,
            senderE164: params.senderE164,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            replyToMode: params.replyToMode,
            hasRepliedRef: params.hasRepliedRef,
            sessionFile: activeSessionFile,
            workspaceDir: resolvedWorkspace,
            agentDir,
            config: params.config,
            allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
            contextEngine,
            contextTokenBudget: ctxInfo.tokens,
            contextWindowInfo: ctxInfo,
            skillsSnapshot: params.skillsSnapshot,
            prompt,
            transcriptPrompt: params.transcriptPrompt,
            currentInboundEventKind: params.currentInboundEventKind,
            currentInboundContext: params.currentInboundContext,
            images: params.images,
            imageOrder: params.imageOrder,
            clientTools: params.clientTools,
            disableTools: params.disableTools,
            provider,
            modelId,
            // Use the harness selected before model/auth setup for the actual
            // attempt too. Otherwise plugin-owned transports can skip PI auth
            // bootstrap but drift back to PI when the attempt is created.
            agentHarnessId: agentHarness.id,
            ...(params.sessionKey
              ? {
                  agentHarnessTaskRuntimeScope: createAgentHarnessTaskRuntimeScope({
                    requesterSessionKey: params.sessionKey,
                  }),
                }
              : {}),
            runtimePlan,
            model: applyAuthHeaderOverride(
              applyLocalNoAuthHeaderOverride(effectiveModel, apiKeyInfo),
              // When runtime auth exchange produced a different credential
              // (runtimeAuthState is set), the exchanged token lives in
              // authStorage and the SDK will pick it up automatically.
              // Skip header injection to avoid leaking the pre-exchange key.
              runtimeAuthState ? null : apiKeyInfo,
              params.config,
            ),
            resolvedApiKey: resolvedStreamApiKey,
            authProfileId: lastProfileId,
            authProfileIdSource: lockedProfileId ? "user" : "auto",
            initialReplayState: accumulatedReplayState,
            authStorage,
            authProfileStore: runAttemptAuthProfileStore,
            // Codex builds OpenClaw tools inside its harness. Keep transport
            // auth scoped while letting tool construction see plugin creds.
            toolAuthProfileStore: agentHarness.id === "codex" ? attemptAuthProfileStore : undefined,
            modelRegistry,
            agentId: workspaceResolution.agentId,
            legacyBeforeAgentStartResult,
            thinkLevel,
            onToolOutcome: observePostCompactionToolOutcome,
            onRunProgress: notifyRunProgress,
            fastMode: params.fastMode,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            toolResultFormat: resolvedToolResultFormat,
            toolProgressDetail: params.toolProgressDetail,
            execOverrides: params.execOverrides,
            bashElevated: params.bashElevated,
            timeoutMs: params.timeoutMs,
            runTimeoutOverrideMs: params.runTimeoutOverrideMs,
            runId: params.runId,
            abortSignal: attemptAbortController.signal,
            replyOperation: params.replyOperation,
            shouldEmitToolResult: params.shouldEmitToolResult,
            shouldEmitToolOutput: params.shouldEmitToolOutput,
            onPartialReply: params.onPartialReply,
            onAssistantMessageStart: params.onAssistantMessageStart,
            onBlockReply: params.onBlockReply,
            onBlockReplyFlush: params.onBlockReplyFlush,
            blockReplyBreak: params.blockReplyBreak,
            blockReplyChunking: params.blockReplyChunking,
            onReasoningStream: params.onReasoningStream,
            onReasoningEnd: params.onReasoningEnd,
            onToolResult: params.onToolResult,
            onAgentEvent: params.onAgentEvent,
            onExecutionPhase: params.onExecutionPhase,
            extraSystemPrompt: params.extraSystemPrompt,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            inputProvenance: params.inputProvenance,
            streamParams: params.streamParams,
            modelRun: params.modelRun,
            promptMode: params.promptMode,
            ownerNumbers: params.ownerNumbers,
            enforceFinalTag: params.enforceFinalTag,
            silentExpected: params.silentExpected,
            bootstrapContextMode: params.bootstrapContextMode,
            bootstrapContextRunKind: params.bootstrapContextRunKind,
            jobId: params.jobId,
            toolsAllow: params.toolsAllow,
            disableMessageTool: params.disableMessageTool,
            forceMessageTool: params.forceMessageTool,
            enableHeartbeatTool: params.enableHeartbeatTool,
            forceHeartbeatTool: params.forceHeartbeatTool,
            requireExplicitMessageTarget: params.requireExplicitMessageTarget,
            internalEvents: params.internalEvents,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature:
              bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1],
            suppressNextUserMessagePersistence,
            suppressTranscriptOnlyAssistantPersistence:
              params.suppressTranscriptOnlyAssistantPersistence,
            suppressAssistantErrorPersistence: params.suppressAssistantErrorPersistence,
            onUserMessagePersisted,
            onAssistantErrorMessagePersisted: params.onAssistantErrorMessagePersisted,
          })
            .catch((err: unknown): never => {
              throw postCompactionAbortError ?? err;
            })
            .finally(() => {
              parentAbortSignal?.removeEventListener?.("abort", relayParentAbort);
              if (postCompactionAbortController === attemptAbortController) {
                postCompactionAbortController = undefined;
              }
            });
          if (postCompactionAbortError) {
            throw postCompactionAbortError;
          }
          const attempt = normalizeEmbeddedRunAttemptResult(rawAttempt);

          const {
            aborted,
            externalAbort,
            promptError,
            promptErrorSource,
            preflightRecovery,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            sessionIdUsed,
            sessionFileUsed,
            lastAssistant: sessionLastAssistant,
            currentAttemptAssistant,
          } = attempt;
          const timedOutDuringToolExecution = attempt.timedOutDuringToolExecution ?? false;
          if (sessionIdUsed && sessionIdUsed !== activeSessionId) {
            activeSessionId = sessionIdUsed;
          }
          if (sessionFileUsed && sessionFileUsed !== activeSessionFile) {
            activeSessionFile = sessionFileUsed;
          }
          bootstrapPromptWarningSignaturesSeen =
            attempt.bootstrapPromptWarningSignaturesSeen ??
            (attempt.bootstrapPromptWarningSignature
              ? Array.from(
                  new Set([
                    ...bootstrapPromptWarningSignaturesSeen,
                    attempt.bootstrapPromptWarningSignature,
                  ]),
                )
              : bootstrapPromptWarningSignaturesSeen);
          const lastAssistantUsage = normalizeUsage(sessionLastAssistant?.usage as UsageLike);
          const attemptUsage = attempt.attemptUsage ?? lastAssistantUsage;
          mergeUsageIntoAccumulator(usageAccumulator, attemptUsage);
          // Keep prompt size from the latest model call so session totalTokens
          // reflects current context usage, not accumulated tool-loop usage.
          lastRunPromptUsage = lastAssistantUsage ?? attemptUsage;
          lastTurnTotal = lastAssistantUsage?.total ?? attemptUsage?.total;
          // Idle-timeout cost-runaway breaker (#76293). Logic lives in the
          // pure helper below so it stays unit-testable; the run loop just
          // feeds it the latest attempt outcome and bails through the
          // existing retry-limit exhaustion path when the cap is hit.
          const breakerStep = stepIdleTimeoutBreaker(idleTimeoutBreakerState, {
            idleTimedOut,
            completedModelProgress: hasCompletedModelProgressForIdleBreaker(attempt),
            outputTokens: attemptUsage?.output,
          });
          if (breakerStep.tripped) {
            const breakerMessage =
              `Idle-timeout cost-runaway breaker tripped: ` +
              `${breakerStep.consecutive} consecutive idle timeouts ` +
              `without completed model progress ` +
              `(cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}). ` +
              `Halting further attempts to bound paid model calls. ` +
              `See issue #76293.`;
            log.error(
              `[idle-timeout-circuit-breaker-tripped] ` +
                `sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} ` +
                `consecutive=${breakerStep.consecutive} ` +
                `cap=${MAX_CONSECUTIVE_IDLE_TIMEOUTS_BEFORE_OUTPUT}`,
            );
            const breakerDecision = resolveRunFailoverDecision({
              stage: "retry_limit",
              fallbackConfigured,
              failoverReason: lastRetryFailoverReason,
            });
            return handleRetryLimitExhaustion({
              message: breakerMessage,
              decision: breakerDecision,
              provider,
              model: modelId,
              profileId: lastProfileId,
              durationMs: Date.now() - started,
              agentMeta: buildErrorAgentMeta({
                sessionId: activeSessionId,
                sessionFile: activeSessionFile,
                provider,
                model: model.id,
                contextTokens: ctxInfo.tokens,
                usageAccumulator,
                lastRunPromptUsage,
                lastTurnTotal,
              }),
              replayInvalid: accumulatedReplayState.replayInvalid ? true : undefined,
              livenessState: "blocked",
            });
          }
          const attemptCompactionCount = Math.max(0, attempt.compactionCount ?? 0);
          autoCompactionCount += attemptCompactionCount;
          if (
            typeof attempt.compactionTokensAfter === "number" &&
            Number.isFinite(attempt.compactionTokensAfter) &&
            attempt.compactionTokensAfter >= 0
          ) {
            lastCompactionTokensAfter = Math.floor(attempt.compactionTokensAfter);
          }
          const activeErrorContext = resolveActiveErrorContext({
            provider,
            model: modelId,
            assistant: currentAttemptAssistant ?? sessionLastAssistant,
          });
          const resolveReplayInvalidForAttempt = (incompleteTurnText?: string | null) =>
            accumulatedReplayState.replayInvalid ||
            resolveReplayInvalidFlag({
              attempt,
              incompleteTurnText,
            });
          if (resolveReplayInvalidForAttempt(null)) {
            accumulatedReplayState.replayInvalid = true;
          }
          accumulatedReplayState = observeReplayMetadata(
            accumulatedReplayState,
            attempt.replayMetadata,
          );
          const formattedAssistantErrorText = sessionLastAssistant
            ? formatAssistantErrorText(sessionLastAssistant, {
                cfg: params.config,
                sessionKey: resolvedSessionKey ?? params.sessionId,
                provider: activeErrorContext.provider,
                model: activeErrorContext.model,
              })
            : undefined;
          const assistantErrorText =
            sessionLastAssistant?.stopReason === "error"
              ? sessionLastAssistant.errorMessage?.trim() || formattedAssistantErrorText
              : undefined;
          const canRestartForLiveSwitch =
            !hasOutboundDeliveryEvidence(attempt) &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            (attempt.toolMetas?.length ?? 0) === 0 &&
            (attempt.assistantTexts?.length ?? 0) === 0;
          if (preflightRecovery?.handled) {
            const retryingFromTranscript = preflightRecovery.source === "mid-turn";
            log.info(
              `[context-overflow-precheck] early recovery route=${preflightRecovery.route} ` +
                `completed for ${provider}/${modelId}; ` +
                (retryingFromTranscript ? "retrying from current transcript" : "retrying prompt"),
            );
            if (retryingFromTranscript) {
              continueFromCurrentTranscript();
            }
            continue;
          }
          const requestedSelection = shouldSwitchToLiveModel({
            cfg: params.config,
            sessionKey: resolvedSessionKey,
            agentId: params.agentId,
            defaultProvider: DEFAULT_PROVIDER,
            defaultModel: DEFAULT_MODEL,
            currentProvider: provider,
            currentModel: modelId,
            currentAuthProfileId: preferredProfileId,
            currentAuthProfileIdSource: params.authProfileIdSource,
          });
          if (requestedSelection && canRestartForLiveSwitch) {
            await clearLiveModelSwitchPending({
              cfg: params.config,
              sessionKey: resolvedSessionKey,
              agentId: params.agentId,
            });
            log.info(
              `live session model switch requested during active attempt for ${params.sessionId}: ${provider}/${modelId} -> ${requestedSelection.provider}/${requestedSelection.model}`,
            );
            throw new LiveSessionModelSwitchError(requestedSelection);
          }
          // ── Timeout-triggered compaction ──────────────────────────────────
          // When the LLM times out with high context usage, compact before
          // retrying to break the death spiral of repeated timeouts.
          if (timedOut && !timedOutDuringCompaction && !timedOutDuringToolExecution) {
            // Only consider prompt-side tokens here. API totals include output
            // tokens, which can make a long generation look like high context
            // pressure even when the prompt itself was small.
            const lastTurnPromptTokens = derivePromptTokens(lastRunPromptUsage);
            const tokenUsedRatio =
              lastTurnPromptTokens != null && ctxInfo.tokens > 0
                ? lastTurnPromptTokens / ctxInfo.tokens
                : 0;
            if (timeoutCompactionAttempts >= MAX_TIMEOUT_COMPACTION_ATTEMPTS) {
              log.warn(
                `[timeout-compaction] already attempted timeout compaction ${timeoutCompactionAttempts} time(s); falling through to failover rotation`,
              );
            } else if (tokenUsedRatio > 0.65) {
              const timeoutDiagId = createCompactionDiagId();
              timeoutCompactionAttempts++;
              log.warn(
                `[timeout-compaction] LLM timed out with high prompt token usage (${Math.round(tokenUsedRatio * 100)}%); ` +
                  `attempting compaction before retry (attempt ${timeoutCompactionAttempts}/${MAX_TIMEOUT_COMPACTION_ATTEMPTS}) diagId=${timeoutDiagId}`,
              );
              let timeoutCompactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("timeout recovery");
              try {
                const timeoutCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    modelFallbacksOverride: params.modelFallbacksOverride,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
                    ownerNumbers: params.ownerNumbers,
                    activeProcessSessions: listActiveProcessSessionReferences({
                      scopeKey: resolveProcessToolScopeKey({
                        sessionKey: params.sandboxSessionKey?.trim() || params.sessionKey,
                        sessionId: activeSessionId,
                        agentId: sessionAgentId,
                      }),
                    }),
                  }),
                  ...resolveContextEngineCapabilities({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    contextEnginePluginId,
                    purpose: "context-engine.timeout-compaction",
                  }),
                  onCompactionHookMessages,
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "timeout_recovery",
                  diagId: timeoutDiagId,
                  attempt: timeoutCompactionAttempts,
                  maxAttempts: MAX_TIMEOUT_COMPACTION_ATTEMPTS,
                };
                // Bound plugin-owned compaction with the same finite safety
                // timeout that protects native compaction, and thread the
                // run-level abort signal through, so a hung plugin compact()
                // cannot stall timeout recovery indefinitely. A timeout/abort
                // surfaces as a thrown error handled by the catch below.
                timeoutCompactResult = await compactContextEngineWithSafetyTimeout(
                  contextEngine,
                  {
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    tokenBudget: ctxInfo.tokens,
                    force: true,
                    compactionTarget: "budget",
                    runtimeContext: timeoutCompactionRuntimeContext,
                  },
                  resolveCompactionTimeoutMs(params.config),
                  params.abortSignal,
                );
              } catch (compactErr) {
                log.warn(
                  `[timeout-compaction] contextEngine.compact() threw during timeout recovery for ${provider}/${modelId}: ${String(compactErr)}`,
                );
                timeoutCompactResult = {
                  ok: false,
                  compacted: false,
                  reason: String(compactErr),
                };
              }
              if (timeoutCompactResult.compacted) {
                adoptCompactionTranscript(timeoutCompactResult);
              }
              await runOwnsCompactionAfterHook("timeout recovery", timeoutCompactResult);
              if (timeoutCompactResult.compacted) {
                autoCompactionCount += 1;
                if (
                  typeof timeoutCompactResult.result?.tokensAfter === "number" &&
                  Number.isFinite(timeoutCompactResult.result.tokensAfter) &&
                  timeoutCompactResult.result.tokensAfter >= 0
                ) {
                  lastCompactionTokensAfter = Math.floor(timeoutCompactResult.result.tokensAfter);
                }
                if (contextEngine.info.ownsCompaction === true) {
                  await runPostCompactionSideEffects({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                  });
                }
                log.info(
                  `[timeout-compaction] compaction succeeded for ${provider}/${modelId}; retrying prompt`,
                );
                postCompactionGuard.armPostCompaction();
                continue;
              } else {
                log.warn(
                  `[timeout-compaction] compaction did not reduce context for ${provider}/${modelId}; falling through to normal handling`,
                );
              }
            }
          }

          const contextOverflowError = !aborted
            ? (() => {
                if (promptError) {
                  const errorText = formatErrorMessage(promptError);
                  if (isLikelyContextOverflowError(errorText)) {
                    return { text: errorText, source: "promptError" as const };
                  }
                  // Prompt submission failed with a non-overflow error. Do not
                  // inspect prior assistant errors from history for this attempt.
                  return null;
                }
                if (assistantErrorText && isLikelyContextOverflowError(assistantErrorText)) {
                  return {
                    text: assistantErrorText,
                    source: "assistantError" as const,
                  };
                }
                return null;
              })()
            : null;

          if (contextOverflowError) {
            const overflowDiagId = createCompactionDiagId();
            const errorText = contextOverflowError.text;
            const msgCount = attempt.messagesSnapshot?.length ?? 0;
            const observedOverflowTokens = extractObservedOverflowTokenCount(errorText);
            log.warn(
              `[context-overflow-diag] sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `provider=${provider}/${modelId} source=${contextOverflowError.source} ` +
                `messages=${msgCount} sessionFile=${activeSessionFile} ` +
                `diagId=${overflowDiagId} compactionAttempts=${overflowCompactionAttempts} ` +
                `observedTokens=${observedOverflowTokens ?? "unknown"} ` +
                `error=${errorText.slice(0, 200)}`,
            );
            const isCompactionFailure = isCompactionFailureError(errorText);
            const hadAttemptLevelCompaction = attemptCompactionCount > 0;
            // If this attempt already compacted (SDK auto-compaction), avoid immediately
            // running another explicit compaction for the same overflow trigger.
            if (
              !isCompactionFailure &&
              hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              overflowCompactionAttempts++;
              log.warn(
                `context overflow persisted after in-attempt compaction (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); retrying prompt without additional compaction for ${provider}/${modelId}`,
              );
              if (preflightRecovery?.source === "mid-turn") {
                continueFromCurrentTranscript();
              }
              continue;
            }
            // Attempt explicit overflow compaction only when this attempt did not
            // already auto-compact.
            if (
              !isCompactionFailure &&
              !hadAttemptLevelCompaction &&
              overflowCompactionAttempts < MAX_OVERFLOW_COMPACTION_ATTEMPTS
            ) {
              if (log.isEnabled("debug")) {
                log.debug(
                  `[compaction-diag] decision diagId=${overflowDiagId} branch=compact ` +
                    `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                    `attempt=${overflowCompactionAttempts + 1} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
                );
              }
              overflowCompactionAttempts++;
              log.warn(
                `context overflow detected (attempt ${overflowCompactionAttempts}/${MAX_OVERFLOW_COMPACTION_ATTEMPTS}); attempting auto-compaction for ${provider}/${modelId}`,
              );
              let compactResult: Awaited<ReturnType<typeof contextEngine.compact>>;
              await runOwnsCompactionBeforeHook("overflow recovery");
              try {
                const overflowCompactionRuntimeContext = {
                  ...buildEmbeddedCompactionRuntimeContext({
                    sessionKey: params.sessionKey,
                    messageChannel: params.messageChannel,
                    messageProvider: params.messageProvider,
                    agentAccountId: params.agentAccountId,
                    currentChannelId: params.currentChannelId,
                    currentThreadTs: params.currentThreadTs,
                    currentMessageId: params.currentMessageId,
                    authProfileId: lastProfileId,
                    workspaceDir: resolvedWorkspace,
                    agentDir,
                    config: params.config,
                    skillsSnapshot: params.skillsSnapshot,
                    senderId: params.senderId,
                    provider,
                    modelId,
                    thinkLevel,
                    reasoningLevel: params.reasoningLevel,
                    bashElevated: params.bashElevated,
                    extraSystemPrompt: params.extraSystemPrompt,
                    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
                    ownerNumbers: params.ownerNumbers,
                    activeProcessSessions: listActiveProcessSessionReferences({
                      scopeKey: resolveProcessToolScopeKey({
                        sessionKey: params.sandboxSessionKey?.trim() || params.sessionKey,
                        sessionId: activeSessionId,
                        agentId: sessionAgentId,
                      }),
                    }),
                  }),
                  ...resolveContextEngineCapabilities({
                    config: params.config,
                    sessionKey: params.sessionKey,
                    agentId: sessionAgentId,
                    contextEnginePluginId,
                    purpose: "context-engine.overflow-compaction",
                  }),
                  onCompactionHookMessages,
                  ...(attempt.promptCache ? { promptCache: attempt.promptCache } : {}),
                  runId: params.runId,
                  trigger: "overflow",
                  ...(observedOverflowTokens !== undefined
                    ? { currentTokenCount: observedOverflowTokens }
                    : {}),
                  diagId: overflowDiagId,
                  attempt: overflowCompactionAttempts,
                  maxAttempts: MAX_OVERFLOW_COMPACTION_ATTEMPTS,
                };
                // Bound plugin-owned compaction with the same finite safety
                // timeout that protects native compaction, and thread the
                // run-level abort signal through, so a hung plugin compact()
                // cannot stall overflow recovery indefinitely. A timeout/abort
                // surfaces as a thrown error handled by the catch below.
                compactResult = await compactContextEngineWithSafetyTimeout(
                  contextEngine,
                  {
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    tokenBudget: ctxInfo.tokens,
                    ...(observedOverflowTokens !== undefined
                      ? { currentTokenCount: observedOverflowTokens }
                      : {}),
                    force: true,
                    compactionTarget: "budget",
                    runtimeContext: overflowCompactionRuntimeContext,
                  },
                  resolveCompactionTimeoutMs(params.config),
                  params.abortSignal,
                );
                if (compactResult.ok && compactResult.compacted) {
                  adoptCompactionTranscript(compactResult);
                  await runContextEngineMaintenance({
                    contextEngine,
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    sessionFile: activeSessionFile,
                    reason: "compaction",
                    runtimeContext: overflowCompactionRuntimeContext,
                    config: params.config,
                    agentId: sessionAgentId,
                  });
                }
              } catch (compactErr) {
                log.warn(
                  `contextEngine.compact() threw during overflow recovery for ${provider}/${modelId}: ${String(compactErr)}`,
                );
                compactResult = {
                  ok: false,
                  compacted: false,
                  reason: String(compactErr),
                };
              }
              await runOwnsCompactionAfterHook("overflow recovery", compactResult);
              if (compactResult.compacted) {
                adoptCompactionTranscript(compactResult);
                if (
                  typeof compactResult.result?.tokensAfter === "number" &&
                  Number.isFinite(compactResult.result.tokensAfter) &&
                  compactResult.result.tokensAfter >= 0
                ) {
                  lastCompactionTokensAfter = Math.floor(compactResult.result.tokensAfter);
                }
                if (preflightRecovery?.route === "compact_then_truncate") {
                  const truncResult = await truncateOversizedToolResultsInSession({
                    sessionFile: activeSessionFile,
                    contextWindowTokens: ctxInfo.tokens,
                    maxCharsOverride: resolveLiveToolResultMaxChars({
                      contextWindowTokens: ctxInfo.tokens,
                      cfg: params.config,
                      agentId: sessionAgentId,
                    }),
                    sessionId: activeSessionId,
                    sessionKey: params.sessionKey,
                    config: params.config,
                  });
                  if (truncResult.truncated) {
                    log.info(
                      `[context-overflow-precheck] post-compaction tool-result truncation succeeded for ` +
                        `${provider}/${modelId}; truncated ${truncResult.truncatedCount} tool result(s)`,
                    );
                  } else {
                    log.warn(
                      `[context-overflow-precheck] post-compaction tool-result truncation did not help for ` +
                        `${provider}/${modelId}: ${truncResult.reason ?? "unknown"}`,
                    );
                  }
                }
                autoCompactionCount += 1;
                log.info(`auto-compaction succeeded for ${provider}/${modelId}; retrying prompt`);
                postCompactionGuard.armPostCompaction();
                if (preflightRecovery?.source === "mid-turn") {
                  continueFromCurrentTranscript();
                } else if (
                  params.currentMessageId !== undefined &&
                  params.currentMessageId === lastPersistedCurrentMessageId
                ) {
                  // The first attempt reached Pi far enough to persist this user turn.
                  // Retrying the original prompt would replay it, so resume from the
                  // compacted transcript and suppress the next user append.
                  nextAttemptPromptOverride = MID_TURN_PRECHECK_CONTINUATION_PROMPT;
                  suppressNextUserMessagePersistence = true;
                }
                continue;
              }
              log.warn(
                `auto-compaction failed for ${provider}/${modelId}: ${compactResult.reason ?? "nothing to compact"}`,
              );
            }
            if (!toolResultTruncationAttempted) {
              const contextWindowTokens = ctxInfo.tokens;
              const toolResultMaxChars = resolveLiveToolResultMaxChars({
                contextWindowTokens,
                cfg: params.config,
                agentId: sessionAgentId,
              });
              const hasOversized = attempt.messagesSnapshot
                ? sessionLikelyHasOversizedToolResults({
                    messages: attempt.messagesSnapshot,
                    contextWindowTokens,
                    maxCharsOverride: toolResultMaxChars,
                  })
                : false;

              if (hasOversized) {
                toolResultTruncationAttempted = true;
                log.warn(
                  `[context-overflow-recovery] Attempting tool result truncation for ${provider}/${modelId} ` +
                    `(contextWindow=${contextWindowTokens} tokens)`,
                );
                const truncResult = await truncateOversizedToolResultsInSession({
                  sessionFile: activeSessionFile,
                  contextWindowTokens,
                  maxCharsOverride: toolResultMaxChars,
                  sessionId: activeSessionId,
                  sessionKey: params.sessionKey,
                  config: params.config,
                });
                if (truncResult.truncated) {
                  log.info(
                    `[context-overflow-recovery] Truncated ${truncResult.truncatedCount} tool result(s); retrying prompt`,
                  );
                  if (preflightRecovery?.source === "mid-turn") {
                    continueFromCurrentTranscript();
                  }
                  continue;
                }
                log.warn(
                  `[context-overflow-recovery] Tool result truncation did not help: ${truncResult.reason ?? "unknown"}`,
                );
              }
            }
            if (
              (isCompactionFailure ||
                overflowCompactionAttempts >= MAX_OVERFLOW_COMPACTION_ATTEMPTS) &&
              log.isEnabled("debug")
            ) {
              log.debug(
                `[compaction-diag] decision diagId=${overflowDiagId} branch=give_up ` +
                  `isCompactionFailure=${isCompactionFailure} hasOversizedToolResults=unknown ` +
                  `attempt=${overflowCompactionAttempts} maxAttempts=${MAX_OVERFLOW_COMPACTION_ATTEMPTS}`,
              );
            }
            const kind = isCompactionFailure ? "compaction_failure" : "context_overflow";
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid: resolveReplayInvalidForAttempt(),
              livenessState: "blocked",
            });
            return {
              payloads: [
                {
                  text:
                    "Context overflow: prompt too large for the model. " +
                    "Try /reset (or /new) to start a fresh session, or use a larger-context model.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  sessionFile: activeSessionFile,
                  provider,
                  model: model.id,
                  contextTokens: ctxInfo.tokens,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant: sessionLastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
                error: { kind, message: errorText },
              },
            };
          }

          if (promptErrorSource === "hook:before_agent_run" && !aborted) {
            const errorText = formatErrorMessage(promptError);
            const replayInvalid = resolveReplayInvalidForAttempt();
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState: "blocked",
            });
            return {
              payloads: [{ text: errorText, isError: true }],
              meta: {
                durationMs: Date.now() - started,
                agentMeta: buildErrorAgentMeta({
                  sessionId: sessionIdUsed,
                  sessionFile: activeSessionFile,
                  provider,
                  model: model.id,
                  contextTokens: ctxInfo.tokens,
                  usageAccumulator,
                  lastRunPromptUsage,
                  lastAssistant: sessionLastAssistant,
                  lastTurnTotal,
                }),
                systemPromptReport: attempt.systemPromptReport,
                finalAssistantVisibleText: errorText,
                finalAssistantRawText: errorText,
                finalPromptText: undefined,
                replayInvalid,
                livenessState: "blocked",
                error: { kind: "hook_block", message: errorText },
              },
            };
          }

          if (promptError && !aborted && promptErrorSource !== "compaction") {
            const codexClientCloseRetry = resolveCodexAppServerClientCloseRetry({
              attempt,
              alreadyRetried: codexAppServerClientCloseRetries > 0,
            });
            if (codexClientCloseRetry.retry) {
              codexAppServerClientCloseRetries += 1;
              suppressNextUserMessagePersistence = true;
              log.warn(
                `codex app-server stdio client closed before turn completion; retrying once ` +
                  `runId=${params.runId} sessionId=${params.sessionId}`,
              );
              continue;
            }
            if (attempt.codexAppServerFailure) {
              throw promptError;
            }
          }

          if (promptError && !aborted && promptErrorSource !== "compaction") {
            // Normalize wrapped errors (e.g. abort-wrapped RESOURCE_EXHAUSTED) into
            // FailoverError so rate-limit classification works even for nested shapes.
            //
            // promptErrorSource === "compaction" means the model call already completed and the
            // abort happened only while waiting for compaction/retry cleanup. Retrying from here
            // would replay that completed tool turn as a fresh prompt attempt.
            const normalizedPromptFailover = coerceToFailoverError(promptError, {
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              profileId: lastProfileId,
              sessionId: sessionIdUsed,
              lane: globalLane,
            });
            const promptErrorDetails = normalizedPromptFailover
              ? describeFailoverError(normalizedPromptFailover)
              : describeFailoverError(promptError);
            if (normalizedPromptFailover?.suspend) {
              void suspendSession({
                cfg: params.config,
                agentDir,
                sessionId: activeSessionId ?? params.sessionId,
                laneId: globalLane,
                reason: resolveSessionSuspensionReason(normalizedPromptFailover.reason),
                failedProvider: normalizedPromptFailover.provider ?? provider,
                failedModel: normalizedPromptFailover.model ?? modelId,
              });
            }
            const errorText = promptErrorDetails.message || formatErrorMessage(promptError);
            if (await maybeRefreshRuntimeAuthForAuthError(errorText, runtimeAuthRetry)) {
              authRetryPending = true;
              continue;
            }
            // Handle role ordering errors with a user-friendly message
            if (/incorrect role information|roles must alternate/i.test(errorText)) {
              attempt.setTerminalLifecycleMeta?.({
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
              });
              return {
                payloads: [
                  {
                    text:
                      "Message ordering conflict - please try again. " +
                      "If this persists, use /new to start a fresh session.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    sessionFile: activeSessionFile,
                    provider,
                    model: model.id,
                    contextTokens: ctxInfo.tokens,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: sessionLastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  replayInvalid: resolveReplayInvalidForAttempt(),
                  livenessState: "blocked",
                  error: { kind: "role_ordering", message: errorText },
                },
              };
            }
            // Handle image size errors with a user-friendly message (no retry needed)
            const imageSizeError = parseImageSizeError(errorText);
            if (imageSizeError) {
              const maxMb = imageSizeError.maxMb;
              const maxMbLabel =
                typeof maxMb === "number" && Number.isFinite(maxMb) ? `${maxMb}` : null;
              const maxBytesHint = maxMbLabel ? ` (max ${maxMbLabel}MB)` : "";
              attempt.setTerminalLifecycleMeta?.({
                replayInvalid: resolveReplayInvalidForAttempt(),
                livenessState: "blocked",
              });
              return {
                payloads: [
                  {
                    text:
                      `Image too large for the model${maxBytesHint}. ` +
                      "Please compress or resize the image and try again.",
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta: buildErrorAgentMeta({
                    sessionId: sessionIdUsed,
                    sessionFile: activeSessionFile,
                    provider,
                    model: model.id,
                    contextTokens: ctxInfo.tokens,
                    usageAccumulator,
                    lastRunPromptUsage,
                    lastAssistant: sessionLastAssistant,
                    lastTurnTotal,
                  }),
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  replayInvalid: resolveReplayInvalidForAttempt(),
                  livenessState: "blocked",
                  error: { kind: "image_size", message: errorText },
                },
              };
            }
            const promptFailoverReason =
              promptErrorDetails.reason ?? classifyFailoverReason(errorText, { provider });
            const promptProfileFailureReason = resolveRunAuthProfileFailureReason(
              promptFailoverReason,
              {
                providerStarted: promptErrorSource === "prompt",
              },
            );
            const promptFailoverFailure =
              promptFailoverReason !== null || isFailoverErrorMessage(errorText, { provider });
            // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
            const failedPromptProfileId = lastProfileId;
            const logPromptFailoverDecision = createFailoverDecisionLogger({
              stage: "prompt",
              runId: params.runId,
              rawError: errorText,
              failoverReason: promptFailoverReason,
              profileFailureReason: promptProfileFailureReason,
              provider,
              model: modelId,
              sourceProvider: provider,
              sourceModel: modelId,
              profileId: failedPromptProfileId,
              fallbackConfigured,
              aborted,
            });
            if (promptFailoverReason === "rate_limit") {
              maybeEscalateRateLimitProfileFallback({
                failoverProvider: provider,
                failoverModel: modelId,
                logFallbackDecision: logPromptFailoverDecision,
              });
            }
            let promptFailoverDecision = resolveRunFailoverDecision({
              stage: "prompt",
              aborted,
              externalAbort,
              fallbackConfigured,
              failoverFailure: promptFailoverFailure,
              failoverReason: promptFailoverReason,
              profileRotated: false,
            });
            if (
              promptFailoverDecision.action === "rotate_profile" &&
              (await advanceAttemptAuthProfile())
            ) {
              if (failedPromptProfileId && promptProfileFailureReason) {
                void maybeMarkAuthProfileFailure({
                  profileId: failedPromptProfileId,
                  reason: promptProfileFailureReason,
                  modelId,
                }).catch((err) => {
                  log.warn(`prompt profile failure mark failed: ${String(err)}`);
                });
              }
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "rotate_profile",
                ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
                stage: "prompt",
              });
              lastRetryFailoverReason = mergeRetryFailoverReason({
                previous: lastRetryFailoverReason,
                failoverReason: promptFailoverReason,
              });
              logPromptFailoverDecision("rotate_profile");
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              continue;
            }
            if (promptFailoverDecision.action === "rotate_profile") {
              promptFailoverDecision = resolveRunFailoverDecision({
                stage: "prompt",
                aborted,
                externalAbort,
                fallbackConfigured,
                failoverFailure: promptFailoverFailure,
                failoverReason: promptFailoverReason,
                profileRotated: true,
              });
            }
            if (failedPromptProfileId && promptProfileFailureReason) {
              try {
                await maybeMarkAuthProfileFailure({
                  profileId: failedPromptProfileId,
                  reason: promptProfileFailureReason,
                  modelId,
                });
              } catch (err) {
                log.warn(`prompt profile failure mark failed: ${String(err)}`);
              }
            }
            const fallbackThinking = pickFallbackThinkingLevel({
              message: errorText,
              attempted: attemptedThinking,
            });
            if (fallbackThinking) {
              log.warn(
                `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
              );
              thinkLevel = fallbackThinking;
              continue;
            }
            // Throw FailoverError for prompt-side failover reasons when fallbacks
            // are configured so outer model fallback can continue on overload,
            // rate-limit, auth, or billing failures.
            if (promptFailoverDecision.action === "fallback_model") {
              const fallbackReason = promptFailoverDecision.reason ?? "unknown";
              const status = resolveFailoverStatus(fallbackReason);
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "fallback_model",
                reason: fallbackReason,
                stage: "prompt",
                ...(typeof status === "number" ? { status } : {}),
              });
              logPromptFailoverDecision("fallback_model", { status });
              await maybeBackoffBeforeOverloadFailover(promptFailoverReason);
              throw (
                normalizedPromptFailover ??
                new FailoverError(errorText, {
                  reason: fallbackReason,
                  provider,
                  model: modelId,
                  profileId: lastProfileId,
                  sessionId: sessionIdUsed,
                  lane: globalLane,
                  status,
                })
              );
            }
            if (promptFailoverDecision.action === "surface_error") {
              traceAttempts.push({
                provider,
                model: modelId,
                result: promptFailoverReason === "timeout" ? "timeout" : "surface_error",
                ...(promptFailoverReason ? { reason: promptFailoverReason } : {}),
                stage: "prompt",
              });
              logPromptFailoverDecision("surface_error");
            }
            throw promptError;
          }

          const assistantForFailover = currentAttemptAssistant ?? sessionLastAssistant;
          const fallbackThinking = pickFallbackThinkingLevel({
            message: assistantForFailover?.errorMessage,
            attempted: attemptedThinking,
          });
          if (fallbackThinking && !aborted) {
            log.warn(
              `unsupported thinking level for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }

          const authFailure = isAuthAssistantError(assistantForFailover);
          const rateLimitFailure = isRateLimitAssistantError(assistantForFailover);
          const billingFailure = isBillingAssistantError(assistantForFailover);
          const failoverFailure = isFailoverAssistantError(assistantForFailover);
          const assistantFailoverReason = classifyFailoverReason(
            assistantForFailover?.errorMessage ?? "",
            {
              provider: assistantForFailover?.provider,
            },
          );
          const assistantProviderStarted =
            Boolean(currentAttemptAssistant?.provider) ||
            idleTimedOut ||
            (timedOut && !timedOutDuringCompaction && !timedOutDuringToolExecution);
          const assistantProfileFailoverReason =
            assistantFailoverReason ??
            (assistantProviderStarted && (timedOut || idleTimedOut) ? "timeout" : null);
          const assistantProfileFailureReason = resolveRunAuthProfileFailureReason(
            assistantProfileFailoverReason,
            {
              providerStarted: assistantProviderStarted,
            },
          );
          const cloudCodeAssistFormatError = attempt.cloudCodeAssistFormatError;
          const imageDimensionError = parseImageDimensionError(
            assistantForFailover?.errorMessage ?? "",
          );
          // Capture the failing profile before auth-profile rotation mutates `lastProfileId`.
          const failedAssistantProfileId = lastProfileId;
          const logAssistantFailoverDecision = createFailoverDecisionLogger({
            stage: "assistant",
            runId: params.runId,
            rawError: assistantForFailover?.errorMessage?.trim(),
            failoverReason: assistantFailoverReason,
            profileFailureReason: assistantProfileFailureReason,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            sourceProvider: assistantForFailover?.provider ?? provider,
            sourceModel: assistantForFailover?.model ?? modelId,
            profileId: failedAssistantProfileId,
            fallbackConfigured,
            timedOut,
            aborted,
          });

          if (
            authFailure &&
            (await maybeRefreshRuntimeAuthForAuthError(
              assistantForFailover?.errorMessage ?? "",
              runtimeAuthRetry,
            ))
          ) {
            authRetryPending = true;
            continue;
          }
          if (imageDimensionError && lastProfileId) {
            const details = [
              imageDimensionError.messageIndex !== undefined
                ? `message=${imageDimensionError.messageIndex}`
                : null,
              imageDimensionError.contentIndex !== undefined
                ? `content=${imageDimensionError.contentIndex}`
                : null,
              imageDimensionError.maxDimensionPx !== undefined
                ? `limit=${imageDimensionError.maxDimensionPx}px`
                : null,
            ]
              .filter(Boolean)
              .join(" ");
            log.warn(
              `Profile ${lastProfileId} rejected image payload${details ? ` (${details})` : ""}.`,
            );
          }

          const assistantFailoverDecision = resolveRunFailoverDecision({
            stage: "assistant",
            allowFormatRetry: cloudCodeAssistFormatError,
            aborted,
            externalAbort,
            fallbackConfigured,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            timedOutDuringToolExecution,
            profileRotated: false,
          });
          const assistantFailoverOutcome = await handleAssistantFailover({
            initialDecision: assistantFailoverDecision,
            aborted,
            externalAbort,
            fallbackConfigured,
            failoverFailure,
            failoverReason: assistantFailoverReason,
            timedOut,
            idleTimedOut,
            timedOutDuringCompaction,
            timedOutDuringToolExecution,
            allowSameModelIdleTimeoutRetry:
              timedOut &&
              idleTimedOut &&
              !timedOutDuringCompaction &&
              !fallbackConfigured &&
              canRestartForLiveSwitch &&
              sameModelIdleTimeoutRetries < MAX_SAME_MODEL_IDLE_TIMEOUT_RETRIES,
            assistantProfileFailureReason,
            lastProfileId,
            modelId,
            provider,
            activeErrorContext,
            lastAssistant: assistantForFailover,
            config: params.config,
            sessionKey: params.sessionKey ?? params.sessionId,
            authFailure,
            rateLimitFailure,
            billingFailure,
            cloudCodeAssistFormatError,
            isProbeSession,
            overloadProfileRotations,
            overloadProfileRotationLimit,
            previousRetryFailoverReason: lastRetryFailoverReason,
            logAssistantFailoverDecision,
            warn: (message) => log.warn(message),
            maybeMarkAuthProfileFailure,
            maybeEscalateRateLimitProfileFallback,
            maybeBackoffBeforeOverloadFailover,
            advanceAuthProfile: advanceAttemptAuthProfile,
          });
          overloadProfileRotations = assistantFailoverOutcome.overloadProfileRotations;
          if (assistantFailoverOutcome.action === "retry") {
            traceAttempts.push({
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              result:
                assistantFailoverOutcome.retryKind === "same_model_idle_timeout" ||
                assistantFailoverReason === "timeout"
                  ? "timeout"
                  : "rotate_profile",
              ...(assistantFailoverReason ? { reason: assistantFailoverReason } : {}),
              stage: "assistant",
            });
            if (assistantFailoverOutcome.retryKind === "same_model_idle_timeout") {
              sameModelIdleTimeoutRetries += 1;
            }
            lastRetryFailoverReason = assistantFailoverOutcome.lastRetryFailoverReason;
            continue;
          }
          if (assistantFailoverOutcome.action === "throw") {
            traceAttempts.push({
              provider: activeErrorContext.provider,
              model: activeErrorContext.model,
              result:
                assistantFailoverReason === "timeout"
                  ? "timeout"
                  : assistantFailoverDecision.action === "fallback_model"
                    ? "fallback_model"
                    : "error",
              ...(assistantFailoverReason ? { reason: assistantFailoverReason } : {}),
              stage: "assistant",
              ...(typeof assistantFailoverOutcome.error.status === "number"
                ? { status: assistantFailoverOutcome.error.status }
                : {}),
            });
            if (assistantFailoverOutcome.error.suspend) {
              void suspendSession({
                cfg: params.config,
                agentDir,
                sessionId: activeSessionId ?? params.sessionId,
                laneId: globalLane,
                reason: resolveSessionSuspensionReason(assistantFailoverOutcome.error.reason),
                failedProvider: assistantFailoverOutcome.error.provider ?? provider,
                failedModel: assistantFailoverOutcome.error.model ?? modelId,
              });
            }
            throw assistantFailoverOutcome.error;
          }
          const usageMeta = buildUsageAgentMetaFields({
            usageAccumulator,
            lastAssistantUsage: sessionLastAssistant?.usage as UsageLike | undefined,
            lastRunPromptUsage,
            lastTurnTotal,
          });
          const reportedModelRef = resolveReportedModelRef({
            provider,
            model: model.id,
            assistant: sessionLastAssistant,
          });
          const agentMeta: EmbeddedPiAgentMeta = {
            sessionId: sessionIdUsed,
            sessionFile: sessionFileUsed,
            provider: reportedModelRef.provider,
            model: reportedModelRef.model,
            ...(attempt.plannedExecution ? { plannedExecution: attempt.plannedExecution } : {}),
            contextTokens: ctxInfo.tokens,
            agentHarnessId: attempt.agentHarnessId,
            usage: usageMeta.usage,
            lastCallUsage: usageMeta.lastCallUsage,
            promptTokens: usageMeta.promptTokens,
            compactionCount: autoCompactionCount > 0 ? autoCompactionCount : undefined,
            compactionTokensAfter: lastCompactionTokensAfter,
          };
          const finalAssistantVisibleText = resolveFinalAssistantVisibleText(sessionLastAssistant);
          const finalAssistantRawText = resolveFinalAssistantRawText(sessionLastAssistant);

          const payloads = buildEmbeddedRunPayloads({
            assistantTexts: attempt.assistantTexts,
            toolMetas: attempt.toolMetas,
            lastAssistant: attempt.lastAssistant,
            currentAssistant: currentAttemptAssistant ?? null,
            lastToolError: attempt.lastToolError,
            config: params.config,
            isCronTrigger: params.trigger === "cron",
            sessionKey: params.sessionKey ?? params.sessionId,
            provider: activeErrorContext.provider,
            model: activeErrorContext.model,
            verboseLevel: params.verboseLevel,
            reasoningLevel: params.reasoningLevel,
            thinkingLevel: params.thinkLevel,
            toolResultFormat: resolvedToolResultFormat,
            suppressToolErrorWarnings: params.suppressToolErrorWarnings,
            inlineToolResultsAllowed: false,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
            agentId: params.agentId,
            runId: params.runId,
            runAborted: aborted,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            heartbeatToolResponse: attempt.heartbeatToolResponse,
          });
          let payloadsWithToolMedia: ReplyPayload[] | undefined = mergeAttemptToolMediaPayloads({
            payloads,
            toolMediaUrls: attempt.toolMediaUrls,
            toolAudioAsVoice: attempt.toolAudioAsVoice,
            toolTrustedLocalMedia: attempt.toolTrustedLocalMedia,
            sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
          });
          const payloadAlreadyHasMedia = (payloadsWithToolMedia ?? []).some((payload) =>
            Boolean(payload.mediaUrl?.trim() || payload.mediaUrls?.some((url) => url.trim())),
          );
          const plannedExecutionFinalizerAllowed =
            params.trigger !== "heartbeat" && params.messageChannel !== "heartbeat";
          let plannedExecutionFinalizer =
            !plannedExecutionFinalizerAllowed ||
            attempt.didSendViaMessagingTool ||
            payloadAlreadyHasMedia
              ? undefined
              : await resolvePlannedExecutionFinalizer({
                  plannedExecution: attempt.plannedExecution,
                });
          let plannedExecutionFinalizerApplied = false;
          let plannedExecutionTerminalFailure = false;
          const plannedExecutionNeedsSendRecordingRetry =
            plannedExecutionFinalizer?.ok === true &&
            attempt.plannedExecution?.packetId === "godotRecording" &&
            !attempt.didSendViaMessagingTool &&
            !payloadAlreadyHasMedia &&
            plannedExecutionSendRecoveryAttempts < MAX_PLANNED_EXECUTION_SEND_RECOVERY_RETRIES;
          if (plannedExecutionNeedsSendRecordingRetry) {
            plannedExecutionSendRecoveryAttempts += 1;
            plannedExecutionRetryInstruction = [
              buildExecutionPhaseRetryInstruction("SEND_RECORDING"),
              `PLANNED_EXECUTION_SEND_ONLY_RETRY job_id=${plannedExecutionFinalizer.jobId}`,
            ].join("\n\n");
            log.warn(
              `planned execution recording is valid but not delivered: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} -- retrying ${plannedExecutionSendRecoveryAttempts}/${MAX_PLANNED_EXECUTION_SEND_RECOVERY_RETRIES} with SEND_RECORDING correction`,
            );
            continue;
          }
          if (plannedExecutionFinalizer?.ok) {
            plannedExecutionFinalizerApplied = true;
            payloadsWithToolMedia = [plannedExecutionFinalizer.payload];
            agentMeta.plannedExecutionFinalizer = {
              applied: true,
              packetId: plannedExecutionFinalizer.packetId,
              jobId: plannedExecutionFinalizer.jobId,
              recordingPath: plannedExecutionFinalizer.recordingPath,
              durationSeconds: plannedExecutionFinalizer.probe.durationSeconds,
              averageFps: plannedExecutionFinalizer.probe.averageFps,
            };
            log.info(
              `planned execution finalizer applied: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} recording=${sanitizeForLog(plannedExecutionFinalizer.recordingPath)}`,
            );
          } else if (plannedExecutionFinalizer) {
            agentMeta.plannedExecutionFinalizer = {
              applied: false,
              packetId: plannedExecutionFinalizer.packetId,
              ...(plannedExecutionFinalizer.jobId ? { jobId: plannedExecutionFinalizer.jobId } : {}),
              reason: plannedExecutionFinalizer.reason,
            };
            log.warn(
              `planned execution finalizer skipped: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId ?? "")} reason=${sanitizeForLog(plannedExecutionFinalizer.reason)}`,
            );
            if (
              attempt.plannedExecution?.packetId === "godotRecording" &&
              plannedExecutionFinalizer.jobId &&
              CANONICALIZABLE_PLANNED_EXECUTION_REQUEST_REASONS.has(
                plannedExecutionFinalizer.reason,
              )
            ) {
              try {
                const canonicalized = await canonicalizeExistingGodotRecordingRequestArtifacts({
                  jobId: plannedExecutionFinalizer.jobId,
                });
                if (canonicalized.rewrittenPaths.length > 0) {
                  log.warn(
                    `planned execution canonicalized existing Godot request artifacts: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(canonicalized.artifact.jobId)} paths=${sanitizeForLog(canonicalized.rewrittenPaths.join(","))}`,
                  );
                  plannedExecutionFinalizer = await resolvePlannedExecutionFinalizer({
                    plannedExecution: attempt.plannedExecution,
                  });
                  plannedExecutionFinalizerApplied = plannedExecutionFinalizer?.ok === true;
                  if (plannedExecutionFinalizer?.ok) {
                    payloadsWithToolMedia = [plannedExecutionFinalizer.payload];
                    agentMeta.plannedExecutionFinalizer = {
                      applied: true,
                      packetId: plannedExecutionFinalizer.packetId,
                      jobId: plannedExecutionFinalizer.jobId,
                      recordingPath: plannedExecutionFinalizer.recordingPath,
                      durationSeconds: plannedExecutionFinalizer.probe.durationSeconds,
                      averageFps: plannedExecutionFinalizer.probe.averageFps,
                    };
                    log.info(
                      `planned execution finalizer applied after request canonicalization: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} recording=${sanitizeForLog(plannedExecutionFinalizer.recordingPath)}`,
                    );
                  } else if (plannedExecutionFinalizer) {
                    agentMeta.plannedExecutionFinalizer = {
                      applied: false,
                      packetId: plannedExecutionFinalizer.packetId,
                      ...(plannedExecutionFinalizer.jobId
                        ? { jobId: plannedExecutionFinalizer.jobId }
                        : {}),
                      reason: plannedExecutionFinalizer.reason,
                    };
                    log.warn(
                      `planned execution finalizer skipped after request canonicalization: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId ?? "")} reason=${sanitizeForLog(plannedExecutionFinalizer.reason)}`,
                    );
                  }
                }
              } catch (error) {
                log.warn(
                  `planned execution request canonicalization failed: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} error=${sanitizeForLog(error instanceof Error ? error.message : String(error))}`,
                );
              }
            }
            if (isTerminalPlannedExecutionFailure(plannedExecutionFinalizer)) {
              plannedExecutionTerminalFailure = true;
              payloadsWithToolMedia = [
                buildTerminalPlannedExecutionFailurePayload(plannedExecutionFinalizer),
              ];
            }
          }

          const plannedExecutionNeedsCreateRequestRetry =
            plannedExecutionFinalizer &&
            !plannedExecutionFinalizer.ok &&
            attempt.plannedExecution?.packetId === "godotRecording" &&
            plannedExecutionFinalizer.reason === "status_not_done" &&
            !attempt.toolMetas.some(
              (entry) => entry.toolName.trim().toLowerCase() === "write",
            );
          if (
            plannedExecutionNeedsCreateRequestRetry &&
            plannedExecutionRecoveryAttempts < MAX_PLANNED_EXECUTION_RECOVERY_RETRIES
          ) {
            plannedExecutionRecoveryAttempts += 1;
            plannedExecutionRetryInstruction = [
              buildExecutionPhaseRetryInstruction("CREATE_REQUEST"),
              `PLANNED_EXECUTION_CREATE_REQUEST_ONLY_RETRY job_id=${plannedExecutionFinalizer.jobId}`,
            ].join("\n\n");
            log.warn(
              `planned execution did not create a request file: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId ?? "")} -- retrying ${plannedExecutionRecoveryAttempts}/${MAX_PLANNED_EXECUTION_RECOVERY_RETRIES} with CREATE_REQUEST correction`,
            );
            continue;
          }
          if (
            plannedExecutionNeedsCreateRequestRetry &&
            plannedExecutionRecoveryAttempts >= MAX_PLANNED_EXECUTION_RECOVERY_RETRIES &&
            plannedExecutionFinalizer?.jobId
          ) {
            try {
              const requestArtifact = await ensureGodotRecordingRequest({
                jobId: plannedExecutionFinalizer.jobId,
              });
              log.warn(
                `planned execution deterministically created missing Godot request: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(requestArtifact.jobId)} requestPath=${sanitizeForLog(requestArtifact.requestPath)}`,
              );
              plannedExecutionFinalizer = await resolvePlannedExecutionFinalizer({
                plannedExecution: attempt.plannedExecution,
              });
              plannedExecutionFinalizerApplied = plannedExecutionFinalizer?.ok === true;
              plannedExecutionTerminalFailure = false;
              if (plannedExecutionFinalizer?.ok) {
                payloadsWithToolMedia = [plannedExecutionFinalizer.payload];
                agentMeta.plannedExecutionFinalizer = {
                  applied: true,
                  packetId: plannedExecutionFinalizer.packetId,
                  jobId: plannedExecutionFinalizer.jobId,
                  recordingPath: plannedExecutionFinalizer.recordingPath,
                  durationSeconds: plannedExecutionFinalizer.probe.durationSeconds,
                  averageFps: plannedExecutionFinalizer.probe.averageFps,
                };
                log.info(
                  `planned execution finalizer applied after deterministic request creation: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} recording=${sanitizeForLog(plannedExecutionFinalizer.recordingPath)}`,
                );
              } else if (plannedExecutionFinalizer) {
                agentMeta.plannedExecutionFinalizer = {
                  applied: false,
                  packetId: plannedExecutionFinalizer.packetId,
                  ...(plannedExecutionFinalizer.jobId ? { jobId: plannedExecutionFinalizer.jobId } : {}),
                  reason: plannedExecutionFinalizer.reason,
                };
                log.warn(
                  `planned execution finalizer skipped after deterministic request creation: packet=${plannedExecutionFinalizer.packetId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId ?? "")} reason=${sanitizeForLog(plannedExecutionFinalizer.reason)}`,
                );
                if (isTerminalPlannedExecutionFailure(plannedExecutionFinalizer)) {
                  plannedExecutionTerminalFailure = true;
                  payloadsWithToolMedia = [
                    buildTerminalPlannedExecutionFailurePayload(plannedExecutionFinalizer),
                  ];
                }
              }
            } catch (error) {
              log.warn(
                `planned execution deterministic request creation failed: runId=${params.runId} sessionId=${params.sessionId} jobId=${sanitizeForLog(plannedExecutionFinalizer.jobId)} error=${sanitizeForLog(error instanceof Error ? error.message : String(error))}`,
              );
            }
          }
          const plannedExecutionFinalizerConclusive =
            plannedExecutionFinalizerApplied || plannedExecutionTerminalFailure;

          const timedOutDuringPrompt =
            timedOut && !timedOutDuringCompaction && !timedOutDuringToolExecution;
          const finalAssistantStopReason = (sessionLastAssistant?.stopReason ?? "")
            .trim()
            .toLowerCase();
          const recoveredFinalAssistantTextAfterPromptTimeout =
            timedOutDuringPrompt &&
            ["completed", "end_turn", "stop"].includes(finalAssistantStopReason)
              ? (finalAssistantVisibleText ?? finalAssistantRawText)?.trim()
              : undefined;
          const payloadAlreadyContainsRecoveredFinalAssistant =
            recoveredFinalAssistantTextAfterPromptTimeout
              ? (payloadsWithToolMedia ?? []).some(
                  (payload) =>
                    payload?.isError !== true &&
                    payload?.isReasoning !== true &&
                    typeof payload.text === "string" &&
                    payload.text.trim() === recoveredFinalAssistantTextAfterPromptTimeout,
                )
              : false;
          const recoveredFinalAssistantPayloadsAfterPromptTimeout =
            recoveredFinalAssistantTextAfterPromptTimeout &&
            !payloadAlreadyContainsRecoveredFinalAssistant
              ? [{ text: recoveredFinalAssistantTextAfterPromptTimeout }]
              : undefined;
          const hasSuccessfulFinalAssistantAfterPromptTimeout =
            timedOutDuringPrompt &&
            Boolean(
              payloadAlreadyContainsRecoveredFinalAssistant ||
              recoveredFinalAssistantPayloadsAfterPromptTimeout?.length,
            );
          const hasPartialAssistantTextAfterPromptTimeout =
            timedOutDuringPrompt &&
            (attempt.assistantTexts ?? []).some((text) => text.trim().length > 0) &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !attempt.didSendViaMessagingTool &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            (attempt.toolMetas?.length ?? 0) === 0;
          const attemptToolSummary = buildTraceToolSummary({
            toolMetas: attempt.toolMetas,
            hadFailure: Boolean(attempt.lastToolError),
          });
          const failureSignal = resolveEmbeddedRunFailureSignal({
            trigger: params.trigger,
            lastToolError: attempt.lastToolError,
          });

          // Timeout aborts can leave the run without payloads or with only a
          // partial assistant fragment. Emit an explicit timeout error instead,
          // preserving any tool payloads that succeeded before the timeout.
          if (
            timedOutDuringPrompt &&
            !hasSuccessfulFinalAssistantAfterPromptTimeout &&
            !hasMessagingToolDeliveryEvidence(attempt)
          ) {
            const defaultTimeoutText = idleTimedOut
              ? "The model did not produce a response before the model idle timeout. " +
                "Please try again, or increase `models.providers.<id>.timeoutSeconds` for slow local or self-hosted providers. " +
                "If `agents.defaults.timeoutSeconds` or a run-specific timeout is lower, raise that ceiling too; provider timeouts cannot extend the whole agent run."
              : "Request timed out before a response was generated. " +
                "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.";
            const promptTimeoutMessage = attempt.promptTimeoutOutcome?.message?.trim();
            const timeoutText = promptTimeoutMessage || defaultTimeoutText;
            const replayInvalid =
              attempt.promptTimeoutOutcome?.replayInvalid ?? resolveReplayInvalidForAttempt(null);
            const livenessState =
              attempt.promptTimeoutOutcome?.livenessState ??
              resolveRunLivenessState({
                payloadCount: hasPartialAssistantTextAfterPromptTimeout ? 0 : payloads.length,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: null,
              });
            const timeoutPhase = attempt.promptTimeoutOutcome?.timeoutPhase ?? "provider";
            const providerStarted = attempt.promptTimeoutOutcome?.providerStarted ?? true;
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
              timeoutPhase,
              providerStarted,
            });
            return {
              payloads: [
                ...(hasPartialAssistantTextAfterPromptTimeout ? [] : payloadsWithToolMedia || []),
                {
                  text: timeoutText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                timeoutPhase,
                providerStarted,
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }

          const silentToolResultReplyPayload = resolveSilentToolResultReplyPayload({
            isCronTrigger: params.trigger === "cron",
            payloadCount: payloadsWithToolMedia?.length ?? 0,
            aborted,
            timedOut,
            attempt,
          });
          const payloadsForTerminalPath = recoveredFinalAssistantPayloadsAfterPromptTimeout
            ? recoveredFinalAssistantPayloadsAfterPromptTimeout
            : payloadsWithToolMedia?.length
              ? payloadsWithToolMedia
              : silentToolResultReplyPayload
                ? [silentToolResultReplyPayload]
                : payloadsWithToolMedia;
          const payloadCount = payloadsForTerminalPath?.length ?? 0;
          const emptyAssistantReplyIsSilent = shouldTreatEmptyAssistantReplyAsSilent({
            allowEmptyAssistantReplyAsSilent: params.allowEmptyAssistantReplyAsSilent,
            payloadCount,
            aborted,
            timedOut,
            attempt,
          });
          const nextPlanningOnlyRetryInstruction = emptyAssistantReplyIsSilent
            ? null
            : resolvePlanningOnlyRetryInstruction({
                provider,
                modelId,
                executionContract,
                prompt: params.prompt,
                aborted,
                timedOut,
                attempt,
              });
          const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent
            ? null
            : resolveReasoningOnlyRetryInstruction({
                provider: activeErrorContext.provider,
                modelId: activeErrorContext.model,
                modelApi: effectiveModel.api,
                executionContract,
                aborted,
                timedOut,
                attempt,
              });
          const nextEmptyResponseRetryInstruction = emptyAssistantReplyIsSilent
            ? null
            : resolveEmptyResponseRetryInstruction({
                provider: activeErrorContext.provider,
                modelId: activeErrorContext.model,
                modelApi: effectiveModel.api,
                executionContract,
                payloadCount,
                aborted,
                timedOut,
                attempt,
              });
          if (
            toolIntentGuardrailExplicitFinalizationMode &&
            shouldUseToolIntentGuardrailFinalizationAfterToolProgress({
              retryAttempts: toolIntentGuardrailRetryAttempts,
              toolMetas: attempt.toolMetas,
              clientToolCalls: attempt.clientToolCalls,
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              sawToolProgressAfterRetry: toolIntentGuardrailSawToolProgressAfterRetry,
            })
          ) {
            log.info(
              `tool-intent guardrail switched to finalization mode after tool progress: runId=${params.runId} sessionId=${params.sessionId} previousRetries=${toolIntentGuardrailRetryAttempts}`,
            );
            toolIntentGuardrailFinalizationMode = true;
          }
          if (
            toolIntentGuardrailRetryAttempts > 0 &&
            hasToolIntentGuardrailToolProgress({
              toolMetas: attempt.toolMetas,
              clientToolCalls: attempt.clientToolCalls,
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            })
          ) {
            toolIntentGuardrailSawToolProgressAfterRetry = true;
          }
          const nonAnswerGuardrailText = (
            finalAssistantVisibleText ?? finalAssistantRawText
          )?.trim();
          const nonAnswerGuardrailTriggered =
            !plannedExecutionFinalizerConclusive &&
            isToolIntentGuardrailEnabledForModel({
              config: toolIntentGuardrailConfig,
              provider: reportedModelRef.provider,
              modelId: reportedModelRef.model,
            }) &&
            !assistantMessageHasToolCall(sessionLastAssistant) &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !attempt.didSendViaMessagingTool &&
            !attempt.didSendDeterministicApprovalPrompt &&
            looksLikeNonAnswerPlaceholder(
              nonAnswerGuardrailText,
              toolIntentGuardrailConfig.maxTextChars,
            );
          if (nonAnswerGuardrailTriggered) {
            if (nonAnswerRetries < MAX_NON_ANSWER_RETRIES) {
              nonAnswerRetries += 1;
              nonAnswerRetryInstruction = NON_ANSWER_RETRY_INSTRUCTION;
              log.warn(
                `non-answer guardrail detected placeholder assistant text: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model} -- retrying ${nonAnswerRetries}/${MAX_NON_ANSWER_RETRIES}`,
              );
              continue;
            }
            log.warn(
              `non-answer guardrail detected placeholder assistant text: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model}`,
            );
            const nonAnswerReplayInvalid = resolveReplayInvalidForAttempt(
              NON_ANSWER_GUARDRAIL_MESSAGE,
            );
            const nonAnswerLivenessState = resolveRunLivenessState({
              payloadCount: 0,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: NON_ANSWER_GUARDRAIL_MESSAGE,
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid: nonAnswerReplayInvalid,
              livenessState: nonAnswerLivenessState,
              stopReason: "error",
            });
            return {
              payloads: [
                {
                  text: NON_ANSWER_GUARDRAIL_MESSAGE,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid: nonAnswerReplayInvalid,
                livenessState: nonAnswerLivenessState,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
                stopReason: "error",
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }
          if (toolIntentGuardrailConfig.detectors.includes("toolCallText")) {
            const earlyToolCallTextGuardrailText = (
              finalAssistantVisibleText ?? finalAssistantRawText
            )?.trim();
            const earlyToolCallTextGuardrailThinkingText = sessionLastAssistant
              ? extractAssistantThinking(sessionLastAssistant).trim()
              : "";
            const earlyToolCallTextGuardrailVerdict = await evaluateToolIntentGuardrail({
              cfg: params.config,
              agentId: sessionAgentId,
              config: {
                ...toolIntentGuardrailConfig,
                detectors: ["toolCallText"],
              },
              provider: reportedModelRef.provider,
              modelId: reportedModelRef.model,
              text: earlyToolCallTextGuardrailText,
              thinkingText: earlyToolCallTextGuardrailThinkingText,
              toolMetas: attempt.toolMetas,
              finalAssistantHasToolCall: assistantMessageHasToolCall(sessionLastAssistant),
              clientToolCalls: attempt.clientToolCalls,
              yieldDetected: attempt.yieldDetected,
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              lastToolError: attempt.lastToolError,
            });
            if (earlyToolCallTextGuardrailVerdict.trigger) {
              const toolIntentGuardrailReason = earlyToolCallTextGuardrailVerdict.reason
                ? ` reason=${sanitizeForLog(earlyToolCallTextGuardrailVerdict.reason)}`
                : "";
              if (toolIntentGuardrailRetryAttempts < toolIntentGuardrailConfig.retryCount) {
                toolIntentGuardrailRetryAttempts += 1;
                toolIntentGuardrailRetryInstruction = TOOL_CALL_TEXT_RETRY_INSTRUCTION;
                log.warn(
                  `tool-intent guardrail detector=${earlyToolCallTextGuardrailVerdict.detector}${toolIntentGuardrailReason}`,
                );
                log.warn(
                  `tool-intent guardrail detected assistant text without tool call: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model} -- retrying ${toolIntentGuardrailRetryAttempts}/${toolIntentGuardrailConfig.retryCount} with tool-call correction`,
                );
                continue;
              }
              log.warn(
                `tool-intent guardrail detector=${earlyToolCallTextGuardrailVerdict.detector}${toolIntentGuardrailReason}`,
              );
              log.warn(
                `tool-intent guardrail detected assistant text without tool call: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model}`,
              );
              const guardrailReplayInvalid = resolveReplayInvalidForAttempt(
                TOOL_INTENT_GUARDRAIL_MESSAGE,
              );
              const guardrailLivenessState = resolveRunLivenessState({
                payloadCount: 0,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: TOOL_INTENT_GUARDRAIL_MESSAGE,
              });
              attempt.setTerminalLifecycleMeta?.({
                replayInvalid: guardrailReplayInvalid,
                livenessState: guardrailLivenessState,
                stopReason: "error",
              });
              return {
                payloads: [
                  {
                    text: TOOL_INTENT_GUARDRAIL_MESSAGE,
                    isError: true,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta,
                  aborted,
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  finalAssistantVisibleText,
                  finalAssistantRawText,
                  replayInvalid: guardrailReplayInvalid,
                  livenessState: guardrailLivenessState,
                  agentHarnessResultClassification: attempt.agentHarnessResultClassification,
                  stopReason: "error",
                  toolSummary: attemptToolSummary,
                  ...(failureSignal ? { failureSignal } : {}),
                },
                didSendViaMessagingTool: attempt.didSendViaMessagingTool,
                didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
                messagingToolSentTexts: attempt.messagingToolSentTexts,
                messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
                messagingToolSentTargets: attempt.messagingToolSentTargets,
                messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
                heartbeatToolResponse: attempt.heartbeatToolResponse,
                successfulCronAdds: attempt.successfulCronAdds,
                acceptedSessionSpawns: attempt.acceptedSessionSpawns,
              };
            }
          }
          if (
            nextPlanningOnlyRetryInstruction &&
            planningOnlyRetryAttempts < maxPlanningOnlyRetryAttempts
          ) {
            const planningOnlyText = (attempt.assistantTexts ?? []).join("\n\n").trim();
            const planDetails = extractPlanningOnlyPlanDetails(planningOnlyText);
            if (planDetails) {
              emitAgentPlanEvent({
                runId: params.runId,
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                data: {
                  phase: "update",
                  title: "Assistant proposed a plan",
                  explanation: planDetails.explanation,
                  steps: planDetails.steps,
                  source: "planning_only_retry",
                },
              });
              void params.onAgentEvent?.({
                stream: "plan",
                data: {
                  phase: "update",
                  title: "Assistant proposed a plan",
                  explanation: planDetails.explanation,
                  steps: planDetails.steps,
                  source: "planning_only_retry",
                },
              });
            }
            planningOnlyRetryAttempts += 1;
            planningOnlyRetryInstruction = nextPlanningOnlyRetryInstruction;
            const planningOnlyRetryLogPrefix =
              executionContract === "strict-agentic"
                ? "strict-agentic execution contract triggered"
                : "planning-only turn detected";
            log.warn(
              `${planningOnlyRetryLogPrefix}: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${provider}/${modelId} harness=${sanitizeForLog(agentHarness.id)} ` +
                `contract=${executionContract} configured=${configuredExecutionContractForLog} — retrying ` +
                `${planningOnlyRetryAttempts}/${maxPlanningOnlyRetryAttempts} with act-now steer`,
            );
            continue;
          }
          if (
            !nextPlanningOnlyRetryInstruction &&
            nextReasoningOnlyRetryInstruction &&
            reasoningOnlyRetryAttempts < maxReasoningOnlyRetryAttempts
          ) {
            reasoningOnlyRetryAttempts += 1;
            reasoningOnlyRetryInstruction = nextReasoningOnlyRetryInstruction;
            log.warn(
              `reasoning-only assistant turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} ` +
                `with visible-answer continuation`,
            );
            continue;
          }
          const reasoningOnlyRetriesExhausted =
            !nextPlanningOnlyRetryInstruction &&
            nextReasoningOnlyRetryInstruction &&
            reasoningOnlyRetryAttempts >= maxReasoningOnlyRetryAttempts;
          if (
            !nextPlanningOnlyRetryInstruction &&
            !nextReasoningOnlyRetryInstruction &&
            nextEmptyResponseRetryInstruction &&
            emptyResponseRetryAttempts < maxEmptyResponseRetryAttempts
          ) {
            emptyResponseRetryAttempts += 1;
            emptyResponseRetryInstruction = nextEmptyResponseRetryInstruction;
            log.warn(
              `empty response detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} — retrying ${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} ` +
                `with visible-answer continuation`,
            );
            continue;
          }
          const incompleteTurnText = emptyAssistantReplyIsSilent
            ? null
            : resolveIncompleteTurnPayloadText({
                payloadCount,
                aborted,
                timedOut,
                attempt,
              });
          if (
            !emptyAssistantReplyIsSilent &&
            attemptCompactionCount > 0 &&
            payloadCount === 0 &&
            !aborted &&
            !promptError &&
            !timedOut &&
            !attempt.clientToolCalls &&
            !attempt.yieldDetected &&
            !attempt.didSendDeterministicApprovalPrompt &&
            !attempt.lastToolError &&
            !resolveAttemptReplayMetadata(attempt).hadPotentialSideEffects &&
            compactionContinuationRetryAttempts < 1
          ) {
            compactionContinuationRetryAttempts += 1;
            compactionContinuationRetryInstruction = COMPACTION_CONTINUATION_RETRY_INSTRUCTION;
            log.warn(
              `compaction interrupted visible final answer: runId=${params.runId} sessionId=${params.sessionId} ` +
                `compactions=${attemptCompactionCount} — retrying ${compactionContinuationRetryAttempts}/1 with compacted-transcript continuation`,
            );
            postCompactionGuard.armPostCompaction();
            continue;
          }
          compactionContinuationRetryInstruction = null;
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            log.warn(
              `reasoning-only retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${reasoningOnlyRetryAttempts}/${maxReasoningOnlyRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          if (!incompleteTurnText && nextPlanningOnlyRetryInstruction && strictAgenticActive) {
            log.warn(
              `strict-agentic run exhausted planning-only retries: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${provider}/${modelId} configured=${configuredExecutionContractForLog} — surfacing blocked state`,
            );
            // Criterion 4 of the GPT-5.4 parity gate requires every terminal
            // exit path to emit an explicit livenessState + replayInvalid so
            // downstream observers never see "silent disappearance". Every
            // other hard-error terminal branch in this file uses "blocked"
            // for its livenessState (role ordering, image size, schema
            // error, compaction timeout, aborted-with-no-payloads). Match
            // that convention here so lifecycle consumers treat an
            // isError:true strict-agentic-blocked payload the same way they
            // treat any other error-terminal payload. Replay validity is
            // delegated to the shared resolver because the plan-only
            // transcript itself is replay-safe even though the run is
            // terminal.
            const replayInvalid = resolveReplayInvalidForAttempt(null);
            const livenessState: EmbeddedRunLivenessState = "blocked";
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            return {
              payloads: [
                {
                  text: STRICT_AGENTIC_BLOCKED_TEXT,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }
          if (reasoningOnlyRetriesExhausted && !finalAssistantVisibleText) {
            const replayInvalid = resolveReplayInvalidForAttempt(
              "⚠️ Agent couldn't generate a response. Please try again.",
            );
            const livenessState = resolveRunLivenessState({
              payloadCount: 0,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: "⚠️ Agent couldn't generate a response. Please try again.",
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: assistantProfileFailureReason,
              });
            }
            return {
              payloads: [
                {
                  text: "⚠️ Agent couldn't generate a response. Please try again.",
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }
          if (
            !nextPlanningOnlyRetryInstruction &&
            !nextReasoningOnlyRetryInstruction &&
            nextEmptyResponseRetryInstruction &&
            emptyResponseRetryAttempts >= maxEmptyResponseRetryAttempts
          ) {
            log.warn(
              `empty response retries exhausted: runId=${params.runId} sessionId=${params.sessionId} ` +
                `provider=${activeErrorContext.provider}/${activeErrorContext.model} attempts=${emptyResponseRetryAttempts}/${maxEmptyResponseRetryAttempts} — surfacing incomplete-turn error`,
            );
          }
          // ── silent-error retry ────────────────────────────────────────────
          // Observed with ollama/glm-5.1: a turn can end with stopReason="error"
          // and zero output tokens AND empty content after a successful
          // tool-call sequence, producing no user-visible text at all. This
          // path is narrower than the empty-response continuation retry:
          // same prompt, same session transcript (tool results already
          // captured), no instruction injection. Placed before the
          // incompleteTurnText return so it actually gets a chance to fire.
          //
          // Content-empty guard: a reasoning-only error (content has thinking
          // blocks) is a distinct failure mode handled elsewhere; only retry
          // when the assistant truly produced nothing.
          //
          // Side-effect guard: if the failed attempt already recorded potential
          // side effects (messaging tool sent, cron add, mutating tool
          // call that wasn't round-tripped as replay-safe), resubmission can
          // duplicate those actions. Mirror the gate the other retry resolvers
          // use (resolveEmptyResponseRetryInstruction, reasoning-only, planning-
          // only), which short-circuit on attempt.replayMetadata.hadPotentialSideEffects.
          const silentErrorContent = sessionLastAssistant?.content as Array<unknown> | undefined;
          if (
            incompleteTurnText &&
            !aborted &&
            !promptError &&
            !timedOut &&
            sessionLastAssistant?.stopReason === "error" &&
            ((sessionLastAssistant?.usage as { output?: number } | undefined)?.output ?? 0) === 0 &&
            (silentErrorContent?.length ?? 0) === 0 &&
            (attempt.replayMetadata ? !attempt.replayMetadata.hadPotentialSideEffects : false) &&
            emptyErrorRetries < MAX_EMPTY_ERROR_RETRIES
          ) {
            emptyErrorRetries += 1;
            log.warn(
              `[empty-error-retry] stopReason=error output=0; resubmitting ` +
                `attempt=${emptyErrorRetries}/${MAX_EMPTY_ERROR_RETRIES} ` +
                `provider=${sessionLastAssistant?.provider ?? provider} ` +
                `model=${sessionLastAssistant?.model ?? model.id} ` +
                `sessionKey=${params.sessionKey ?? params.sessionId}`,
            );
            continue;
          }
          if (incompleteTurnText) {
            const replayInvalid = resolveReplayInvalidForAttempt(incompleteTurnText);
            const livenessState = resolveRunLivenessState({
              payloadCount,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText,
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid,
              livenessState,
            });
            const incompleteStopReason = attempt.lastAssistant?.stopReason;
            log.warn(
              `incomplete turn detected: runId=${params.runId} sessionId=${params.sessionId} ` +
                `stopReason=${incompleteStopReason} payloads=${payloadCount} — surfacing error to user`,
            );

            // Mark the failing profile for cooldown so multi-profile setups
            // rotate away from the exhausted credential on the next turn.
            if (lastProfileId) {
              await maybeMarkAuthProfileFailure({
                profileId: lastProfileId,
                reason: assistantProfileFailureReason,
              });
            }

            return {
              payloads: [
                {
                  text: incompleteTurnText,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid,
                livenessState,
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }

          log.debug(
            `embedded run done: runId=${params.runId} sessionId=${params.sessionId} durationMs=${Date.now() - started} aborted=${aborted}`,
          );
          if (lastProfileId) {
            await markAuthProfileSuccess({
              store: profileFailureStore,
              provider: resolveAuthProfileStateProvider(
                profileFailureStore,
                lastProfileId,
                provider,
              ),
              profileId: lastProfileId,
              agentDir: params.agentDir,
            });
          }
          const replayInvalid = resolveReplayInvalidForAttempt(null);
          const livenessState = attempt.yieldDetected
            ? "paused"
            : resolveRunLivenessState({
                payloadCount,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: null,
              });
          const stopReason = attempt.clientToolCalls
            ? "tool_calls"
            : attempt.yieldDetected
              ? "end_turn"
              : (sessionLastAssistant?.stopReason as string | undefined);
          const toolIntentGuardrailText = (
            finalAssistantVisibleText ?? finalAssistantRawText
          )?.trim();
          const toolIntentGuardrailThinkingText = sessionLastAssistant
            ? extractAssistantThinking(sessionLastAssistant).trim()
            : "";
          const toolIntentGuardrailVerdict = await evaluateToolIntentGuardrail({
            cfg: params.config,
            agentId: sessionAgentId,
            config: toolIntentGuardrailConfig,
            provider: reportedModelRef.provider,
            modelId: reportedModelRef.model,
            text: toolIntentGuardrailText,
            thinkingText: toolIntentGuardrailThinkingText,
            toolMetas: attempt.toolMetas,
            finalAssistantHasToolCall: assistantMessageHasToolCall(sessionLastAssistant),
            clientToolCalls: attempt.clientToolCalls,
            allowFinalizationTextAfterToolCall: toolIntentGuardrailExplicitFinalizationMode,
            requireResponseMode: toolIntentGuardrailExplicitFinalizationMode,
            yieldDetected: attempt.yieldDetected,
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            lastToolError: attempt.lastToolError,
          });
          if (toolIntentGuardrailVerdict.trigger && !plannedExecutionFinalizerConclusive) {
            const toolIntentGuardrailReason = toolIntentGuardrailVerdict.reason
              ? ` reason=${sanitizeForLog(toolIntentGuardrailVerdict.reason)}`
              : "";
            if (toolIntentGuardrailRetryAttempts < toolIntentGuardrailConfig.retryCount) {
              toolIntentGuardrailRetryAttempts += 1;
              const useFinalizationInstruction =
                toolIntentGuardrailFinalizationMode &&
                toolIntentGuardrailVerdict.detector !== "toolCallText";
              toolIntentGuardrailRetryInstruction =
                useFinalizationInstruction
                  ? TOOL_INTENT_FINALIZATION_INSTRUCTION
                  : toolIntentGuardrailVerdict.detector === "phaseLabel"
                    ? buildExecutionPhaseRetryInstruction(toolIntentGuardrailVerdict.phase)
                    : toolIntentGuardrailVerdict.detector === "responseMode"
                    ? RESPONSE_MODE_RETRY_INSTRUCTION
                    : toolIntentGuardrailVerdict.detector === "toolCallText"
                      ? TOOL_CALL_TEXT_RETRY_INSTRUCTION
                      : TOOL_INTENT_RETRY_INSTRUCTION;
              log.warn(
                `tool-intent guardrail detector=${toolIntentGuardrailVerdict.detector}${toolIntentGuardrailReason}`,
              );
              log.warn(
                `tool-intent guardrail detected assistant text without tool call: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model} — retrying ${toolIntentGuardrailRetryAttempts}/${toolIntentGuardrailConfig.retryCount} with ${useFinalizationInstruction ? "finalization" : "tool-call"} correction`,
              );
              continue;
            }
            log.warn(
              `tool-intent guardrail detector=${toolIntentGuardrailVerdict.detector}${toolIntentGuardrailReason}`,
            );
            log.warn(
              `tool-intent guardrail detected assistant text without tool call: runId=${params.runId} sessionId=${params.sessionId} provider=${reportedModelRef.provider}/${reportedModelRef.model}`,
            );
            if (
              (toolIntentGuardrailExplicitFinalizationMode ||
                toolIntentGuardrailSawToolProgressAfterRetry ||
                hasToolIntentGuardrailToolProgress({
                  toolMetas: attempt.toolMetas,
                  clientToolCalls: attempt.clientToolCalls,
                  didSendViaMessagingTool: attempt.didSendViaMessagingTool,
                  didSendDeterministicApprovalPrompt:
                    attempt.didSendDeterministicApprovalPrompt,
                })) &&
              toolIntentGuardrailVerdict.detector !== "toolCallText"
            ) {
              const fallbackText = buildToolIntentFinalizationFallbackText({
                lastAssistantText: toolIntentGuardrailText,
                toolMetas: attempt.toolMetas,
              });
              const fallbackReplayInvalid = resolveReplayInvalidForAttempt(fallbackText);
              const fallbackLivenessState = resolveRunLivenessState({
                payloadCount: 1,
                aborted,
                timedOut,
                attempt,
                incompleteTurnText: null,
              });
              attempt.setTerminalLifecycleMeta?.({
                replayInvalid: fallbackReplayInvalid,
                livenessState: fallbackLivenessState,
                stopReason: "stop",
              });
              return {
                payloads: [
                  {
                    text: fallbackText,
                  },
                ],
                meta: {
                  durationMs: Date.now() - started,
                  agentMeta,
                  aborted,
                  systemPromptReport: attempt.systemPromptReport,
                  finalPromptText: attempt.finalPromptText,
                  finalAssistantVisibleText,
                  finalAssistantRawText,
                  replayInvalid: fallbackReplayInvalid,
                  livenessState: fallbackLivenessState,
                  agentHarnessResultClassification: attempt.agentHarnessResultClassification,
                  stopReason: "stop",
                  executionTrace: {
                    winnerProvider: reportedModelRef.provider,
                    winnerModel: reportedModelRef.model,
                    attempts:
                      traceAttempts.length > 0 ||
                      sessionLastAssistant?.provider ||
                      sessionLastAssistant?.model
                        ? [
                            ...traceAttempts,
                            {
                              provider: reportedModelRef.provider,
                              model: reportedModelRef.model,
                              result: "success",
                              reason: TOOL_INTENT_FINALIZATION_FALLBACK_TRACE_REASON,
                              stage: "assistant",
                            },
                          ]
                        : undefined,
                    fallbackUsed: traceAttempts.length > 0,
                    runner: "embedded",
                  },
                  requestShaping: {
                    ...(lastProfileId ? { authMode: "auth-profile" } : {}),
                    ...(thinkLevel ? { thinking: thinkLevel } : {}),
                    ...(params.reasoningLevel ? { reasoning: params.reasoningLevel } : {}),
                    ...(params.verboseLevel ? { verbose: params.verboseLevel } : {}),
                    ...(params.blockReplyBreak ? { blockStreaming: params.blockReplyBreak } : {}),
                  },
                  toolSummary: attemptToolSummary,
                  ...(failureSignal ? { failureSignal } : {}),
                  completion: {
                    stopReason: "stop",
                    finishReason: "stop",
                  },
                  contextManagement:
                    autoCompactionCount > 0
                      ? { lastTurnCompactions: autoCompactionCount }
                      : undefined,
                },
                didSendViaMessagingTool: attempt.didSendViaMessagingTool,
                didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
                messagingToolSentTexts: attempt.messagingToolSentTexts,
                messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
                messagingToolSentTargets: attempt.messagingToolSentTargets,
                messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
                heartbeatToolResponse: attempt.heartbeatToolResponse,
                successfulCronAdds: attempt.successfulCronAdds,
                acceptedSessionSpawns: attempt.acceptedSessionSpawns,
              };
            }
            const guardrailReplayInvalid = resolveReplayInvalidForAttempt(
              TOOL_INTENT_GUARDRAIL_MESSAGE,
            );
            const guardrailLivenessState = resolveRunLivenessState({
              payloadCount: 0,
              aborted,
              timedOut,
              attempt,
              incompleteTurnText: TOOL_INTENT_GUARDRAIL_MESSAGE,
            });
            attempt.setTerminalLifecycleMeta?.({
              replayInvalid: guardrailReplayInvalid,
              livenessState: guardrailLivenessState,
              stopReason: "error",
            });
            return {
              payloads: [
                {
                  text: TOOL_INTENT_GUARDRAIL_MESSAGE,
                  isError: true,
                },
              ],
              meta: {
                durationMs: Date.now() - started,
                agentMeta,
                aborted,
                systemPromptReport: attempt.systemPromptReport,
                finalPromptText: attempt.finalPromptText,
                finalAssistantVisibleText,
                finalAssistantRawText,
                replayInvalid: guardrailReplayInvalid,
                livenessState: guardrailLivenessState,
                agentHarnessResultClassification: attempt.agentHarnessResultClassification,
                stopReason: "error",
                executionTrace: {
                  winnerProvider: reportedModelRef.provider,
                  winnerModel: reportedModelRef.model,
                  attempts:
                    traceAttempts.length > 0 ||
                    sessionLastAssistant?.provider ||
                    sessionLastAssistant?.model
                      ? [
                          ...traceAttempts,
                          {
                            provider: reportedModelRef.provider,
                            model: reportedModelRef.model,
                            result: "error",
                            reason: "tool_intent_guardrail",
                            stage: "assistant",
                          },
                        ]
                      : undefined,
                  fallbackUsed: traceAttempts.length > 0,
                  runner: "embedded",
                },
                requestShaping: {
                  ...(lastProfileId ? { authMode: "auth-profile" } : {}),
                  ...(thinkLevel ? { thinking: thinkLevel } : {}),
                  ...(params.reasoningLevel ? { reasoning: params.reasoningLevel } : {}),
                  ...(params.verboseLevel ? { verbose: params.verboseLevel } : {}),
                  ...(params.blockReplyBreak ? { blockStreaming: params.blockReplyBreak } : {}),
                },
                toolSummary: attemptToolSummary,
                ...(failureSignal ? { failureSignal } : {}),
                completion: {
                  stopReason: "error",
                  finishReason: "error",
                },
                contextManagement:
                  autoCompactionCount > 0
                    ? { lastTurnCompactions: autoCompactionCount }
                    : undefined,
              },
              didSendViaMessagingTool: attempt.didSendViaMessagingTool,
              didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
              messagingToolSentTexts: attempt.messagingToolSentTexts,
              messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
              messagingToolSentTargets: attempt.messagingToolSentTargets,
              messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
              heartbeatToolResponse: attempt.heartbeatToolResponse,
              successfulCronAdds: attempt.successfulCronAdds,
              acceptedSessionSpawns: attempt.acceptedSessionSpawns,
            };
          }
          const terminalPayloads = emptyAssistantReplyIsSilent
            ? [{ text: SILENT_REPLY_TOKEN }]
            : payloadsForTerminalPath;
          attempt.setTerminalLifecycleMeta?.({
            replayInvalid,
            livenessState,
            stopReason,
            yielded: attempt.yieldDetected === true,
          });
          return {
            payloads: terminalPayloads?.length ? terminalPayloads : undefined,
            ...(attempt.diagnosticTrace
              ? { diagnosticTrace: freezeDiagnosticTraceContext(attempt.diagnosticTrace) }
              : {}),
            meta: {
              durationMs: Date.now() - started,
              agentMeta,
              aborted,
              systemPromptReport: attempt.systemPromptReport,
              finalPromptText: attempt.finalPromptText,
              finalAssistantVisibleText,
              finalAssistantRawText,
              replayInvalid,
              livenessState,
              agentHarnessResultClassification: attempt.agentHarnessResultClassification,
              ...(attempt.yieldDetected ? { yielded: true } : {}),
              ...(emptyAssistantReplyIsSilent
                ? { terminalReplyKind: "silent-empty" as const }
                : {}),
              // Handle client tool calls (OpenResponses hosted tools)
              // Propagate the LLM stop reason so callers (lifecycle events,
              // ACP bridge) can distinguish end_turn from max_tokens.
              stopReason,
              pendingToolCalls: attempt.clientToolCalls?.map((call) => ({
                id: randomBytes(5).toString("hex").slice(0, 9),
                name: call.name,
                arguments: JSON.stringify(call.params),
              })),
              executionTrace: {
                winnerProvider: reportedModelRef.provider,
                winnerModel: reportedModelRef.model,
                attempts:
                  traceAttempts.length > 0 ||
                  sessionLastAssistant?.provider ||
                  sessionLastAssistant?.model
                    ? [
                        ...traceAttempts,
                        {
                          provider: reportedModelRef.provider,
                          model: reportedModelRef.model,
                          result: "success",
                          stage: "assistant",
                        },
                      ]
                    : undefined,
                fallbackUsed: traceAttempts.length > 0,
                runner: "embedded",
              },
              requestShaping: {
                ...(lastProfileId ? { authMode: "auth-profile" } : {}),
                ...(thinkLevel ? { thinking: thinkLevel } : {}),
                ...(params.reasoningLevel ? { reasoning: params.reasoningLevel } : {}),
                ...(params.verboseLevel ? { verbose: params.verboseLevel } : {}),
                ...(params.blockReplyBreak ? { blockStreaming: params.blockReplyBreak } : {}),
              },
              toolSummary: attemptToolSummary,
              ...(failureSignal ? { failureSignal } : {}),
              completion: {
                ...(stopReason ? { stopReason } : {}),
                ...(stopReason ? { finishReason: stopReason } : {}),
                ...(stopReason?.toLowerCase().includes("refusal") ? { refusal: true } : {}),
              },
              contextManagement:
                autoCompactionCount > 0 ? { lastTurnCompactions: autoCompactionCount } : undefined,
            },
            didSendViaMessagingTool: attempt.didSendViaMessagingTool,
            didSendDeterministicApprovalPrompt: attempt.didSendDeterministicApprovalPrompt,
            messagingToolSentTexts: attempt.messagingToolSentTexts,
            messagingToolSentMediaUrls: attempt.messagingToolSentMediaUrls,
            messagingToolSentTargets: attempt.messagingToolSentTargets,
            messagingToolSourceReplyPayloads: attempt.messagingToolSourceReplyPayloads,
            heartbeatToolResponse: attempt.heartbeatToolResponse,
            successfulCronAdds: attempt.successfulCronAdds,
            acceptedSessionSpawns: attempt.acceptedSessionSpawns,
          };
        }
      } finally {
        forgetPromptBuildDrainCacheForRun(params.runId);
        stopRuntimeAuthRefreshTimer();
        await runAgentCleanupStep({
          runId: params.runId,
          sessionId: params.sessionId,
          step: "context-engine-dispose",
          log,
          cleanup: async () => {
            await contextEngine.dispose?.();
          },
        });
        if (params.cleanupBundleMcpOnRunEnd === true) {
          await runAgentCleanupStep({
            runId: params.runId,
            sessionId: params.sessionId,
            step: "bundle-mcp-retire",
            log,
            cleanup: async () => {
              const onError = (error: unknown, sessionId: string) => {
                log.warn(
                  `bundle-mcp cleanup failed after run for ${sessionId}: ${formatErrorMessage(error)}`,
                );
              };
              const retiredBySessionKey = await retireSessionMcpRuntimeForSessionKey({
                sessionKey: params.sessionKey,
                reason: "embedded-run-end",
                onError,
              });
              if (!retiredBySessionKey) {
                await retireSessionMcpRuntime({
                  sessionId: params.sessionId,
                  reason: "embedded-run-end",
                  onError,
                });
              }
            },
          });
        }
      }
    });
  });
}

function resolveAuthProfileStateProvider(
  store: AuthProfileStore,
  profileId: string,
  fallbackProvider: string,
): string {
  const profileProvider = store.profiles?.[profileId]?.provider?.trim();
  if (profileProvider) {
    return profileProvider;
  }
  const idProvider = profileId.split(":", 1)[0]?.trim();
  return idProvider || fallbackProvider;
}

const testing = {
  looksLikeDeferredToolIntent,
  looksLikeBareToolCallText,
  looksLikeNonAnswerPlaceholder,
  looksLikeUnsupportedToolCompletionClaim,
  buildToolIntentFinalizationFallbackText,
  looksLikeFinalizationRequest,
  parseExecutionPhaseLabel,
  parseResponseMode,
  looksLikeStructuredToolIntent,
  matchesModelPattern,
  evaluateToolIntentGuardrail,
  resolveToolIntentGuardrailConfig,
  shouldUseToolIntentGuardrailFinalizationAfterToolProgress,
  shouldTriggerToolIntentGuardrail,
};

export { testing as __testing };
