import { describe, expect, it } from "vitest";

import {
  buildGodotRecordingArtifact,
  buildGodotRecordingArtifactCriteria,
  buildGodotRecordingJobPaths,
  buildGodotRecordingPlannedJob,
  buildGodotRecordingRequestArtifact,
  buildGodotRecordingRequestCriteria,
  DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS,
  GODOT_RECORDING_PLANNING_STAGE_SECONDS,
  GODOT_RECORDING_PROJECT_PATH,
} from "./godot-recording.js";

describe("Godot planned recording helpers", () => {
  it("builds the existing host-runner request shape without behavior changes", () => {
    const artifact = buildGodotRecordingRequestArtifact({
      jobId: "qwen_planned_godot_recording_test-run",
      workspaceRoot: "/workspace",
    });

    expect(artifact.requestPath).toBe(
      "/workspace/jobs/game/requests/qwen_planned_godot_recording_test-run.json",
    );
    expect(artifact.request).toEqual({
      job_id: "qwen_planned_godot_recording_test-run",
      action: "run_and_capture",
      project_path: GODOT_RECORDING_PROJECT_PATH,
      scene: "scenes/combat_sandbox.tscn",
      wait_seconds: 16,
      startup_wait_seconds: 1,
      planning_stage_seconds: 3,
      record_seconds: 15,
      record_fps: 60,
      record_width: 1280,
      record_height: 720,
      godot_movie: true,
      capture: {
        video: true,
        screenshot: false,
        record_seconds: 15,
        fps: 60,
        width: 1280,
        height: 720,
      },
    });
  });

  it("builds request and artifact criteria for the current Godot thresholds", () => {
    expect(
      buildGodotRecordingRequestCriteria({
        jobId: "qwen_planned_godot_recording_test-run",
        requestPath: "/workspace/jobs/game/requests/job.json",
      }),
    ).toContainEqual({
      kind: "json_field_equals",
      path: "/workspace/jobs/game/requests/job.json",
      field: "capture.fps",
      value: 60,
    });

    const criteria = buildGodotRecordingArtifactCriteria();
    expect(criteria).toContainEqual({
      kind: "video_effective_fps",
      artifactId: "recording",
      min: DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS,
    });
    expect(DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS).toBe(10);
    expect(GODOT_RECORDING_PLANNING_STAGE_SECONDS).toBe(3);
    expect(
      buildGodotRecordingRequestCriteria({
        jobId: "qwen_planned_godot_recording_test-run",
        requestPath: "/workspace/jobs/game/requests/job.json",
      }),
    ).toContainEqual({
      kind: "json_field_equals",
      path: "/workspace/jobs/game/requests/job.json",
      field: "planning_stage_seconds",
      value: GODOT_RECORDING_PLANNING_STAGE_SECONDS,
    });
    expect(
      buildGodotRecordingRequestCriteria({
        jobId: "qwen_planned_godot_recording_test-run",
        requestPath: "/workspace/jobs/game/requests/job.json",
      }),
    ).toContainEqual({
      kind: "json_field_equals",
      path: "/workspace/jobs/game/requests/job.json",
      field: "godot_movie",
      value: true,
    });
    expect(criteria).toContainEqual({
      kind: "video_average_fps",
      artifactId: "recording",
      min: 55,
    });
  });

  it("builds the recording artifact descriptor", () => {
    expect(
      buildGodotRecordingArtifact({
        recordingPath: "/workspace/jobs/game/results/job/recording.mp4",
        probePath: "/workspace/jobs/game/results/job/video_probe.json",
      }),
    ).toEqual({
      id: "recording",
      kind: "video",
      path: "/workspace/jobs/game/results/job/recording.mp4",
      probePath: "/workspace/jobs/game/results/job/video_probe.json",
      required: true,
    });
  });

  it("builds Godot recording job paths and a planned job descriptor", () => {
    const paths = buildGodotRecordingJobPaths({
      jobId: "qwen_planned_godot_recording_test-run",
      workspaceRoot: "/workspace",
    });

    expect(paths).toMatchObject({
      requestPath: "/workspace/jobs/game/requests/qwen_planned_godot_recording_test-run.json",
      requestDonePath:
        "/workspace/jobs/game/requests_done/qwen_planned_godot_recording_test-run.json",
      requestFailedPath:
        "/workspace/jobs/game/requests_failed/qwen_planned_godot_recording_test-run.json",
      resultDir: "/workspace/jobs/game/results/qwen_planned_godot_recording_test-run",
      statusPath: "/workspace/jobs/game/results/qwen_planned_godot_recording_test-run/status.json",
      recordingPath:
        "/workspace/jobs/game/results/qwen_planned_godot_recording_test-run/recording.mp4",
      probePath:
        "/workspace/jobs/game/results/qwen_planned_godot_recording_test-run/video_probe.json",
    });

    const job = buildGodotRecordingPlannedJob({
      jobId: "qwen_planned_godot_recording_test-run",
      workspaceRoot: "/workspace",
    });

    expect(job).toMatchObject({
      jobId: "qwen_planned_godot_recording_test-run",
      kind: "godotRecording",
      requestPath: paths.requestPath,
      resultDir: paths.resultDir,
      statusPath: paths.statusPath,
      timeoutSeconds: 240,
      expectedArtifacts: [
        {
          id: "recording",
          kind: "video",
          path: paths.recordingPath,
          probePath: paths.probePath,
          required: true,
        },
      ],
    });
    expect(job.acceptanceCriteria).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "job_id",
          path: paths.requestPath,
        }),
      ]),
    );
  });
});
