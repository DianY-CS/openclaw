# Qwen Runtime Extension Structure

This note records the structure for Qwen-specific runtime hardening work so new
features do not accumulate inside `src/agents/pi-embedded-runner/run.ts`.

## Principle

Keep `run.ts` as the orchestration loop. It may own the live attempt state,
retry counters, logging context, and `continue` decisions, but reusable policy
or packet-specific rules should live in focused modules.

## Current Boundaries

- `src/agents/planned-execution.ts`
  - Builds planned execution packets from user intent.
  - Owns Godot recording packet text, send-only and create-request-only rewrites,
    finalizer file/probe validation, and deterministic Godot request helpers.

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

## Anti-Patterns

- Adding long regex/policy tables directly to `run.ts`.
- Adding packet-specific instructions directly inside the main attempt loop.
- Creating harness-only behavior in production runtime without a typed module and
  tests.
- Making `run.ts` depend on Godot-specific details beyond calling planned
  execution helpers.
