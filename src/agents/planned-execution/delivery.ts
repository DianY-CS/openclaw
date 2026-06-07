import type {
  ArtifactDeliveryEvidence,
  ArtifactDeliveryRequest,
  PlannedArtifact,
} from "./artifacts.js";

export type PlannedArtifactDeliveryState = {
  didSendViaMessagingTool?: boolean;
  payloadAlreadyHasMedia?: boolean;
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
      source: "messaging_tool_send" | "payload_media";
    }
  | {
      ok: false;
      reason: "missing_structured_delivery_evidence";
    };

export function isArtifactDeliveryEvidenceOk(
  evidence: ArtifactDeliveryEvidence | undefined,
): boolean {
  return evidence?.ok === true;
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
  if (state.didSendViaMessagingTool) {
    return {
      ok: true,
      source: "messaging_tool_send",
    };
  }
  if (state.payloadAlreadyHasMedia) {
    return {
      ok: true,
      source: "payload_media",
    };
  }
  return {
    ok: false,
    reason: "missing_structured_delivery_evidence",
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
