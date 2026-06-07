import path from "node:path";

import type {
  ArtifactAcceptanceCriteria,
  PlannedArtifact,
} from "./artifacts.js";

export const GODOT_RECORDING_PROJECT_PATH = "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp";
export const GODOT_RECORDING_RECORD_SECONDS = 15;
export const GODOT_RECORDING_RECORD_FPS = 60;
export const GODOT_RECORDING_STARTUP_WAIT_SECONDS = 1;
export const DEFAULT_GODOT_RECORDING_MIN_SECONDS = 14.5;
export const DEFAULT_GODOT_RECORDING_MIN_FPS = 55;
export const DEFAULT_GODOT_RECORDING_MIN_EFFECTIVE_FPS = 10;
export const GODOT_RECORDING_ARTIFACT_ID = "recording";

export type GodotRecordingRequestArtifact = {
  jobId: string;
  requestPath: string;
  request: Record<string, unknown>;
};

export function buildGodotRecordingRequestArtifact(params: {
  jobId: string;
  workspaceRoot?: string;
}): GodotRecordingRequestArtifact {
  const workspaceRoot = params.workspaceRoot ?? "/home/node/.openclaw/workspace";
  const joinPath =
    workspaceRoot.includes("\\") || /^[A-Za-z]:/u.test(workspaceRoot) ? path.join : path.posix.join;
  return {
    jobId: params.jobId,
    requestPath: joinPath(workspaceRoot, "jobs", "game", "requests", `${params.jobId}.json`),
    request: {
      job_id: params.jobId,
      action: "run_and_capture",
      project_path: GODOT_RECORDING_PROJECT_PATH,
      scene: "scenes/combat_sandbox.tscn",
      wait_seconds: 6,
      startup_wait_seconds: GODOT_RECORDING_STARTUP_WAIT_SECONDS,
      record_seconds: GODOT_RECORDING_RECORD_SECONDS,
      record_fps: GODOT_RECORDING_RECORD_FPS,
      record_width: 1920,
      record_height: 1080,
      capture: {
        video: true,
        screenshot: false,
        record_seconds: GODOT_RECORDING_RECORD_SECONDS,
        fps: GODOT_RECORDING_RECORD_FPS,
        width: 1920,
        height: 1080,
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
      field: "capture.record_seconds",
      value: GODOT_RECORDING_RECORD_SECONDS,
    },
    {
      kind: "json_field_equals",
      path: params.requestPath,
      field: "capture.fps",
      value: GODOT_RECORDING_RECORD_FPS,
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
