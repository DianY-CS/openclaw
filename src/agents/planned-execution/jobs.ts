import path from "node:path";

import type {
  ArtifactAcceptanceCriteria,
  PlannedArtifact,
  PlannedJob,
} from "./artifacts.js";

export const DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT = "/home/node/.openclaw/workspace";
export const DEFAULT_PLANNED_EXECUTION_JOB_LANE = "game";

export type PlannedJobPaths = {
  workspaceRoot: string;
  lane: string;
  jobId: string;
  requestsDir: string;
  requestsDoneDir: string;
  requestsFailedDir: string;
  resultsDir: string;
  requestPath: string;
  requestDonePath: string;
  requestFailedPath: string;
  resultDir: string;
  statusPath: string;
};

export type PlannedJobRequestLifecycleStatus = "done" | "active" | "failed" | "missing";

export type PlannedJobRequestLifecycleFacts = {
  doneRecord?: Record<string, unknown>;
  activeRecord?: Record<string, unknown>;
  failedRecord?: Record<string, unknown>;
};

export type PlannedJobRequestLifecycle = {
  status: PlannedJobRequestLifecycleStatus;
  path?: string;
  record?: Record<string, unknown>;
  failureReason?: string;
};

function normalizeWorkspaceRoot(workspaceRoot: string | undefined): string {
  return workspaceRoot?.trim() || DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT;
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || undefined;
}

export function joinPlannedExecutionPath(workspaceRoot: string, ...segments: string[]): string {
  const joinPath =
    workspaceRoot.includes("\\") || /^[A-Za-z]:/u.test(workspaceRoot) ? path.join : path.posix.join;
  return joinPath(workspaceRoot, ...segments);
}

export function buildPlannedJobPaths(params: {
  jobId: string;
  workspaceRoot?: string;
  lane?: string;
}): PlannedJobPaths {
  const workspaceRoot = normalizeWorkspaceRoot(params.workspaceRoot);
  const lane = params.lane?.trim() || DEFAULT_PLANNED_EXECUTION_JOB_LANE;
  const requestsDir = joinPlannedExecutionPath(workspaceRoot, "jobs", lane, "requests");
  const requestsDoneDir = joinPlannedExecutionPath(workspaceRoot, "jobs", lane, "requests_done");
  const requestsFailedDir = joinPlannedExecutionPath(
    workspaceRoot,
    "jobs",
    lane,
    "requests_failed",
  );
  const resultsDir = joinPlannedExecutionPath(workspaceRoot, "jobs", lane, "results");
  const requestFileName = `${params.jobId}.json`;
  const resultDir = joinPlannedExecutionPath(resultsDir, params.jobId);

  return {
    workspaceRoot,
    lane,
    jobId: params.jobId,
    requestsDir,
    requestsDoneDir,
    requestsFailedDir,
    resultsDir,
    requestPath: joinPlannedExecutionPath(requestsDir, requestFileName),
    requestDonePath: joinPlannedExecutionPath(requestsDoneDir, requestFileName),
    requestFailedPath: joinPlannedExecutionPath(requestsFailedDir, requestFileName),
    resultDir,
    statusPath: joinPlannedExecutionPath(resultDir, "status.json"),
  };
}

export function buildPlannedResultPath(paths: PlannedJobPaths, fileName: string): string {
  return joinPlannedExecutionPath(paths.resultDir, fileName);
}

export function buildPlannedJob(params: {
  jobId: string;
  kind: string;
  paths: PlannedJobPaths;
  timeoutSeconds: number;
  expectedArtifacts: PlannedArtifact[];
  acceptanceCriteria: ArtifactAcceptanceCriteria[];
}): PlannedJob {
  return {
    jobId: params.jobId,
    kind: params.kind,
    requestPath: params.paths.requestPath,
    resultDir: params.paths.resultDir,
    statusPath: params.paths.statusPath,
    timeoutSeconds: params.timeoutSeconds,
    expectedArtifacts: params.expectedArtifacts,
    acceptanceCriteria: params.acceptanceCriteria,
  };
}

export function resolvePlannedJobRequestLifecycle(params: {
  paths: PlannedJobPaths;
  facts?: PlannedJobRequestLifecycleFacts;
}): PlannedJobRequestLifecycle {
  const facts = params.facts ?? {};
  if (facts.doneRecord) {
    return {
      status: "done",
      path: params.paths.requestDonePath,
      record: facts.doneRecord,
    };
  }
  if (facts.failedRecord) {
    return {
      status: "failed",
      path: params.paths.requestFailedPath,
      record: facts.failedRecord,
      failureReason:
        stringField(facts.failedRecord, "reason") ??
        stringField(facts.failedRecord, "error") ??
        stringField(facts.failedRecord, "message") ??
        "request_failed",
    };
  }
  if (facts.activeRecord) {
    return {
      status: "active",
      path: params.paths.requestPath,
      record: facts.activeRecord,
    };
  }
  return {
    status: "missing",
    path: params.paths.requestPath,
  };
}
