import { describe, expect, it } from "vitest";

import {
  buildGodotRecordingArtifact,
  buildGodotRecordingArtifactCriteria,
  buildGodotRecordingRequestArtifact,
  buildGodotRecordingRequestCriteria,
  DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS,
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
      wait_seconds: 6,
      startup_wait_seconds: 1,
      record_seconds: 15,
      record_fps: 60,
      record_width: 1920,
      record_height: 1080,
      capture: {
        video: true,
        screenshot: false,
        record_seconds: 15,
        fps: 60,
        width: 1920,
        height: 1080,
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
});
