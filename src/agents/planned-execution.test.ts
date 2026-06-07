import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "../config/types.openclaw.js";
import { describe, expect, it } from "vitest";
import {
  canonicalizeExistingGodotRecordingRequestArtifacts,
  looksLikeGodotRecordingExecutionRequest,
  resolvePlannedExecutionFinalizer,
  resolvePlannedExecutionRewrite,
} from "./planned-execution.js";

const qwenConfig = {
  agents: {
    defaults: {
      embeddedPi: {
        plannedExecution: {
          enabled: true,
          models: ["llamacpp/*qwen*"],
        },
      },
    },
  },
} satisfies OpenClawConfig;

describe("planned execution packet routing", () => {
  it("detects Godot auto chess recording execution requests", () => {
    expect(
      looksLikeGodotRecordingExecutionRequest(
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      ),
    ).toBe(true);
    expect(
      looksLikeGodotRecordingExecutionRequest(
        "Cool, I need you to make a gameplay recording for me. Please execute it.",
      ),
    ).toBe(false);
  });

  it("does not rewrite plan-only Godot recording questions", () => {
    const prompt =
      "Cool, I need you to make a gameplay recording for me. What will you do? Just tell me your plan, thanks.";

    expect(looksLikeGodotRecordingExecutionRequest(prompt)).toBe(false);
    expect(
      resolvePlannedExecutionRewrite({
        prompt,
        config: qwenConfig,
        agentId: "main",
        provider: "llamacpp",
        modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
        runId: "run-plan-only",
      }),
    ).toBeUndefined();
  });

  it("rewrites matching Qwen requests into executor packets", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "abc-123",
      messageChannel: "telegram",
    });

    expect(rewrite?.packetId).toBe("godotRecording");
    expect(rewrite?.jobId).toBe("qwen_planned_godot_recording_abc-123");
    expect(rewrite?.prompt).toContain("PLANNED_EXECUTION_PACKET");
    expect(rewrite?.prompt).toContain("packet_id: godotRecording");
    expect(rewrite?.prompt).toContain("record_seconds");
    expect(rewrite?.prompt).toContain("message tool");
    expect(rewrite?.prompt).toContain("RESPONSE_MODE: final");
    expect(rewrite?.prompt).toContain("Do not parallelize dependent steps");
    expect(rewrite?.prompt).toContain("skip phases that already have successful tool results");
    expect(rewrite?.prompt).toContain("resume at the first incomplete phase");
    expect(rewrite?.prompt).toContain(
      "After request_path has been validated successfully, wait 20 seconds before the first status_path read",
    );
    expect(rewrite?.prompt).toContain("wait 5 seconds and read the same status_path again");
    expect(rewrite?.prompt).toContain("Repeat up to 14 polls");
    expect(rewrite?.prompt).toContain("A directory-only command is not enough");
    expect(rewrite?.prompt).toContain("Never infer a job id from directory listings");
    expect(rewrite?.prompt).toContain(
      'The only valid project_path is exactly "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp"',
    );
    expect(rewrite?.prompt).toContain(
      'A mixed path such as "D:\\OpenClawWorkspace\\games/roguelike_auto_chess_mvp" is invalid',
    );
    expect(rewrite?.prompt).toContain("rewrite request_path with the exact JSON above and stop");
    expect(rewrite?.prompt).toContain("If status_path or probe_path already proved");
    expect(rewrite?.prompt).toContain("Phase labels are invalid visible replies");
    expect(rewrite?.prompt).not.toContain("EXEC_PHASE: SEND_RECORDING");
    expect(rewrite?.prompt).toContain(
      'action "send", message "Here is the 15-second Godot gameplay recording.", filePath recording_path',
    );
    expect(rewrite?.prompt).toContain(
      "do not read request_path until the create-request tool result has returned successfully",
    );
    expect(rewrite?.prompt).toContain("CREATE_REQUEST");
    expect(rewrite?.prompt).toContain("VALIDATE_REQUEST");
  });

  it("shortens long run ids to reduce local-model path copy mistakes", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "3941c6c1-b865-459d-9d90-7c16a0ea8a76",
    });

    expect(rewrite?.jobId).toBe("qwen_planned_godot_recording_3941c6c1-b865-459d");
    expect(rewrite?.prompt).toContain(
      "/home/node/.openclaw/workspace/jobs/game/results/qwen_planned_godot_recording_3941c6c1-b865-459d/recording.mp4",
    );
  });

  it("can use recent conversation context for execute-only follow-ups", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "Sounds all good. Let's keep the recording no short. A 15 sec recording with 60 fps is good enough. Please execute it.",
      intentPrompt: [
        "Cool, I need you to make a gameplay recording for the Godot auto chess MVP project. What will you do? Just tell me your plan, thanks.",
        "Sounds all good. Let's keep the recording no short. A 15 sec recording with 60 fps is good enough. Please execute it.",
      ].join("\n"),
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "follow-up",
      messageChannel: "telegram",
    });

    expect(rewrite?.packetId).toBe("godotRecording");
    expect(rewrite?.prompt).toContain("Please execute it");
  });

  it("rewrites SEND_RECORDING retries into send-only packets", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "FAILED_PHASE=SEND_RECORDING.\n\nPLANNED_EXECUTION_SEND_ONLY_RETRY job_id=qwen_planned_godot_recording_abc-123",
      intentPrompt:
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "retry-run",
      messageChannel: "telegram",
    });

    expect(rewrite?.packetId).toBe("godotRecording");
    expect(rewrite?.jobId).toBe("qwen_planned_godot_recording_abc-123");
    expect(rewrite?.prompt).toContain("mode: send_recording_only");
    expect(rewrite?.prompt).toContain("Do not start Godot");
    expect(rewrite?.prompt).toContain("Call the message tool to send recording_path");
    expect(rewrite?.prompt).toContain("filePath recording_path");
    expect(rewrite?.prompt).not.toContain("CREATE_REQUEST");
    expect(rewrite?.prompt).not.toContain("POLL_STATUS");
    expect(rewrite?.prompt).not.toContain("Request JSON to create exactly");
    expect(rewrite?.prompt).not.toContain("record_seconds");
  });

  it("rewrites planned SEND_RECORDING phases into send-only packets", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "NEXT_PHASE=SEND_RECORDING.\n\nPLANNED_EXECUTION_SEND_ONLY_PHASE job_id=qwen_planned_godot_recording_abc-123",
      intentPrompt:
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "send-phase-run",
      messageChannel: "telegram",
    });

    expect(rewrite?.packetId).toBe("godotRecording");
    expect(rewrite?.jobId).toBe("qwen_planned_godot_recording_abc-123");
    expect(rewrite?.prompt).toContain("mode: send_recording_only");
    expect(rewrite?.prompt).toContain("Call the message tool to send recording_path");
    expect(rewrite?.prompt).not.toContain("CREATE_REQUEST");
    expect(rewrite?.prompt).not.toContain("POLL_STATUS");
  });

  it("rewrites CREATE_REQUEST retries into create-request-only packets", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt:
        "FAILED_PHASE=CREATE_REQUEST.\n\nPLANNED_EXECUTION_CREATE_REQUEST_ONLY_RETRY job_id=qwen_planned_godot_recording_abc-123",
      intentPrompt:
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "retry-run",
      messageChannel: "telegram",
    });

    expect(rewrite?.packetId).toBe("godotRecording");
    expect(rewrite?.jobId).toBe("qwen_planned_godot_recording_abc-123");
    expect(rewrite?.prompt).toContain("mode: create_request_only");
    expect(rewrite?.prompt).toContain("Call the write/create-file tool");
    expect(rewrite?.prompt).toContain("Any read/exec/process/browser/search/message tool call");
    expect(rewrite?.prompt).toContain("record_seconds\": 15");
    expect(rewrite?.prompt).not.toContain("SEND_RECORDING");
    expect(rewrite?.prompt).not.toContain("POLL_STATUS");
    expect(rewrite?.prompt).not.toContain("Call the message tool");
    expect(rewrite?.prompt).not.toContain("status_path");
    expect(rewrite?.prompt).not.toContain("recording_path");
  });

  it("does not rewrite heartbeat turns using prior Godot recording context", () => {
    const rewrite = resolvePlannedExecutionRewrite({
      prompt: "[OpenClaw heartbeat poll]",
      intentPrompt: [
        "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.",
        "The recording has been sent.",
      ].join("\n"),
      config: qwenConfig,
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "heartbeat-run",
      messageChannel: "heartbeat",
    });

    expect(rewrite).toBeUndefined();
  });

  it("does not rewrite non-matching models and treats an empty packet list as all built-ins", () => {
    const prompt =
      "In my workspace, please find the Godot auto chess MVP project, run gameplay, record a 15-second 60fps video, validate the recording, and send it to me.";
    expect(
      resolvePlannedExecutionRewrite({
        prompt,
        config: qwenConfig,
        agentId: "main",
        provider: "openai-codex",
        modelId: "gpt-5.5",
        runId: "run-a",
      }),
    ).toBeUndefined();

    const rewrite = resolvePlannedExecutionRewrite({
      prompt,
      config: {
        agents: {
          defaults: {
            embeddedPi: {
              plannedExecution: {
                enabled: true,
                models: ["llamacpp/*qwen*"],
                packets: [],
              },
            },
          },
        },
      },
      agentId: "main",
      provider: "llamacpp",
      modelId: "Qwen3.6-35B-A3B-APEX-I-Balanced.gguf",
      runId: "run-b",
    });
    expect(rewrite?.packetId).toBe("godotRecording");
  });
  async function writeGodotRecordingFixture(params?: {
    durationSeconds?: number;
    averageFps?: number;
    effectiveFps?: number;
    jobId?: string;
    omitProbeFile?: boolean;
    requestPatch?: Record<string, unknown>;
  }) {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-planned-exec-"));
    const jobId = params?.jobId ?? "qwen_planned_godot_recording_test-run";
    const resultDir = path.join(workspaceRoot, "jobs", "game", "results", jobId);
    const requestDoneDir = path.join(workspaceRoot, "jobs", "game", "requests_done");
    await mkdir(resultDir, { recursive: true });
    await mkdir(requestDoneDir, { recursive: true });
    const request = {
      job_id: jobId,
      action: "run_and_capture",
      project_path: "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp",
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
      ...(params?.requestPatch ?? {}),
    };
    const probe = {
      duration_seconds: params?.durationSeconds ?? 15.1,
      frame_count: 906,
      average_fps: params?.averageFps ?? 60,
      ...(params?.effectiveFps !== undefined
        ? { effective_fps: params.effectiveFps, effective_frame_count: Math.round(params.effectiveFps * 15) }
        : {}),
    };
    await writeFile(
      path.join(resultDir, "status.json"),
      JSON.stringify({ status: "done", job_id: jobId, video_probe: probe }),
    );
    if (!params?.omitProbeFile) {
      await writeFile(path.join(resultDir, "video_probe.json"), JSON.stringify(probe));
    }
    await writeFile(path.join(resultDir, "recording.mp4"), Buffer.from("fake mp4"));
    await writeFile(path.join(requestDoneDir, `${jobId}.json`), JSON.stringify(request));
    return { workspaceRoot, jobId, resultDir };
  }

  it("finalizes a validated Godot recording into a media reply payload", async () => {
    const fixture = await writeGodotRecordingFixture();

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result?.ok).toBe(true);
    if (result?.ok !== true) {
      throw new Error("expected successful finalizer result");
    }
    expect(result.payload.mediaUrl).toBe(path.join(fixture.resultDir, "recording.mp4"));
    expect(result.payload.text).toContain("15.1s");
    expect(result.probe.averageFps).toBe(60);
  });

  it("does not finalize recordings that are too short", async () => {
    const fixture = await writeGodotRecordingFixture({ durationSeconds: 0.8 });

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId: fixture.jobId,
      reason: "recording_too_short",
    });
  });

  it("does not finalize recordings with low average fps", async () => {
    const fixture = await writeGodotRecordingFixture({ averageFps: 12 });

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId: fixture.jobId,
      reason: "fps_too_low",
    });
  });

  it("does not finalize recordings without video probe facts", async () => {
    const fixture = await writeGodotRecordingFixture({
      omitProbeFile: true,
    });
    const statusPath = path.join(fixture.resultDir, "status.json");
    await writeFile(statusPath, JSON.stringify({ status: "done", job_id: fixture.jobId }));

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId: fixture.jobId,
      reason: "missing_video_probe",
    });
  });

  it("does not finalize recordings with low effective visual fps", async () => {
    const fixture = await writeGodotRecordingFixture({ effectiveFps: 3.7 });

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId: fixture.jobId,
      reason: "effective_fps_too_low",
    });
  });

  it("does not finalize recordings created from a mixed-separator project path", async () => {
    const fixture = await writeGodotRecordingFixture({
      requestPatch: {
        project_path: "D:\\OpenClawWorkspace\\games/roguelike_auto_chess_mvp",
      },
    });

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId: fixture.jobId,
      reason: "request_project_path_mismatch",
    });
  });

  it("canonicalizes existing Godot request artifacts before finalization", async () => {
    const fixture = await writeGodotRecordingFixture({
      requestPatch: {
        project_path: "D:\\OpenClawWorkspace\\games/roguelike_auto_chess_mvp",
      },
    });
    const requestDonePath = path.join(
      fixture.workspaceRoot,
      "jobs",
      "game",
      "requests_done",
      `${fixture.jobId}.json`,
    );

    const canonicalized = await canonicalizeExistingGodotRecordingRequestArtifacts({
      jobId: fixture.jobId,
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(canonicalized.rewrittenPaths).toEqual([requestDonePath]);
    const rewritten = JSON.parse(await readFile(requestDonePath, "utf8"));
    expect(rewritten.project_path).toBe("D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp");

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: fixture.jobId,
      },
      workspaceRoot: fixture.workspaceRoot,
    });

    expect(result?.ok).toBe(true);
  });

  it("waits briefly for pending Godot recording results", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-planned-exec-"));
    const jobId = "qwen_planned_godot_recording_pending";
    const resultDir = path.join(workspaceRoot, "jobs", "game", "results", jobId);
    const requestDoneDir = path.join(workspaceRoot, "jobs", "game", "requests_done");
    await mkdir(resultDir, { recursive: true });
    await mkdir(requestDoneDir, { recursive: true });
    const probe = {
      duration_seconds: 15.2,
      frame_count: 912,
      average_fps: 60,
    };
    setTimeout(() => {
      void Promise.all([
        writeFile(
          path.join(resultDir, "status.json"),
          JSON.stringify({ status: "done", job_id: jobId, video_probe: probe }),
        ),
        writeFile(path.join(resultDir, "video_probe.json"), JSON.stringify(probe)),
        writeFile(path.join(resultDir, "recording.mp4"), Buffer.from("fake mp4")),
        writeFile(
          path.join(requestDoneDir, `${jobId}.json`),
          JSON.stringify({
            job_id: jobId,
            action: "run_and_capture",
            project_path: "D:\\OpenClawWorkspace\\games\\roguelike_auto_chess_mvp",
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
          }),
        ),
      ]);
    }, 25);

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId,
      },
      workspaceRoot,
      waitMs: 1_000,
      pollIntervalMs: 25,
    });

    expect(result?.ok).toBe(true);
    if (result?.ok !== true) {
      throw new Error("expected successful finalizer result");
    }
    expect(result.payload.mediaUrl).toBe(path.join(resultDir, "recording.mp4"));
  });

  it("reports status_not_done for an injected missing-request run", async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-planned-exec-"));
    const jobId = "qwen_planned_godot_recording_missing_request";

    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId,
      },
      workspaceRoot,
      waitMs: 0,
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      jobId,
      reason: "status_not_done",
    });
  });

  it("rejects unsafe Godot recording job ids", async () => {
    const result = await resolvePlannedExecutionFinalizer({
      plannedExecution: {
        packetId: "godotRecording",
        jobId: "../qwen_planned_godot_recording_escape",
      },
      workspaceRoot: await mkdtemp(path.join(os.tmpdir(), "openclaw-planned-exec-")),
    });

    expect(result).toEqual({
      ok: false,
      packetId: "godotRecording",
      reason: "missing_or_unsafe_job_id",
    });
  });

});
