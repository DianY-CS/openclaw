export type PlannedArtifactKind = "video" | "image" | "json" | "file";

export type PlannedArtifact = {
  id: string;
  kind: PlannedArtifactKind;
  path: string;
  probePath?: string;
  required: boolean;
};

export type ArtifactAcceptanceCriteria =
  | { kind: "file_exists"; artifactId: string }
  | { kind: "video_duration_seconds"; artifactId: string; min: number }
  | { kind: "video_average_fps"; artifactId: string; min: number }
  | { kind: "video_effective_fps"; artifactId: string; min: number }
  | { kind: "json_field_equals"; path: string; field: string; value: unknown };

export type PlannedJob = {
  jobId: string;
  kind: string;
  requestPath: string;
  resultDir: string;
  statusPath: string;
  timeoutSeconds: number;
  expectedArtifacts: PlannedArtifact[];
  acceptanceCriteria: ArtifactAcceptanceCriteria[];
};

export type ArtifactValidationResult = {
  ok: boolean;
  artifactId?: string;
  checks: Record<string, boolean>;
  evidence: Record<string, unknown>;
  failure?: {
    reason: string;
    retryable: boolean;
    terminal: boolean;
  };
};

export type ArtifactDeliveryRequest = {
  artifact: PlannedArtifact;
  channel: "telegram" | "mock" | "local";
  target?: string;
  caption?: string;
  deliveryMode: "real" | "mock";
};

export type ArtifactDeliveryEvidence = {
  ok: boolean;
  artifactId: string;
  channel: string;
  mode: "real" | "mock";
  messageId?: string;
  mediaType?: string;
  path?: string;
  error?: string;
};

export type PlannedArtifactValidationFacts = {
  existingPaths?: Iterable<string>;
  jsonByPath?: Record<string, unknown>;
  videoProbeByArtifactId?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJsonField(record: unknown, field: string): unknown {
  if (!isRecord(record)) {
    return undefined;
  }
  return field.split(".").reduce<unknown>((current, part) => {
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, record);
}

function criterionCheckId(criterion: ArtifactAcceptanceCriteria): string {
  switch (criterion.kind) {
    case "file_exists":
      return `${criterion.kind}:${criterion.artifactId}`;
    case "video_duration_seconds":
      return `${criterion.kind}:${criterion.artifactId}:min=${criterion.min}`;
    case "video_average_fps":
      return `${criterion.kind}:${criterion.artifactId}:min=${criterion.min}`;
    case "video_effective_fps":
      return `${criterion.kind}:${criterion.artifactId}:min=${criterion.min}`;
    case "json_field_equals":
      return `${criterion.kind}:${criterion.path}:${criterion.field}`;
  }
}

function criterionArtifactId(criterion: ArtifactAcceptanceCriteria): string | undefined {
  return "artifactId" in criterion ? criterion.artifactId : undefined;
}

function lookupArtifact(
  artifactsById: Map<string, PlannedArtifact>,
  artifactId: string,
): PlannedArtifact | undefined {
  return artifactsById.get(artifactId);
}

function lookupProbe(params: {
  artifact: PlannedArtifact;
  facts: PlannedArtifactValidationFacts;
}): Record<string, unknown> | undefined {
  const byArtifactId = params.facts.videoProbeByArtifactId?.[params.artifact.id];
  if (isRecord(byArtifactId)) {
    return byArtifactId;
  }
  const byProbePath = params.artifact.probePath
    ? params.facts.jsonByPath?.[params.artifact.probePath]
    : undefined;
  if (isRecord(byProbePath)) {
    return byProbePath;
  }
  const byArtifactPath = params.facts.jsonByPath?.[params.artifact.path];
  return isRecord(byArtifactPath) ? byArtifactPath : undefined;
}

function failureForCriterion(
  criterion: ArtifactAcceptanceCriteria,
  reason: string,
): ArtifactValidationResult["failure"] {
  const retryable = criterion.kind === "file_exists";
  return {
    reason,
    retryable,
    terminal: !retryable,
  };
}

export function validateArtifactAcceptanceCriteria(params: {
  artifacts: PlannedArtifact[];
  criteria: ArtifactAcceptanceCriteria[];
  facts?: PlannedArtifactValidationFacts;
}): ArtifactValidationResult {
  const facts = params.facts ?? {};
  const existingPaths = new Set(facts.existingPaths ?? []);
  const artifactsById = new Map(params.artifacts.map((artifact) => [artifact.id, artifact]));
  const checks: Record<string, boolean> = {};
  const evidence: Record<string, unknown> = {};
  let failure: ArtifactValidationResult["failure"];
  let failedArtifactId: string | undefined;

  for (const criterion of params.criteria) {
    const checkId = criterionCheckId(criterion);
    let ok = false;
    let reason = `${criterion.kind}_failed`;

    switch (criterion.kind) {
      case "file_exists": {
        const artifact = lookupArtifact(artifactsById, criterion.artifactId);
        ok = Boolean(artifact && existingPaths.has(artifact.path));
        evidence[checkId] = {
          artifactId: criterion.artifactId,
          path: artifact?.path,
          exists: ok,
        };
        reason = artifact ? "file_missing" : "artifact_missing";
        break;
      }
      case "video_duration_seconds": {
        const artifact = lookupArtifact(artifactsById, criterion.artifactId);
        const actual = artifact ? finiteNumber(lookupProbe({ artifact, facts })?.duration_seconds) : undefined;
        ok = actual !== undefined && actual >= criterion.min;
        evidence[checkId] = {
          artifactId: criterion.artifactId,
          actual,
          min: criterion.min,
        };
        reason = artifact ? "video_duration_seconds_too_low" : "artifact_missing";
        break;
      }
      case "video_average_fps": {
        const artifact = lookupArtifact(artifactsById, criterion.artifactId);
        const actual = artifact ? finiteNumber(lookupProbe({ artifact, facts })?.average_fps) : undefined;
        ok = actual !== undefined && actual >= criterion.min;
        evidence[checkId] = {
          artifactId: criterion.artifactId,
          actual,
          min: criterion.min,
        };
        reason = artifact ? "video_average_fps_too_low" : "artifact_missing";
        break;
      }
      case "video_effective_fps": {
        const artifact = lookupArtifact(artifactsById, criterion.artifactId);
        const probe = artifact ? lookupProbe({ artifact, facts }) : undefined;
        const actual = finiteNumber(probe?.effective_fps);
        ok = actual === undefined || actual >= criterion.min;
        evidence[checkId] = {
          artifactId: criterion.artifactId,
          actual,
          min: criterion.min,
        };
        reason = artifact ? "video_effective_fps_too_low" : "artifact_missing";
        break;
      }
      case "json_field_equals": {
        const record = facts.jsonByPath?.[criterion.path];
        const actual = readJsonField(record, criterion.field);
        ok = Object.is(actual, criterion.value);
        evidence[checkId] = {
          path: criterion.path,
          field: criterion.field,
          actual,
          expected: criterion.value,
        };
        reason = "json_field_mismatch";
        break;
      }
    }

    checks[checkId] = ok;
    if (!ok && !failure) {
      failure = failureForCriterion(criterion, reason);
      failedArtifactId = criterionArtifactId(criterion);
    }
  }

  return {
    ok: Object.values(checks).every(Boolean),
    ...(failedArtifactId ? { artifactId: failedArtifactId } : {}),
    checks,
    evidence,
    ...(failure ? { failure } : {}),
  };
}
