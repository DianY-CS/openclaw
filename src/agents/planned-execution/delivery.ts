import { fileURLToPath } from "node:url";

import type {
  ArtifactDeliveryEvidence,
  ArtifactDeliveryRequest,
  PlannedArtifact,
} from "./artifacts.js";

export type PlannedArtifactDeliveryState = {
  artifactPath?: string;
  didSendViaMessagingTool?: boolean;
  messagingToolSentMediaUrls?: readonly string[];
  payloadAlreadyHasMedia?: boolean;
  payloadMediaUrls?: readonly string[];
  deliveryEvidence?: ArtifactDeliveryEvidence;
};

export type PlannedArtifactDeliveryEvidenceClassification =
  | {
      ok: true;
      source: "delivery_evidence";
      evidence: ArtifactDeliveryEvidence;
    }
  | {
      ok: true;
      source: "messaging_tool_media" | "payload_media";
      path: string;
    }
  | {
      ok: false;
      reason: "missing_structured_delivery_evidence" | "missing_artifact_path_match";
    };

export function isArtifactDeliveryEvidenceOk(
  evidence: ArtifactDeliveryEvidence | undefined,
): boolean {
  return evidence?.ok === true;
}

function normalizeDeliveryPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  let pathValue = trimmed;
  if (trimmed.startsWith("file://")) {
    try {
      pathValue = fileURLToPath(trimmed);
    } catch {
      pathValue = trimmed.slice("file://".length).replace(/^\/+/u, "/");
    }
  }
  return pathValue.replace(/\\/gu, "/").replace(/^\/([A-Za-z]:\/)/u, "$1");
}

function findMatchingArtifactPath(params: {
  artifactPath?: string;
  values?: readonly string[];
}): string | undefined {
  const artifactPath = normalizeDeliveryPath(params.artifactPath);
  if (!artifactPath) {
    return undefined;
  }
  return params.values
    ?.map((value) => normalizeDeliveryPath(value))
    .find((value): value is string => value === artifactPath);
}

export function classifyPlannedArtifactDeliveryEvidence(
  state: PlannedArtifactDeliveryState,
): PlannedArtifactDeliveryEvidenceClassification {
  if (isArtifactDeliveryEvidenceOk(state.deliveryEvidence)) {
    return {
      ok: true,
      source: "delivery_evidence",
      evidence: state.deliveryEvidence,
    };
  }
  const messagingToolMediaPath = findMatchingArtifactPath({
    artifactPath: state.artifactPath,
    values: state.messagingToolSentMediaUrls,
  });
  if (state.didSendViaMessagingTool && messagingToolMediaPath) {
    return {
      ok: true,
      source: "messaging_tool_media",
      path: messagingToolMediaPath,
    };
  }
  const payloadMediaPath = findMatchingArtifactPath({
    artifactPath: state.artifactPath,
    values: state.payloadMediaUrls,
  });
  if (state.payloadAlreadyHasMedia && payloadMediaPath) {
    return {
      ok: true,
      source: "payload_media",
      path: payloadMediaPath,
    };
  }
  return {
    ok: false,
    reason:
      state.didSendViaMessagingTool || state.payloadAlreadyHasMedia
        ? "missing_artifact_path_match"
        : "missing_structured_delivery_evidence",
  };
}

export function hasPlannedArtifactDeliveryEvidence(
  state: PlannedArtifactDeliveryState,
): boolean {
  return classifyPlannedArtifactDeliveryEvidence(state).ok;
}

export function shouldAttemptArtifactDelivery(params: {
  artifactAccepted: boolean;
  deliveryState: PlannedArtifactDeliveryState;
  attempts: number;
  maxAttempts: number;
}): boolean {
  return Boolean(
    params.artifactAccepted &&
      !hasPlannedArtifactDeliveryEvidence(params.deliveryState) &&
      params.attempts < params.maxAttempts,
  );
}

export function buildArtifactDeliveryRequest(params: {
  artifact: PlannedArtifact;
  channel: ArtifactDeliveryRequest["channel"];
  deliveryMode: ArtifactDeliveryRequest["deliveryMode"];
  target?: string;
  caption?: string;
}): ArtifactDeliveryRequest {
  return {
    artifact: params.artifact,
    channel: params.channel,
    deliveryMode: params.deliveryMode,
    ...(params.target ? { target: params.target } : {}),
    ...(params.caption ? { caption: params.caption } : {}),
  };
}

export function buildArtifactDeliveryEvidence(params: {
  ok: boolean;
  artifactId: string;
  channel: string;
  mode: ArtifactDeliveryEvidence["mode"];
  messageId?: string;
  mediaType?: string;
  path?: string;
  error?: string;
}): ArtifactDeliveryEvidence {
  return {
    ok: params.ok,
    artifactId: params.artifactId,
    channel: params.channel,
    mode: params.mode,
    ...(params.messageId ? { messageId: params.messageId } : {}),
    ...(params.mediaType ? { mediaType: params.mediaType } : {}),
    ...(params.path ? { path: params.path } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}
