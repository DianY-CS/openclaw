---
name: componentized-workflow-design
description: Use when designing, extracting, documenting, or reusing OpenClaw workflow components, especially planned-execution or artifact-producing work that involves jobs, artifacts, acceptance criteria, delivery evidence, lifecycle phases, Qwen runtime recovery, finalization, or harness classification.
---

# Componentized Workflow Design

Use this skill to keep workflow logic reusable and correctly layered.

## Read First

- `docs/specs/planned-executor-reusable-components.md`
- `docs/specs/qwen-runtime-extension-structure.md` when touching Qwen runtime or `src/agents/pi-embedded-runner/run.ts`
- `docs/guides/workflow-component-catalog.md` for the current component map
- Scoped `AGENTS.md` files before editing code under a subtree

## First Checks

Before editing, answer:

- Is this an artifact-producing workflow or lifecycle task?
- Which existing component should be reused?
- Does the change belong to a generic component, domain-specific component, runtime adapter, or harness/evidence classifier?
- Can validation be represented as structured criteria?
- Can completion or delivery be represented as structured evidence?
- Would prose or keyword matching create a false positive?

## Reuse Map

- Job, artifact, criteria, validation result -> `src/agents/planned-execution/artifacts.ts`
- Delivery request or delivery evidence -> `src/agents/planned-execution/delivery.ts`
- Generic phase names or compatibility aliases -> `src/agents/planned-execution/phases.ts`
- Godot packet, request, and criteria builders -> `src/agents/planned-execution/godot-recording.ts`
- Qwen runner retry or continuation policy -> `src/agents/pi-embedded-runner/run/planned-execution-control.ts`
- E2E or harness pass/fail classification -> scripts or harness modules, backed by structured evidence

## Design Rules

- Reuse an existing component before adding new logic.
- Add a new generic component only when a proven workflow extraction, second real workflow, or public contract needs it.
- Keep workflow constants, thresholds, packet text, and request fields in domain-specific builders.
- Keep filesystem writes, polling, process starts, channel sends, and session mutation in runtime adapters.
- Do not treat text claims such as "sent", "uploaded", or "recording exists" as delivery success.
- Keep `run.ts` to orchestration, live counters, logging context, and continuation wiring.
- Preserve compatibility aliases with an explicit `compat` status and removal condition.

## Verification

Use `$openclaw-testing` to choose commands.

- Pure helpers need focused unit/static proof.
- Runtime, delivery, external job, finalizer, or harness classifier changes keep E2E or harness proof as the default.
- Use the smallest relevant E2E or harness proof for the touched workflow path.
- State explicitly when a change is helper-only or docs-only and no runtime workflow behavior changed.
