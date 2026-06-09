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
- for the current Godot auto chess workflow, request JSON also records
  `planning_stage_seconds = 3` so the recorded 15 seconds is expected to begin
  with planning stage and continue with combat for the remainder
- for the current Godot auto chess workflow, request JSON uses
  `godot_movie = true` with a 1280x720 fixed-FPS movie capture path; the host
  runner transcodes Godot's raw movie output to `recording.mp4` before
  validation and delivery

`average_fps` validates the recorded container/frame cadence. `effective_fps`
is a motion sanity check derived from the host runner's `ffmpeg_mpdecimate`
probe; it is expected to be much lower than 60 fps for mostly static gameplay
or UI captures, so it must not use the same threshold as `average_fps`.

Desktop `gdigrab` capture is retained as a fallback capture strategy, but it
must write frame input/output and duplication evidence into the run log because
Windows desktop/DWM capture can produce a nominal 60 fps file by duplicating a
small number of input frames.

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

### Delivery Final Evidence

Finalization should emit compact structured evidence that binds the completed
job to the accepted artifact and the delivery proof. A channel message id is
useful when it is available, but runtime must not invent one. When the runtime
has already matched delivery state to the artifact path, it may emit
`telegram_delivery.ok: true` without repeating the path; the surrounding final
object still has to name `job_id` and `recording_path`.

Suggested shape:

```ts
type PlannedArtifactDeliveryFinalEvidence = {
  status: "done";
  packet_id?: string;
  job_id: string;
  recording_path: string;
  recording_validated?: boolean;
  video_probe?: Record<string, number>;
  telegram_delivery: {
    ok: true;
    source?: "delivery_evidence" | "messaging_tool_media" | "payload_media";
    path?: string;
    messageId?: string;
    mediaType?: string;
  };
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
  - final delivery evidence text construction that binds job id, artifact path,
    and structured delivery evidence

- `src/agents/planned-execution/phases.ts`
  - generic phase names, aliases, and phase decision helpers
  - compatibility mapping from Godot labels such as `SEND_RECORDING` to generic
    phases such as `DELIVER_ARTIFACT`

- `src/agents/planned-execution/godot-recording.ts`
  - Godot-specific packet construction
  - Godot request validation criteria
  - Godot artifact criteria

- `src/agents/pi-embedded-runner/run/planned-execution-control.ts`
  - runner-facing retry and continuation policy
  - should stay independent of Godot details where possible
  - runtime adapter from captured message-tool delivery state to final evidence
    payloads

- `scripts/lib/planned-execution-lifecycle-evidence.mjs`
  - harness/E2E-facing lifecycle evidence classification
  - structured delivery/finalization proof checks that reject text-only success
    claims
  - accepts message-id proof or path-bound proof, but only when the proof names
    the expected job and artifact

Existing `src/agents/planned-execution.ts` can be split gradually instead of in
one large move.

## Reuse Discovery

Future planned-execution work should start from the existing component map
before adding new workflow logic. A change that creates a job, validates an
artifact, delivers an artifact, finalizes evidence, or classifies harness
success should identify which existing component it reuses.

Use this lookup order:

1. `src/agents/planned-execution/artifacts.ts` for jobs, artifacts, criteria,
   validation results, and pure validation helpers.
2. `src/agents/planned-execution/delivery.ts` for delivery requests, delivery
   evidence, and pure delivery evidence classification.
3. `src/agents/planned-execution/phases.ts` for generic phase names, aliases,
   and phase mapping helpers.
4. `src/agents/planned-execution/godot-recording.ts` for Godot-specific request
   builders, criteria builders, and packet construction.
5. `src/agents/pi-embedded-runner/run/planned-execution-control.ts` for
   runner-facing retry, continuation, and phase policy.

If no existing component fits, the change should state why the behavior is new,
which layer owns it, and whether it is a generic component, a domain-specific
component, a runtime adapter, or a harness/evidence classifier.

## Component Layer Standard

Every reusable planned-execution component should belong to one layer.

- Generic components own framework-agnostic types, criteria, validation
  results, phase aliases, and pure decision helpers.
- Domain-specific components own workflow request shapes, thresholds, packet
  builders, and domain criteria builders.
- Runtime adapters own filesystem writes, process starts, polling, channel API
  calls, delivery attempts, and session mutation.
- Harness/evidence classifiers own pass/fail classification from structured
  evidence and false-positive prevention.

Domain-specific constants must not move into generic types unless they are
genuinely cross-domain. Runtime side effects must not move into generic helper
modules.

## New Component Acceptance

Add a new generic component only when at least one condition is true:

- A proven workflow already uses the behavior and extraction preserves current
  behavior.
- A second real workflow needs the same behavior.
- The behavior is part of the public planned-execution contract and cannot stay
  in a domain-specific builder.

When adding a new component, include:

- the owning layer
- the public functions or types callers should use
- cases where the component should not be used
- structured criteria or evidence shapes when the component validates or
  finalizes behavior
- focused tests for the component boundary

Do not add a generic component only to shorten one workflow. Prefer a
domain-specific builder when the behavior is mostly packet text, thresholds,
request fields, or channel-specific payload details.

## Review Checklist

Before approving planned-execution changes, check:

- The change looked for an existing component before adding new logic.
- New validation is expressed as `ArtifactAcceptanceCriteria` when it can be
  deterministic.
- Completion, delivery, and finalization use structured evidence instead of
  text-only claims.
- `run.ts` changes are limited to orchestration, live counters, logging context,
  and continuation wiring.
- Godot-specific behavior stays in Godot-specific builders or planned-execution
  helpers.
- Telegram or other channel-specific behavior stays behind a delivery adapter
  and returns delivery evidence.
- Harness success classification rejects obvious false positives such as prose
  claims without artifact or delivery evidence.

## Component Maturity

Document reusable components with a maturity label when the distinction affects
future reuse:

- `proven`: protected by focused tests and at least one real workflow or harness
  path.
- `candidate`: extracted from one workflow and reusable, but still allowed to
  change while adoption grows.
- `compat`: kept for older labels or callers, with a stated removal condition.
- `deprecated`: retained only for old behavior and should not be used by new
  code.

Aliases such as `SEND_RECORDING` should remain `compat` until generic
`DELIVER_ARTIFACT` behavior has E2E proof with no delivery regression.

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

Harness and E2E pass/fail decisions should use structured evidence classifiers,
not transcript keywords. Delivery/finalization proof must name the concrete job
and artifact or receipt path where that evidence is available.

### Step 6: Only Then Consider New Workflows

After Godot remains stable, reuse the components for another workflow such as
browser capture, image generation artifact delivery, or document export.

## Testing Requirements

Verification should scale with the changed layer while keeping E2E proof as the
default acceptance gate for workflow-facing behavior.

For each migration step:

- run `node --check` on changed TypeScript and harness files
- run targeted Vitest tests for changed pure modules
- run the smallest relevant Godot planned-executor harness or E2E smoke that
  exercises the touched workflow path
- run Telegram E2E smoke when real Telegram delivery behavior changes and the
  Telegram test environment is available

Suggested acceptance gates:

- unit tests: all pass
- E2E or harness proof: no behavior regression on the touched workflow path
- Telegram smoke: at least one successful run when delivery behavior changed
- before removing aliases: 5-run E2E with no delivery regression

Pure type-only, docs-only, or helper-only changes may use focused unit/static
proof plus an explicit note that no runtime workflow behavior changed. Runtime,
delivery, external job, finalizer, or harness classifier changes should keep E2E
or harness proof as the default.

## Open Questions

- Should delivery evidence be stored in session state, finalizer state, or both?
- Should `WAIT_JOB` be owned by Qwen, by OpenClaw runtime, or by a deterministic
  post-processing finalizer?
- Should artifact criteria be serializable in planned execution packets, or kept
  server-side only?
- How much of the generic phase contract should be visible to Qwen versus kept
  in GPT/planner instructions?
