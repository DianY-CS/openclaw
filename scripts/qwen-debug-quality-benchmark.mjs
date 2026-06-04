#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TURN_ID = "conclusion";

function usage() {
  return `Usage: node scripts/qwen-debug-quality-benchmark.mjs --input <scenario.json> [options]

Scores the debugging-conclusion quality of qwen-godot-recording-scenario output.

Options:
  --input <path>        Scenario JSON produced by qwen-godot-recording-scenario.mjs
  --output <path>       Write JSON benchmark report
  --turn <id>           Turn to score (default: ${DEFAULT_TURN_ID})
  --format <json|text>  Console output format (default: text)
  --help                Show this help
`;
}

function parseArgs(argv) {
  const options = {
    inputPath: "",
    outputPath: "",
    turnId: DEFAULT_TURN_ID,
    format: "text",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(usage());
      process.exit(0);
    } else if (arg === "--input") {
      options.inputPath = path.resolve(readValue());
    } else if (arg === "--output") {
      options.outputPath = path.resolve(readValue());
    } else if (arg === "--turn") {
      options.turnId = readValue();
    } else if (arg === "--format") {
      options.format = readValue();
      if (!["json", "text"].includes(options.format)) {
        throw new Error("--format must be json or text");
      }
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.inputPath) {
    throw new Error("--input is required");
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function textOfTurn(turn) {
  return String(turn?.classification?.payloadText ?? "");
}

function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function countMatches(text, patterns) {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0);
}

function clampScore(value, max) {
  return Math.max(0, Math.min(max, value));
}

function scoreBoolean(value, points) {
  return value ? points : 0;
}

const taskSpecificPatterns = [
  /requests?_done\b/i,
  /requests?_failed\b/i,
  /jobs[\\/]+game[\\/]+results\b/i,
  /results directory/i,
  /recording\.(?:mp4|webm|avi)\b/i,
  /\.mp4\b|\.webm\b|\.avi\b/i,
  /video_probe\.json\b/i,
  /status\.json\b/i,
  /run_log\.txt\b/i,
  /game_host_runner\.(?:err|out)\.log\b/i,
  /windows host runner/i,
  /godot/i,
  /capture region/i,
  /ffmpeg/i,
  /mss\b/i,
  /record_seconds\b/i,
  /fps\b/i,
  /15\s*(?:sec|second)/i,
];

const concreteActionPatterns = [
  /\bcheck\b[^.]{0,120}(?:results|logs|status|video|request)/i,
  /\binspect\b[^.]{0,120}(?:results|logs|status|video|request)/i,
  /\blist\b[^.]{0,120}(?:results|logs|requests)/i,
  /\bopen\b[^.]{0,120}(?:status|log|video_probe|run_log)/i,
  /\bre-submit\b|\brerun\b|\bsubmit\b/i,
  /\bwrite\b[^.]{0,120}(?:error|log|status)/i,
  /\bfix\b|\bchange\b|\bset\b|\bdisable\b|\benable\b/i,
];

const evidencePatterns = [
  /\bknown\b/i,
  /\bevidence\b/i,
  /\bconfirmed\b/i,
  /\bprocessed\b/i,
  /\bcreated\b/i,
  /\bmoved to\b/i,
  /\bexists\b/i,
  /\bwithout error\b/i,
];

const uncertaintyPatterns = [
  /\buncertain\b/i,
  /\bunknown\b/i,
  /\bcannot confirm\b/i,
  /\bmay\b/i,
  /\bpossible\b/i,
  /\blikely\b/i,
  /\bhypothesis\b/i,
];

const badLoopPatterns = [
  /\b(?:let me|i(?:'|’)?ll|i will|i need to|now let me)\s+(?:check|inspect|read|run|look|wait|poll|debug)\b/i,
  /\b(?:next|now)\s+(?:i\s+)?(?:will|should)\s+(?:check|inspect|read|run|look|wait|poll|debug)\b/i,
];

function hasFinalizationFallback(turn) {
  return Boolean(
    turn?.classification?.executionTrace?.attempts?.some(
      (attempt) => attempt.reason === "tool_intent_guardrail_finalization_fallback",
    ),
  );
}

function scoreDebugConclusion(turn) {
  const text = textOfTurn(turn);
  const lower = text.toLowerCase();
  const loopCheckText = text.replace(
    /blocked attempted next step was:\s*"[^"]*"/giu,
    "blocked attempted next step was: <quoted attempted action>",
  );
  const taskSpecificCount = countMatches(text, taskSpecificPatterns);
  const concreteActionCount = countMatches(text, concreteActionPatterns);
  const evidenceCount = countMatches(text, evidencePatterns);
  const uncertaintyCount = countMatches(text, uncertaintyPatterns);
  const hasFallback = hasFinalizationFallback(turn);
  const hasRawGuardrail = lower.includes("tool-intent guardrail:");
  const hasLoopPromise = hasAny(loopCheckText, badLoopPatterns);
  const hasRootCause =
    /\broot cause\b/i.test(text) || /\bhypothesis\b/i.test(text) || /\blikely\b/i.test(text);
  const hasSuggestedFix =
    /\brecommended\b/i.test(text) || /\bsuggested fix\b/i.test(text) || /\bfix\b/i.test(text);
  const hasKnown = /\bknown\b/i.test(text) || /\bwhat i know\b/i.test(text);
  const hasUncertain = /\buncertain\b/i.test(text) || /\bunknown\b/i.test(text);

  const dimensions = {
    completion: {
      max: 20,
      score: clampScore(
        scoreBoolean(turn?.ok, 6) +
          scoreBoolean(text.trim().length >= 180, 4) +
          scoreBoolean(hasRootCause, 5) +
          scoreBoolean(hasSuggestedFix, 5),
        20,
      ),
    },
    evidenceSpecificity: {
      max: 25,
      score: clampScore(taskSpecificCount * 3 + evidenceCount * 2, 25),
      matches: taskSpecificCount,
    },
    diagnosisQuality: {
      max: 25,
      score: clampScore(
        scoreBoolean(hasRootCause, 7) +
          scoreBoolean(hasKnown, 4) +
          scoreBoolean(hasUncertain, 4) +
          concreteActionCount * 3,
        25,
      ),
      actionMatches: concreteActionCount,
    },
    calibration: {
      max: 10,
      score: clampScore(
        scoreBoolean(uncertaintyCount > 0, 4) +
          scoreBoolean(!/definitely|certainly|guaranteed/i.test(text), 3) +
          scoreBoolean(hasKnown && hasUncertain, 3),
        10,
      ),
    },
    finalizationHygiene: {
      max: 20,
      score: clampScore(
        scoreBoolean(!hasRawGuardrail, 6) +
          scoreBoolean(!hasLoopPromise, 6) +
          scoreBoolean(!turn?.classification?.checks?.unresolvedToolIntent, 4) +
          scoreBoolean(!turn?.classification?.checks?.nonAnswer, 2) +
          scoreBoolean(!turn?.process?.timedOut, 2),
        20,
      ),
    },
  };

  let score = Object.values(dimensions).reduce((total, dimension) => total + dimension.score, 0);
  const penalties = [];
  if (hasFallback) {
    score -= 8;
    penalties.push({
      reason: "finalization_fallback",
      points: -8,
      note: "Answer was produced by conservative fallback rather than a normal model conclusion.",
    });
  }
  if (taskSpecificCount < 3) {
    score -= 8;
    penalties.push({
      reason: "low_task_specificity",
      points: -8,
      note: "Conclusion names too few concrete Godot/runner/log/video artifacts.",
    });
  }
  if (concreteActionCount === 0) {
    score -= 6;
    penalties.push({
      reason: "no_concrete_fix_action",
      points: -6,
      note: "Conclusion lacks a concrete next fix/check tied to files or logs.",
    });
  }
  if (hasRawGuardrail) {
    score -= 20;
    penalties.push({
      reason: "raw_guardrail_visible",
      points: -20,
      note: "Guardrail implementation text leaked into the user-visible answer.",
    });
  }
  if (hasLoopPromise) {
    score -= 15;
    penalties.push({
      reason: "unresolved_loop_promise",
      points: -15,
      note: "Conclusion still promises future tool work instead of finalizing.",
    });
  }
  score = clampScore(score, 100);

  return {
    score,
    grade: gradeForScore(score),
    dimensions,
    penalties,
    flags: {
      finalizationFallback: hasFallback,
      rawGuardrailVisible: hasRawGuardrail,
      unresolvedLoopPromise: hasLoopPromise,
      taskSpecificMatches: taskSpecificCount,
      concreteActionMatches: concreteActionCount,
      evidenceMatches: evidenceCount,
      uncertaintyMatches: uncertaintyCount,
    },
    excerpt: text.trim().slice(0, 1200),
  };
}

function gradeForScore(score) {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 55) return "usable";
  if (score >= 40) return "weak";
  return "poor";
}

function summarize(scores) {
  const total = scores.length;
  const average = total
    ? scores.reduce((sum, entry) => sum + entry.score.score, 0) / total
    : 0;
  const sorted = scores.map((entry) => entry.score.score).sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : 0;
  const count = (predicate) => scores.filter(predicate).length;
  const gradeCounts = scores.reduce((counts, entry) => {
    counts[entry.score.grade] = (counts[entry.score.grade] ?? 0) + 1;
    return counts;
  }, {});
  return {
    total,
    average: Number(average.toFixed(2)),
    median,
    min: sorted[0] ?? 0,
    max: sorted[sorted.length - 1] ?? 0,
    gradeCounts,
    finalizationFallback: count((entry) => entry.score.flags.finalizationFallback),
    rawGuardrailVisible: count((entry) => entry.score.flags.rawGuardrailVisible),
    unresolvedLoopPromise: count((entry) => entry.score.flags.unresolvedLoopPromise),
    lowTaskSpecificity: count((entry) => entry.score.flags.taskSpecificMatches < 3),
  };
}

function buildReport(inputPath, data, turnId) {
  const runs = data.results ?? [];
  const entries = runs.map((run) => {
    const turn = (run.turns ?? []).find((candidate) => candidate.id === turnId);
    const score = turn
      ? scoreDebugConclusion(turn)
      : {
          score: 0,
          grade: "poor",
          dimensions: {},
          penalties: [{ reason: "missing_turn", points: -100 }],
          flags: {},
          excerpt: "",
        };
    return {
      runIndex: run.runIndex,
      sessionKey: run.sessionKey,
      scenarioOk: Boolean(run.ok),
      turnOk: Boolean(turn?.ok),
      turnId,
      score,
    };
  });
  return {
    benchmark: "qwen-godot-debug-quality",
    generatedAt: new Date().toISOString(),
    inputPath,
    model: data.model,
    turnId,
    summary: summarize(entries),
    entries,
  };
}

function printText(report) {
  const summary = report.summary;
  process.stdout.write(`qwen-godot-debug-quality benchmark\n`);
  process.stdout.write(`input: ${report.inputPath}\n`);
  process.stdout.write(`model: ${report.model ?? "unknown"}\n`);
  process.stdout.write(`turn: ${report.turnId}\n`);
  process.stdout.write(
    `summary: average=${summary.average} median=${summary.median} min=${summary.min} max=${summary.max} total=${summary.total}\n`,
  );
  process.stdout.write(
    `flags: finalizationFallback=${summary.finalizationFallback} rawGuardrailVisible=${summary.rawGuardrailVisible} unresolvedLoopPromise=${summary.unresolvedLoopPromise} lowTaskSpecificity=${summary.lowTaskSpecificity}\n`,
  );
  process.stdout.write(`grades: ${JSON.stringify(summary.gradeCounts)}\n`);
  for (const entry of report.entries) {
    const flags = entry.score.flags;
    const penaltyText = entry.score.penalties
      .map((penalty) => `${penalty.reason}(${penalty.points})`)
      .join(", ");
    process.stdout.write(
      `run ${entry.runIndex}: score=${entry.score.score} grade=${entry.score.grade} fallback=${Boolean(flags.finalizationFallback)} taskMatches=${flags.taskSpecificMatches ?? 0} actionMatches=${flags.concreteActionMatches ?? 0} penalties=${penaltyText || "none"}\n`,
    );
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const data = readJson(options.inputPath);
  const report = buildReport(options.inputPath, data, options.turnId);
  if (options.outputPath) {
    writeJson(options.outputPath, report);
  }
  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    printText(report);
  }
}

main();
