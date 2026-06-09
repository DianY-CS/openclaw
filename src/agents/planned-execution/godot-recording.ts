import type {
  ArtifactAcceptanceCriteria,
  PlannedJob,
  PlannedArtifact,
} from "./artifacts.js";
import {
  buildPlannedJob,
  buildPlannedJobPaths,
  buildPlannedResultPath,
  type PlannedJobPaths,
} from "./jobs.js";

export const GODOT_RECORDING_PROJECT_PATH = "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp";
export const GODOT_RECORDING_RECORD_SECONDS = 15;
export const GODOT_RECORDING_RECORD_FPS = 60;
export const GODOT_RECORDING_RECORD_WIDTH = 1280;
export const GODOT_RECORDING_RECORD_HEIGHT = 720;
export const GODOT_RECORDING_STARTUP_WAIT_SECONDS = 1;
export const GODOT_RECORDING_PLANNING_STAGE_SECONDS = 3;
export const DEFAULT_GODOT_RECORDING_MIN_SECONDS = 14.5;
export const DEFAULT_GODOT_RECORDING_MIN_FPS = 55;
export const DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS = 10;
export const GODOT_RECORDING_ARTIFACT_ID = "recording";

export type GodotRecordingRequestArtifact = {
  jobId: string;
  requestPath: string;
  request: Record<string, unknown>;
};

export type GodotRecordingJobPaths = PlannedJobPaths & {
  recordingPath: string;
  probePath: string;
};

export function buildGodotRecordingJobPaths(params: {
  jobId: string;
  workspaceRoot?: string;
}): GodotRecordingJobPaths {
  const paths = buildPlannedJobPaths({
    jobId: params.jobId,
    workspaceRoot: params.workspaceRoot,
  });
  return {
    ...paths,
    recordingPath: buildPlannedResultPath(paths, "recording.mp4"),
    probePath: buildPlannedResultPath(paths, "video_probe.json"),
  };
}

export function buildGodotRecordingRequestArtifact(params: {
  jobId: string;
  workspaceRoot?: string;
}): GodotRecordingRequestArtifact {
  const paths = buildGodotRecordingJobPaths(params);
  return {
    jobId: params.jobId,
    requestPath: paths.requestPath,
    request: {
      job_id: params.jobId,
      action: "run_and_capture",
      project_path: GODOT_RECORDING_PROJECT_PATH,
      scene: "scenes/combat_sandbox.tscn",
      wait_seconds: 16,
      startup_wait_seconds: GODOT_RECORDING_STARTUP_WAIT_SECONDS,
      planning_stage_seconds: GODOT_RECORDING_PLANNING_STAGE_SECONDS,
      record_seconds: GODOT_RECORDING_RECORD_SECONDS,
      record_fps: GODOT_RECORDING_RECORD_FPS,
      record_width: GODOT_RECORDING_RECORD_WIDTH,
      record_height: GODOT_RECORDING_RECORD_HEIGHT,
      godot_movie: true,
      capture: {
        video: true,
        screenshot: false,
        record_seconds: GODOT_RECORDING_RECORD_SECONDS,
        fps: GODOT_RECORDING_RECORD_FPS,
        width: GODOT_RECORDING_RECORD_WIDTH,
        height: GODOT_RECORDING_RECORD_HEIGHT,
      },
    },
  };
}

export function buildGodotRecordingRequestCriteria(params: {
  jobId: string;
  requestPath: string;
}): ArtifactAcceptanceCriteria[] {
  return [
    { kind: "json_field_equals", path: params.requestPath, field: "job_id", value: params.jobId },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "project_path",
      value: GODOT_RECORDING_PROJECT_PATH,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "startup_wait_seconds",
      value: GODOT_RECORDING_STARTUP_WAIT_SECONDS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "planning_stage_seconds",
      value: GODOT_RECORDING_PLANNING_STAGE_SECONDS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "record_seconds",
      value: GODOT_RECORDING_RECORD_SECONDS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "record_fps",
      value: GODOT_RECORDING_RECORD_FPS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "record_width",
      value: GODOT_RECORDING_RECORD_WIDTH,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "record_height",
      value: GODOT_RECORDING_RECORD_HEIGHT,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "godot_movie",
      value: true,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "capture.record_seconds",
      value: GODOT_RECORDING_RECORD_SECONDS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "capture.fps",
      value: GODOT_RECORDING_RECORD_FPS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "capture.width",
      value: GODOT_RECORDING_RECORD_WIDTH,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "capture.height",
      value: GODOT_RECORDING_RECORD_HEIGHT,
    },
  ];
}

export function buildGodotRecordingArtifact(params: {
  recordingPath: string;
  probePath: string;
}): PlannedArtifact {
  return {
    id: GODOT_RECORDING_ARTIFACT_ID,
    kind: "video",
    path: params.recordingPath,
    probePath: params.probePath,
    required: true,
  };
}

export function buildGodotRecordingArtifactCriteria(params?: {
  minDurationSeconds?: number;
  minFps?: number;
  minEffectiveFps?: number;
}): ArtifactAcceptanceCriteria[] {
  return [
    { kind: "file_exists", artifactId: GODOT_RECORDING_ARTIFACT_ID },
    {
      kind: "video_duration_seconds",
      artifactId: GODOT_RECORDING_ARTIFACT_ID,
      min: params?.minDurationSeconds ?? DEFAULT_GODOT_RECORDING_MIN_SECONDS,
    },
    {
      kind: "video_average_fps",
      artifactId: GODOT_RECORDING_ARTIFACT_ID,
      min: params?.minFps ?? DEFAULT_GODOT_RECORDING_MIN_FPS,
    },
    {
      kind: "video_effective_fps",
      artifactId: GODOT_RECORDING_ARTIFACT_ID,
      min: params?.minEffectiveFps ?? DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS,
    },
  ];
}

export function buildGodotRecordingPlannedJob(params: {
  jobId: string;
  workspaceRoot?: string;
  timeoutSeconds?: number;
}): PlannedJob {
  const paths = buildGodotRecordingJobPaths(params);
  const artifact = buildGodotRecordingArtifact({
    recordingPath: paths.recordingPath,
    probePath: paths.probePath,
  });
  return buildPlannedJob({
    jobId: params.jobId,
    kind: "godotRecording",
    paths,
    timeoutSeconds: params.timeoutSeconds ?? 240,
    expectedArtifacts: [artifact],
    acceptanceCriteria: [
      ...buildGodotRecordingRequestCriteria({
        jobId: params.jobId,
        requestPath: paths.requestPath,
      }),
      ...buildGodotRecordingArtifactCriteria(),
    ],
  });
}
