import { describe, expect, it } from "vitest";

import {
  type ArtifactAcceptanceCriteria,
  type PlannedArtifact,
  validateArtifactAcceptanceCriteria,
} from "./artifacts.js";

const recordingArtifact = {
  id: "recording",
  kind: "video",
  path: "/workspace/jobs/game/results/job/recording.mp4",
  probePath: "/workspace/jobs/game/results/job/video_probe.json",
  required: true,
} satisfies PlannedArtifact;

describe("planned execution artifacts", () => {
  it("validates file, duration, fps, and request JSON criteria", () => {
    const criteria = [
      { kind: "file_exists", artifactId: "recording" },
      { kind: "video_duration_seconds", artifactId: "recording", min: 14.5 },
      { kind: "video_average_fps", artifactId: "recording", min: 55 },
      { kind: "video_effective_fps", artifactId: "recording", min: 10 },
      {
        kind: "json_field_equals",
        path: "/workspace/jobs/game/requests/job.json",
        field: "capture.fps",
        value: 60,
      },
    ] satisfies ArtifactAcceptanceCriteria[];

    const result = validateArtifactAcceptanceCriteria({
      artifacts: [recordingArtifact],
      criteria,
      facts: {
        existingPaths: [recordingArtifact.path],
        jsonByPath: {
          [recordingArtifact.probePath]: {
            duration_seconds: 15.1,
            average_fps: 60,
            effective_fps: 14,
          },
          "/workspace/jobs/game/requests/job.json": {
            capture: { fps: 60 },
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.evidence["video_duration_seconds:recording:min=14.5"]).toEqual({
      artifactId: "recording",
      actual: 15.1,
      min: 14.5,
    });
  });

  it("returns structured failure evidence for low fps", () => {
    const result = validateArtifactAcceptanceCriteria({
      artifacts: [recordingArtifact],
      criteria: [{ kind: "video_average_fps", artifactId: "recording", min: 55 }],
      facts: {
        jsonByPath: {
          [recordingArtifact.probePath]: {
            duration_seconds: 15.1,
            average_fps: 12,
          },
        },
      },
    });

    expect(result).toEqual({
      ok: false,
      artifactId: "recording",
      checks: {
        "video_average_fps:recording:min=55": false,
      },
      evidence: {
        "video_average_fps:recording:min=55": {
          artifactId: "recording",
          actual: 12,
          min: 55,
        },
      },
      failure: {
        reason: "video_average_fps_too_low",
        retryable: false,
        terminal: true,
      },
    });
  });

  it("treats missing files as retryable validation failures", () => {
    const result = validateArtifactAcceptanceCriteria({
      artifacts: [recordingArtifact],
      criteria: [{ kind: "file_exists", artifactId: "recording" }],
      facts: {
        existingPaths: [],
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({
      reason: "file_missing",
      retryable: true,
      terminal: false,
    });
  });

  it("treats effective fps as optional, but validates it when present", () => {
    expect(
      validateArtifactAcceptanceCriteria({
        artifacts: [recordingArtifact],
        criteria: [{ kind: "video_effective_fps", artifactId: "recording", min: 10 }],
        facts: {
          jsonByPath: {
            [recordingArtifact.probePath]: {
              duration_seconds: 15.1,
              average_fps: 60,
            },
          },
        },
      }).ok,
    ).toBe(true);

    const result = validateArtifactAcceptanceCriteria({
      artifacts: [recordingArtifact],
      criteria: [{ kind: "video_effective_fps", artifactId: "recording", min: 10 }],
      facts: {
        jsonByPath: {
          [recordingArtifact.probePath]: {
            duration_seconds: 15.1,
            average_fps: 60,
            effective_fps: 3.7,
          },
        },
      },
    });

    expect(result.failure).toEqual({
      reason: "video_effective_fps_too_low",
      retryable: false,
      terminal: true,
    });
  });
});
