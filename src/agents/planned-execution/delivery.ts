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

export type PlannedArtifactDeliveryEvidenceSource =
  | "delivery_evidence"
  | "messaging_tool_media"
  | "payload_media";

export type PlannedArtifactDeliveryEvidenceClassification =
  | {
      ok: true;
      source: Extract<PlannedArtifactDeliveryEvidenceSource, "delivery_evidence">;
      evidence: ArtifactDeliveryEvidence;
    }
  | {
      ok: true;
      source: Exclude<PlannedArtifactDeliveryEvidenceSource, "delivery_evidence">;
      path: string;
    }
  | {
      ok: false;
      reason: "missing_structured_delivery_evidence" | "missing_artifact_path_match";
    };

export type PlannedArtifactDeliveryFinalEvidence = {
  status: "done";
  packet_id?: string;
  job_id: string;
  recording_path: string;
  recording_validated?: boolean;
  video_probe?: {
    duration_seconds?: number;
    average_fps?: number;
    frame_count?: number;
    effective_fps?: number;
    effective_frame_count?: number;
  };
  telegram_delivery: {
    ok: true;
    source?: PlannedArtifactDeliveryEvidenceSource;
    path?: string;
    messageId?: string;
    mediaType?: string;
  };
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

export function buildPlannedArtifactDeliveryFinalEvidence(params: {
  jobId: string;
  artifactPath: string;
  packetId?: string;
  recordingValidated?: boolean;
  videoProbe?: PlannedArtifactDeliveryFinalEvidence["video_probe"];
  delivery: Extract<PlannedArtifactDeliveryEvidenceClassification, { ok: true }>;
}): PlannedArtifactDeliveryFinalEvidence {
  const telegramDelivery: PlannedArtifactDeliveryFinalEvidence["telegram_delivery"] = {
    ok: true,
  };

  if (params.delivery.source === "delivery_evidence") {
    telegramDelivery.source = params.delivery.source;
    if (params.delivery.evidence.path) {
      telegramDelivery.path = params.delivery.evidence.path;
    }
    if (params.delivery.evidence.messageId) {
      telegramDelivery.messageId = params.delivery.evidence.messageId;
    }
    if (params.delivery.evidence.mediaType) {
      telegramDelivery.mediaType = params.delivery.evidence.mediaType;
    }
  } else if (params.delivery.path !== params.artifactPath) {
    telegramDelivery.source = params.delivery.source;
    telegramDelivery.path = params.delivery.path;
  }

  return {
    status: "done",
    ...(params.packetId ? { packet_id: params.packetId } : {}),
    job_id: params.jobId,
    recording_path: params.artifactPath,
    ...(params.recordingValidated !== undefined
      ? { recording_validated: params.recordingValidated }
      : {}),
    ...(params.videoProbe ? { video_probe: params.videoProbe } : {}),
    telegram_delivery: telegramDelivery,
  };
}

export function buildPlannedArtifactDeliveryFinalText(
  evidence: PlannedArtifactDeliveryFinalEvidence,
): string {
  return JSON.stringify(evidence);
}
