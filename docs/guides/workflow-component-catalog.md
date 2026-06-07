---
summary: Reusable OpenClaw workflow components, owner layers, maturity labels, and tests.
read_when:
  - Designing or extracting planned-execution workflow components
  - Adding an artifact-producing workflow
  - Reusing artifact criteria, delivery evidence, lifecycle phases, or Qwen runtime policy helpers
title: "Workflow component catalog"
---

# Workflow Component Catalog

This catalog is the first stop before adding planned-execution or other
artifact-producing workflow logic. It lists reusable components, their owner
layer, and the tests that protect the boundary.

Use this catalog together with `docs/specs/planned-executor-reusable-components.md`
and `docs/specs/qwen-runtime-extension-structure.md`.

## Reuse checklist

Before adding workflow logic, identify:

- the existing component being reused
- the owner layer for new logic
- the structured criteria or evidence shape
- the false-positive case that tests or harness proof should reject
- the smallest relevant E2E or harness proof for workflow-facing behavior

## Component maturity

- `proven`: protected by focused tests and at least one real workflow or harness
  path.
- `candidate`: extracted from one workflow and reusable, but still allowed to
  change while adoption grows.
- `compat`: kept for older labels or callers, with a stated removal condition.
- `deprecated`: retained only for old behavior and should not be used by new
  code.

## Planned job, artifact, criteria, and validation

**File**

- `src/agents/planned-execution/artifacts.ts`

**Layer**

- Generic component.

**Maturity**

- `candidate`.

**Purpose**

- Defines planned jobs, expected artifacts, deterministic acceptance criteria,
  validation results, delivery request types, delivery evidence types, and pure
  validation helpers.

**Owns**

- `PlannedJob`
- `PlannedArtifact`
- `ArtifactAcceptanceCriteria`
- `ArtifactValidationResult`
- `ArtifactDeliveryRequest`
- `ArtifactDeliveryEvidence`
- `validateArtifactAcceptanceCriteria`

**Does not own**

- Filesystem polling.
- Request-file writes.
- Process launching.
- Telegram or other channel sends.
- Session mutation.
- Godot-specific thresholds or request fields.

**Use when**

- A workflow creates an external job.
- A workflow expects files or media artifacts.
- Acceptance can be expressed as deterministic criteria over provided facts.

**Do not use when**

- The task is a plain conversational flow.
- The logic depends on live filesystem, process, or channel side effects.

**Reference usage**

- Godot recording criteria builders in
  `src/agents/planned-execution/godot-recording.ts`.

**Testing**

- `src/agents/planned-execution/artifacts.test.ts`

## Artifact delivery evidence

**File**

- `src/agents/planned-execution/delivery.ts`

**Layer**

- Generic component.

**Maturity**

- `candidate`.

**Purpose**

- Builds delivery requests and evidence records, and decides whether an accepted
  artifact still needs delivery based on structured delivery state.

**Owns**

- `PlannedArtifactDeliveryState`
- `classifyPlannedArtifactDeliveryEvidence`
- `isArtifactDeliveryEvidenceOk`
- `hasPlannedArtifactDeliveryEvidence`
- `shouldAttemptArtifactDelivery`
- `buildArtifactDeliveryRequest`
- `buildArtifactDeliveryEvidence`

**Does not own**

- Telegram API calls.
- File uploads.
- Media payload construction.
- Channel credentials.
- Prose-based delivery success classification.

**Use when**

- A workflow must deliver an accepted artifact.
- A finalizer or runner needs to know whether delivery should be attempted or
  retried.

**Do not use when**

- Only artifact validation is needed.
- Delivery success is only a text claim with no structured evidence.

**Reference usage**

- Send phase gates in
  `src/agents/pi-embedded-runner/run/planned-execution-control.ts`.

**Testing**

- `src/agents/planned-execution/delivery.test.ts`

## Planned-execution phases

**File**

- `src/agents/planned-execution/phases.ts`

**Layer**

- Generic component with compatibility aliases.

**Maturity**

- `compat`.

**Purpose**

- Maps existing Godot-specific phase labels to generic lifecycle phases.

**Owns**

- Current phase labels.
- Generic phase labels.
- Compatibility alias mapping.
- Phase comparison helpers.

**Does not own**

- Prompt execution.
- Tool calls.
- Retry side effects.
- Artifact validation or delivery.

**Use when**

- Runtime, prompts, or harnesses need lifecycle-aware phase comparisons.
- New code needs the generic meaning for an older phase label.

**Do not use when**

- The state is not part of planned-execution lifecycle.

**Reference usage**

- `SEND_RECORDING` maps to `DELIVER_ARTIFACT`.
- `VALIDATE_VIDEO` maps to `VALIDATE_ARTIFACT`.

**Testing**

- `src/agents/planned-execution/phases.test.ts`

## Godot recording builder

**File**

- `src/agents/planned-execution/godot-recording.ts`

**Layer**

- Domain-specific component.

**Maturity**

- `proven`.

**Purpose**

- Owns the Godot recording request shape, current thresholds, artifact
  descriptor, and criteria builders for the validated Godot auto chess recording
  workflow.

**Owns**

- Godot project path and scene.
- Current recording duration and fps targets.
- Host-runner request JSON shape.
- Godot request criteria.
- Godot artifact criteria.

**Does not own**

- Generic artifact types.
- Generic delivery evidence.
- Runtime polling.
- Telegram send behavior.

**Use when**

- The workflow intentionally targets the current Godot recording path.
- A test needs the current Godot request or criteria shape.

**Do not use when**

- A new workflow only shares generic artifact mechanics.
- A different media workflow needs different thresholds, paths, or capture
  semantics.

**Reference usage**

- Planned-execution packet and finalizer integration in
  `src/agents/planned-execution.ts`.

**Testing**

- `src/agents/planned-execution/godot-recording.test.ts`

## Qwen planned-execution control

**File**

- `src/agents/pi-embedded-runner/run/planned-execution-control.ts`

**Layer**

- Runtime policy helper.

**Maturity**

- `candidate`.

**Purpose**

- Keeps planned-execution retry, continuation, send-phase, and terminal failure
  policy out of `run.ts`.

**Owns**

- Phase-specific retry instruction construction.
- Terminal planned-execution failure detection.
- Terminal planned-execution error payload construction.
- Create-request retry gate.
- Send-recording phase and retry gates.

**Does not own**

- Live attempt loop orchestration.
- Filesystem or channel side effects.
- Godot request construction.
- Artifact validation helpers.

**Use when**

- Qwen runtime behavior needs planned-execution retry or continuation decisions.
- A change would otherwise add packet-specific policy to `run.ts`.

**Do not use when**

- The logic is generic artifact validation or delivery evidence construction.
- The logic is unrelated to planned execution.

**Reference usage**

- `src/agents/pi-embedded-runner/run.ts` calls this helper for planned-execution
  continuation decisions.

**Testing**

- `src/agents/pi-embedded-runner/run/planned-execution-control.test.ts`
