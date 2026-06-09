# Qwen Runtime Extension Structure

This note records the structure for Qwen-specific runtime hardening work so new
features do not accumulate inside `src/agents/pi-embedded-runner/run.ts`.

## Principle

Keep `run.ts` as the orchestration loop. It may own the live attempt state,
retry counters, logging context, and `continue` decisions, but reusable policy
or packet-specific rules should live in focused modules.

New Qwen runtime work should first check whether the behavior belongs to an
existing planned-execution component. Reuse the component when the behavior is
job creation, artifact validation, delivery evidence, phase mapping, retry
policy, or harness classification. Add a new helper only when the behavior has a
clear owner layer and cannot stay in an existing component or a domain-specific
builder.

## Current Boundaries

- `src/agents/planned-execution.ts`
  - Builds planned execution packets from user intent.
  - Owns Godot recording packet text, send-only and create-request-only rewrites,
    finalizer file/probe validation, and deterministic Godot request helpers.

- `src/agents/planned-execution/godot-recording.ts`
  - Owns the current Godot recording domain contract.
  - For `roguelike_auto_chess_mvp`, the stable recording shape is
    `godot_movie: true`, `record_width: 1280`, `record_height: 720`,
    `startup_wait_seconds: 1`, `planning_stage_seconds: 3`, `record_seconds:
    15`, and `record_fps: 60`.
  - Runtime should consume this contract through request builders and artifact
    criteria instead of duplicating those Godot-specific values in `run.ts`.

- `src/agents/pi-embedded-runner/run/planned-execution-control.ts`
  - Owns planned execution control policy used by the runner loop.
  - Builds phase retry instructions.
  - Decides whether to enter `SEND_RECORDING` phase or retry delivery.
  - Decides whether `CREATE_REQUEST` should be retried.
  - Converts terminal planned execution failures into user-visible error
    payloads.

- `src/agents/pi-embedded-runner/run.ts`
  - Owns the live run loop and integrates modules.
  - May increment retry counters and choose `continue`, but should call helper
    modules for phase/policy decisions.
  - Should not grow packet-specific policy tables, long regex checks, delivery
    success heuristics, or Godot-specific validation.

- `scripts/qwen-*.mjs`
  - Harnesses, smoke tests, and benchmark drivers.
  - Should stay out of production runtime paths unless their logic is promoted
    into a typed module with tests.

## Adding New Features

When adding a Qwen guardrail, planned execution phase, or executor recovery path:

1. Put pure decision logic in a module under `src/agents/pi-embedded-runner/run/`
   or `src/agents/planned-execution*.ts`.
2. Keep model/provider config parsing in config modules.
3. Keep `run.ts` changes to wiring, state counters, logs, and continuation.
4. Add targeted tests for the extracted decision module.
5. Run `node --check` on changed TypeScript files and the relevant Vitest files.
6. Run the smallest relevant E2E or harness proof for workflow-facing runtime
   behavior.

Before adding new runtime logic, answer:

- Which existing planned-execution component was reused?
- If none was reused, why does the behavior need a new component?
- Is the new logic generic, domain-specific, runtime adapter, or
  harness/evidence classifier logic?
- Can the result be represented as structured criteria or structured evidence?
- What false-positive path would incorrectly pass if this logic used prose or
  keyword matching?

Pure helper-only or docs-only changes can stop at focused static/unit proof when
they do not change runtime workflow behavior. Runtime continuation, external job,
delivery, finalization, or harness classification changes should keep E2E or
harness proof as the default.

## `run.ts` Change Budget

Use `run.ts` for:

- passing prepared facts into helper modules
- updating live attempt state and retry counters
- recording log context
- wiring helper decisions into `continue`, retry, or final response behavior

Move logic out of `run.ts` when it:

- interprets a planned-execution phase
- decides whether an artifact or request is valid
- decides whether delivery succeeded
- builds retry instruction text
- maps old phase labels to generic lifecycle phases
- classifies harness or finalizer success
- depends on Godot, Telegram, or another packet-specific domain

## Anti-Patterns

- Adding long regex/policy tables directly to `run.ts`.
- Adding packet-specific instructions directly inside the main attempt loop.
- Creating harness-only behavior in production runtime without a typed module and
  tests.
- Making `run.ts` depend on Godot-specific details beyond calling planned
  execution helpers.
- Treating text claims such as "sent", "uploaded", or "recording exists" as
  delivery success without structured evidence.
