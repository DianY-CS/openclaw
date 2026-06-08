import { describe, expect, it } from "vitest";

import {
  isPlannedExecutionPhase,
  phasesShareGenericMeaning,
  PLANNED_EXECUTION_PHASES,
  toGenericPlannedExecutionPhase,
} from "./phases.js";

describe("planned execution phases", () => {
  it("keeps the current Godot phase labels stable", () => {
    expect(PLANNED_EXECUTION_PHASES).toEqual([
      "PROJECT_EXISTS",
      "CREATE_REQUEST",
      "VALIDATE_REQUEST",
      "POLL_STATUS",
      "VALIDATE_VIDEO",
      "SEND_RECORDING",
      "FINAL",
    ]);
  });

  it("maps current Godot phase aliases to generic lifecycle phases", () => {
    expect(toGenericPlannedExecutionPhase("PROJECT_EXISTS")).toBe("DISCOVER");
    expect(toGenericPlannedExecutionPhase("CREATE_REQUEST")).toBe("CREATE_JOB");
    expect(toGenericPlannedExecutionPhase("VALIDATE_REQUEST")).toBe("VALIDATE_JOB_REQUEST");
    expect(toGenericPlannedExecutionPhase("POLL_STATUS")).toBe("WAIT_JOB");
    expect(toGenericPlannedExecutionPhase("VALIDATE_VIDEO")).toBe("VALIDATE_ARTIFACT");
    expect(toGenericPlannedExecutionPhase("SEND_RECORDING")).toBe("DELIVER_ARTIFACT");
    expect(toGenericPlannedExecutionPhase("FINAL")).toBe("FINALIZE");
  });

  it("identifies supported current phase labels", () => {
    expect(isPlannedExecutionPhase("SEND_RECORDING")).toBe(true);
    expect(isPlannedExecutionPhase("DELIVER_ARTIFACT")).toBe(false);
  });

  it("can compare phases by their generic lifecycle meaning", () => {
    expect(phasesShareGenericMeaning("SEND_RECORDING", "SEND_RECORDING")).toBe(true);
    expect(phasesShareGenericMeaning("SEND_RECORDING", "VALIDATE_VIDEO")).toBe(false);
  });
});
