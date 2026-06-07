export const PLANNED_EXECUTION_PHASES = [
  "PROJECT_EXISTS",
  "CREATE_REQUEST",
  "VALIDATE_REQUEST",
  "POLL_STATUS",
  "VALIDATE_VIDEO",
  "SEND_RECORDING",
  "FINAL",
] as const;

export type PlannedExecutionPhase = (typeof PLANNED_EXECUTION_PHASES)[number];

export const GENERIC_PLANNED_EXECUTION_PHASES = [
  "DISCOVER",
  "CREATE_JOB",
  "VALIDATE_JOB_REQUEST",
  "WAIT_JOB",
  "VALIDATE_ARTIFACT",
  "DELIVER_ARTIFACT",
  "FINALIZE",
] as const;

export type GenericPlannedExecutionPhase = (typeof GENERIC_PLANNED_EXECUTION_PHASES)[number];

export const PLANNED_EXECUTION_PHASE_ALIASES = {
  PROJECT_EXISTS: "DISCOVER",
  CREATE_REQUEST: "CREATE_JOB",
  VALIDATE_REQUEST: "VALIDATE_JOB_REQUEST",
  POLL_STATUS: "WAIT_JOB",
  VALIDATE_VIDEO: "VALIDATE_ARTIFACT",
  SEND_RECORDING: "DELIVER_ARTIFACT",
  FINAL: "FINALIZE",
} as const satisfies Record<PlannedExecutionPhase, GenericPlannedExecutionPhase>;

export function isPlannedExecutionPhase(value: string): value is PlannedExecutionPhase {
  return PLANNED_EXECUTION_PHASES.includes(value as PlannedExecutionPhase);
}

export function toGenericPlannedExecutionPhase(
  phase: PlannedExecutionPhase,
): GenericPlannedExecutionPhase {
  return PLANNED_EXECUTION_PHASE_ALIASES[phase];
}

export function phasesShareGenericMeaning(
  left: PlannedExecutionPhase,
  right: PlannedExecutionPhase,
): boolean {
  return toGenericPlannedExecutionPhase(left) === toGenericPlannedExecutionPhase(right);
}
