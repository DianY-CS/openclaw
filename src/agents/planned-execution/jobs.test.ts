import { describe, expect, it } from "vitest";

import {
  buildPlannedJob,
  buildPlannedJobPaths,
  buildPlannedResultPath,
  DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT,
  resolvePlannedJobRequestLifecycle,
} from "./jobs.js";

describe("planned execution job helpers", () => {
  it("builds canonical container job lifecycle paths", () => {
    const paths = buildPlannedJobPaths({ jobId: "job-123" });

    expect(paths).toEqual({
      workspaceRoot: DEFAULT_PLANNED_EXECUTION_WORKSPACE_ROOT,
      lane: "game",
      jobId: "job-123",
      requestsDir: "/home/node/.openclaw/workspace/jobs/game/requests",
      requestsDoneDir: "/home/node/.openclaw/workspace/jobs/game/requests_done",
      requestsFailedDir: "/home/node/.openclaw/workspace/jobs/game/requests_failed",
      resultsDir: "/home/node/.openclaw/workspace/jobs/game/results",
      requestPath: "/home/node/.openclaw/workspace/jobs/game/requests/job-123.json",
      requestDonePath: "/home/node/.openclaw/workspace/jobs/game/requests_done/job-123.json",
      requestFailedPath:
        "/home/node/.openclaw/workspace/jobs/game/requests_failed/job-123.json",
      resultDir: "/home/node/.openclaw/workspace/jobs/game/results/job-123",
      statusPath: "/home/node/.openclaw/workspace/jobs/game/results/job-123/status.json",
    });
    expect(buildPlannedResultPath(paths, "video_probe.json")).toBe(
      "/home/node/.openclaw/workspace/jobs/game/results/job-123/video_probe.json",
    );
  });

  it("uses platform path joining for Windows workspace roots", () => {
    const paths = buildPlannedJobPaths({
      jobId: "job-123",
      workspaceRoot: "D:\\OpenClawWorkspace",
    });

    expect(paths.requestPath).toBe("D:\\OpenClawWorkspace\\jobs\\game\\requests\\job-123.json");
    expect(paths.statusPath).toBe(
      "D:\\OpenClawWorkspace\\jobs\\game\\results\\job-123\\status.json",
    );
  });

  it("builds a generic planned job descriptor from paths", () => {
    const paths = buildPlannedJobPaths({ jobId: "job-123" });
    const artifact = {
      id: "recording",
      kind: "video" as const,
      path: buildPlannedResultPath(paths, "recording.mp4"),
      required: true,
    };
    const criteria = [{ kind: "file_exists" as const, artifactId: "recording" }];

    expect(
      buildPlannedJob({
        jobId: "job-123",
        kind: "godotRecording",
        paths,
        timeoutSeconds: 240,
        expectedArtifacts: [artifact],
        acceptanceCriteria: criteria,
      }),
    ).toEqual({
      jobId: "job-123",
      kind: "godotRecording",
      requestPath: paths.requestPath,
      resultDir: paths.resultDir,
      statusPath: paths.statusPath,
      timeoutSeconds: 240,
      expectedArtifacts: [artifact],
      acceptanceCriteria: criteria,
    });
  });

  it("classifies planned job request lifecycle facts", () => {
    const paths = buildPlannedJobPaths({ jobId: "job-123", workspaceRoot: "/workspace" });
    const doneRecord = { job_id: "job-123" };
    const activeRecord = { job_id: "job-123", status: "queued" };
    const failedRecord = { job_id: "job-123", error: "bad request" };

    expect(
      resolvePlannedJobRequestLifecycle({
        paths,
        facts: {
          doneRecord,
          activeRecord,
          failedRecord,
        },
      }),
    ).toEqual({
      status: "done",
      path: "/workspace/jobs/game/requests_done/job-123.json",
      record: doneRecord,
    });

    expect(
      resolvePlannedJobRequestLifecycle({
        paths,
        facts: {
          failedRecord,
        },
      }),
    ).toEqual({
      status: "failed",
      path: "/workspace/jobs/game/requests_failed/job-123.json",
      record: failedRecord,
      failureReason: "bad request",
    });

    expect(
      resolvePlannedJobRequestLifecycle({
        paths,
        facts: {
          activeRecord,
        },
      }),
    ).toEqual({
      status: "active",
      path: "/workspace/jobs/game/requests/job-123.json",
      record: activeRecord,
    });

    expect(resolvePlannedJobRequestLifecycle({ paths })).toEqual({
      status: "missing",
      path: "/workspace/jobs/game/requests/job-123.json",
    });
  });
});
