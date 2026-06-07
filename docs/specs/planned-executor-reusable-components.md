# Planned Executor Reusable Components

## Purpose

This spec defines reusable planner-executor components extracted from the
validated Qwen Godot recording workflow:

1. discover a target project
2. create an external run/capture job
3. wait for job completion
4. validate produced artifacts
5. deliver the accepted artifact
6. finalize with structured evidence

The immediate goal is to reduce Godot-specific logic in runtime orchestration
while preserving the current OpenClaw + Qwen behavior. A secondary goal is to
keep the components framework-agnostic so they can later be mapped to LangGraph
nodes and edges if needed.

## Non-Goals

- Do not replace OpenClaw's current runner loop with LangChain or LangGraph.
- Do not make Qwen a general autonomous planner.
- Do not generalize prompts before the Godot recording workflow remains stable.
- Do not move side effects such as filesystem writes or Telegram sends into
  pure policy modules.

## Current Reference Workflow

The reference implementation is the Godot auto chess recording flow:

- GPT/planner builds a fixed planned execution packet.
- Qwen/executor follows phase-specific instructions.
- A Godot host runner request is written to `jobs/game/requests`.
- The Windows host runner produces `status.json`, `video_probe.json`, and
  `recording.mp4`.
- OpenClaw validates duration and fps.
- OpenClaw sends the recording through Telegram or mock media delivery.
- Finalization reports whether the artifact met acceptance criteria.

## Core Abstractions

### Planned Job

A planned job describes an external side-effectful task.

Suggested shape:

```ts
type PlannedJob = {
  jobId: string;
  kind: string;
  requestPath: string;
  resultDir: string;
  statusPath: string;
  timeoutSeconds: number;
  expectedArtifacts: PlannedArtifact[];
  acceptanceCriteria: ArtifactAcceptanceCriteria[];
};
```

Godot-specific fields, such as `projectPath`, `scene`, `recordSeconds`, and
`recordFps`, should live in the job payload or criteria, not in the generic job
type.

### Planned Artifact

A planned artifact describes a file or media item expected from a job.

Suggested shape:

```ts
type PlannedArtifact = {
  id: string;
  kind: "video" | "image" | "json" | "file";
  path: string;
  probePath?: string;
  required: boolean;
};
```

### Artifact Acceptance Criteria

Criteria are deterministic checks over files, probes, or status JSON.

Suggested shape:

```ts
type ArtifactAcceptanceCriteria =
  | { kind: "file_exists"; artifactId: string }
  | { kind: "video_duration_seconds"; artifactId: string; min: number }
  | { kind: "video_average_fps"; artifactId: string; min: number }
  | { kind: "video_effective_fps"; artifactId: string; min: number }
  | { kind: "json_field_equals"; path: string; field: string; value: unknown };
```

The Godot workflow should express its current video checks as criteria:

- `recording.mp4` exists
- `duration_seconds >= 14.5`
- `average_fps >= 55`
- `effective_fps >= 10` when the host runner reports `effective_fps`
- request JSON matches the expected project, scene, duration, fps, and capture
  settings

`average_fps` validates the recorded container/frame cadence. `effective_fps`
is a motion sanity check derived from the host runner's `ffmpeg_mpdecimate`
probe; it is expected to be much lower than 60 fps for mostly static gameplay
or UI captures, so it must not use the same threshold as `average_fps`.

### Artifact Validation Result

Validation should return structured evidence instead of prose.

Suggested shape:

```ts
type ArtifactValidationResult = {
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
```

### Delivery Request

Delivery should be generic over channels and artifacts.

Suggested shape:

```ts
type ArtifactDeliveryRequest = {
  artifact: PlannedArtifact;
  channel: "telegram" | "mock" | "local";
  target?: string;
  caption?: string;
  deliveryMode: "real" | "mock";
};
```

### Delivery Evidence

Delivery must return proof that finalization can inspect.

Suggested shape:

```ts
type ArtifactDeliveryEvidence = {
  ok: boolean;
  artifactId: string;
  channel: string;
  mode: "real" | "mock";
  messageId?: string;
  mediaType?: string;
  path?: string;
  error?: string;
};
```

## Phase Contract

Use generic phase names for reusable components while preserving packet-specific
instructions where needed:

1. `DISCOVER`
2. `CREATE_JOB`
3. `VALIDATE_REQUEST`
4. `WAIT_JOB`
5. `VALIDATE_ARTIFACT`
6. `DELIVER_ARTIFACT`
7. `FINALIZE`

For compatibility, existing Godot labels such as `CREATE_REQUEST`,
`POLL_STATUS`, `VALIDATE_VIDEO`, and `SEND_RECORDING` may remain as aliases
during migration.

Each phase must define:

- required input state
- allowed tools or side effects
- success evidence
- retryable failures
- terminal failures
- retry instruction text
- finalizer behavior

## Module Boundaries

Recommended modules:

- `src/agents/planned-execution/artifacts.ts`
  - planned job, artifact, criteria, validation, and delivery evidence types
  - pure validation helpers

- `src/agents/planned-execution/delivery.ts`
  - artifact delivery request/evidence helpers
  - pure delivery attempt and evidence classification

- `src/agents/planned-execution/phases.ts`
  - generic phase names, aliases, and phase decision helpers

- `src/agents/planned-execution/godot-recording.ts`
  - Godot-specific packet construction
  - Godot request validation criteria
  - Godot artifact criteria

- `src/agents/pi-embedded-runner/run/planned-execution-control.ts`
  - runner-facing retry and continuation policy
  - should stay independent of Godot details where possible

Existing `src/agents/planned-execution.ts` can be split gradually instead of in
one large move.

## Side-Effect Boundary

Pure modules may inspect and classify data but should not directly:

- call tools
- write request files
- poll the filesystem
- send Telegram messages
- mutate session state

Side effects remain in OpenClaw runtime adapters, tool calls, harnesses, or
explicit delivery adapters.

## LangGraph Compatibility Constraint

Components should be usable without LangGraph today, but easy to map later:

- `PlannedJob` and validation state should become graph state.
- each phase decision helper should be usable as a conditional edge.
- each side-effect adapter should be wrappable as a graph node.
- no pure helper should depend on `run.ts` local variables or OpenClaw session
  internals.

Possible future mapping:

- `CREATE_JOB` -> LangGraph node that writes a request through an adapter
- `WAIT_JOB` -> node that polls status through an adapter
- `VALIDATE_ARTIFACT` -> pure validation node
- `DELIVER_ARTIFACT` -> node that calls a delivery adapter
- `FINALIZE` -> terminal node with evidence summary

## Migration Plan

### Step 1: Add Types and Pure Helpers

Create artifact/job/criteria types and pure validation helpers. Add tests that
cover file existence, video duration, fps, and structured failure output.

No runtime behavior should change in this step.

### Step 2: Express Godot Acceptance Criteria

Move Godot video acceptance checks into criteria builders. Keep current
thresholds:

- duration seconds: minimum `14.5`
- average fps: minimum `55`
- effective fps, when available: minimum `10`

### Step 3: Adapt the Existing Finalizer

Make the Godot planned execution finalizer call the generic validation helpers
while preserving its current public result shape.

Harness output should remain comparable with current reports.

### Step 4: Generalize Delivery Evidence

Rename concepts internally from `SEND_RECORDING` toward
`DELIVER_ARTIFACT`, but keep the old phase label as an alias until E2E tests
show no regression.

### Step 5: Update Harness Classification

Update Qwen planned-executor harnesses to report generic artifact lifecycle
evidence:

- job created
- request valid
- job done
- artifact valid
- delivery evidence present
- finalization correct

### Step 6: Only Then Consider New Workflows

After Godot remains stable, reuse the components for another workflow such as
browser capture, image generation artifact delivery, or document export.

## Testing Requirements

For each migration step:

- run `node --check` on changed TypeScript and harness files
- run targeted Vitest tests for pure modules
- run the Godot planned-executor harness
- run Telegram E2E smoke when the Telegram test environment is available

Suggested acceptance gates:

- unit tests: all pass
- local harness: no behavior regression
- Telegram smoke: at least one successful run
- before removing aliases: 5-run E2E with no delivery regression

## Open Questions

- Should delivery evidence be stored in session state, finalizer state, or both?
- Should `WAIT_JOB` be owned by Qwen, by OpenClaw runtime, or by a deterministic
  post-processing finalizer?
- Should artifact criteria be serializable in planned execution packets, or kept
  server-side only?
- How much of the generic phase contract should be visible to Qwen versus kept
  in GPT/planner instructions?
