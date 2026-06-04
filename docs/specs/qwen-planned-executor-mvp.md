# Qwen Planned Executor MVP

## Purpose

OpenClaw should not rely on Qwen to behave like a full senior agent for complex,
multi-step tasks. For Qwen-class local models, OpenClaw should let the senior
planner define a narrow execution packet, then let Qwen execute that packet with
strict phase boundaries, observable success criteria, and recoverable guardrails.

The initial MVP targets the Godot auto chess gameplay recording workflow because
it exercises the failure modes we have observed:

- finding the project in the workspace;
- using the Godot host runner workflow;
- creating a recording request;
- waiting for the host runner result;
- validating `video_probe.json`;
- delivering the recording.

## Implementation Order

1. Implement an OpenClaw planned-executor orchestration MVP.
2. Exercise it with a local harness, without Telegram.
3. Route matching Telegram requests through the orchestration.
4. Replace mock delivery with real Telegram video send.

## Scope

### In Scope

- A configurable agent-level planned execution router for the built-in
  `godotRecording` packet.
- A planner/executor separation where the runtime rewrites matching user
  requests into a fixed executor packet for Qwen.
- Metadata that reports when a planned execution packet was applied.
- Local harness coverage for detection, rewrite, and phase execution outcomes.
- Guardrail behavior that recovers Qwen when it emits phase labels, future-action
  promises, or visible tool-call-shaped text instead of actual tools.

### Out of Scope for This MVP

- General-purpose LangGraph-style orchestration.
- Fully dynamic plan synthesis by GPT-5.5 for arbitrary tasks.
- Multi-agent delegation beyond the existing embedded runner.
- Replacing all skill text with executor packets.
- Guaranteed real Telegram video delivery before the mock delivery phase is
  validated.

## Configuration

The feature is controlled by `agents.defaults.embeddedPi.plannedExecution` and
per-agent overrides:

```json
{
  "agents": {
    "defaults": {
      "embeddedPi": {
        "plannedExecution": {
          "enabled": true,
          "models": ["llamacpp/*qwen*"],
          "packets": ["godotRecording"]
        }
      }
    }
  }
}
```

Expected semantics:

- `enabled`: opt-in switch.
- `models`: model matchers; empty or omitted means all models.
- `packets`: enabled packet ids; empty or omitted means all built-in packets.

## `godotRecording` Packet Contract

The packet should trigger only for execution requests, not plan-only requests.

Examples that should trigger:

- "In my workspace, please find the Godot auto chess MVP project, run gameplay,
  record a 15-second 60fps video, validate the recording, and send it to me."
- Follow-up execution messages when recent context contains the Godot recording
  plan and the user says to execute it.

Examples that should not trigger:

- "What will you do? Just tell me your plan."
- "Do you see a Godot auto chess MVP project? Just let me know whether it's
  there."

When triggered, the runtime rewrites the model prompt into a
`PLANNED_EXECUTION_PACKET` with:

- fixed project, request, result, recording, and probe paths;
- fixed 15 second / 60 fps recording parameters;
- strict sequential phases;
- no visible progress narration;
- final answer schema that starts with `RESPONSE_MODE: final`.

## Phase Model

The current built-in packet uses these phases:

1. `PROJECT_EXISTS`: verify the Godot project path exists.
2. `CREATE_REQUEST`: create the host-runner request JSON.
3. `VALIDATE_REQUEST`: read back and validate the exact request JSON.
4. `POLL_STATUS`: wait for the host runner status file.
5. `VALIDATE_VIDEO`: read and validate `video_probe.json`.
6. `SEND_RECORDING`: send or mock-send the recording.
7. `FINAL`: emit final JSON only after delivery evidence exists.

The executor must not:

- infer job ids from old directories;
- list result directories to choose a job;
- read artifacts in the same turn that creates them;
- claim delivery without delivery evidence;
- restart earlier phases after a guardrail retry.

## Metrics

The MVP should expose enough metadata for local evaluation:

- whether a planned execution packet was applied;
- packet id and job id;
- model/provider used for execution;
- token usage for the executor run when available;
- guardrail detector and retry count when triggered;
- final liveness and replay validity;
- delivery evidence status.

The local harness should continue to record:

- pass/fail/partial outcome;
- request validity;
- recording validity;
- delivery/mock delivery validity;
- unresolved tool intent and recovered tool intent counts;
- duration and token usage when available.

## Acceptance Criteria

### Local Harness

For the Godot recording scenario:

- `CREATE_REQUEST_ONLY`: at least 8/10 success over two 5-run units.
- `WAIT_AND_VALIDATE_RECORDING`: at least 8/10 success over two 5-run units.
- `DELIVER_RECORDING_OR_MOCK_MEDIA`: at least 8/10 success over two 5-run units.
- `FULL_E2E`: at least 16/20 total success, with each adjacent two-unit window
  meeting at least 8/10.

### OpenClaw Runtime

- Matching Qwen Telegram/user requests are rewritten into the planned execution
  packet only when config is enabled.
- Non-Qwen models are not rewritten unless config explicitly matches them.
- Plan-only requests remain plan-only.
- Runtime logs include the packet id and job id when a packet is applied.
- Local config/secrets are not committed.

## Update Policy

If implementation reveals that an assumption in this SPEC is wrong, update this
SPEC in the same commit as the code change. Do not leave the SPEC as a stale
aspirational document.

## Current Status

As of the start of `qwen-planned-executor-mvp`, the repository already contains:

- a configurable `plannedExecution` config surface;
- a `godotRecording` packet generator;
- runtime prompt rewrite in the embedded runner attempt path;
- guardrail detection for future-action prose, phase labels, response modes, and
  tool-call-shaped text;
- local benchmark and harness scripts.

Implemented in this branch so far:

- planned execution packet metadata is propagated into `agentMeta.plannedExecution`;
- `scripts/qwen-planned-executor-harness.mjs --phase rewrite-smoke` provides a
  non-Telegram, non-Godot local exercise path for the OpenClaw rewrite rules;
- matching Telegram/user requests are routed through the same embedded-runner
  rewrite path when `messageChannel` is `telegram` and planned execution config
  matches the active model.

The next step is to validate this through a live Telegram-triggered run, then
replace mock delivery with real Telegram video delivery once the orchestration
path is stable.
