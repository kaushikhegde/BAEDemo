// Failure triage for agent steps: is this worth spending a second agent run on?
//
// The engine's contract before this module was "any non-zero exit blocks the
// issue and waits for a human". That is safe but wrong for the failure that
// actually dominates in practice — a process that never got off the ground
// (binary not on PATH for a moment, API 503, socket hang up). A human is
// woken for something a single retry would have cleared.
//
// The rule here is deliberately asymmetric, because the two mistakes cost
// wildly different amounts:
//
//   retrying something permanent  → a FULL agent run (tens of minutes, real
//                                   money) spent to fail identically
//   blocking something transient  → a human clicks Resume
//
// So a retry has to EARN itself. The gate is not "does the stderr look
// transient" — greps on error text are guesses. It is "did this run spend
// anything". A run that emitted no `result` event has no accounted tokens and
// no accounted cost, and a run that died inside `TRANSIENT_WINDOW_MS` did not
// have time to do work the transcript failed to account for. Retrying such a
// run cannot cost more than the failed spawn did, which is approximately
// nothing. Everything else — including an agent that ran for twenty minutes
// and then exited non-zero on its own terms — blocks, because there the retry
// is the expensive mistake.

import type { RunResult } from "./runner.js";

/**
 * How long a run may have lasted and still be considered "spent nothing".
 *
 * A run can burn tokens and still report `usage: null` — the process is killed
 * before Claude Code emits its final `result` event, so the accounting is lost
 * rather than zero. Wall-clock is the only signal available at that point.
 * Sixty seconds is well past a spawn/auth/handshake failure (sub-second to a
 * few seconds) and well short of any run that has produced work.
 */
export const TRANSIENT_WINDOW_MS = 60_000;

/**
 * Failures that will fail identically next time, no matter how cheap the
 * first attempt was. These are configuration errors, not weather. Retrying
 * costs little here, but it buries the real cause under a duplicate and
 * teaches an operator that the retry line in the log means nothing.
 */
const PERMANENT = [
  /System prompt file not found/i,
  /Unknown skill/i,
  /command not found/i,
  /ENOENT/,
  /invalid api key/i,
  /authentication[_ ]error/i,
  /permission denied/i,
] as const;

export interface FailureVerdict {
  retry: boolean;
  /** Short, human-readable justification — goes verbatim into the issue comment. */
  reason: string;
}

/**
 * Decide whether a failed agent run should be retried once.
 *
 * `elapsedMs` is the engine's own wall-clock measurement around the runner
 * call, NOT `usage.durationMs` — the whole point is to reason about runs that
 * produced no usage record at all.
 */
export function classifyFailure(res: RunResult, elapsedMs: number): FailureVerdict {
  if (res.status === "succeeded") return { retry: false, reason: "succeeded" };

  // A person stopped this. Checked FIRST, and before the transient-window
  // rule in particular: a cancel two seconds in with no `result` event matches
  // "died cheaply, retry it" exactly, so without this branch pressing Cancel
  // would spawn the agent again — the precise opposite of what was asked for,
  // and something that costs a full run to discover.
  if (res.status === "cancelled") {
    return { retry: false, reason: "the run was stopped deliberately — a retry would undo that" };
  }

  // Over budget is the one failure that is definitionally expensive. The
  // ceiling was reached once; a retry reaches it again and bills for it.
  if (res.status === "over_budget") {
    return { retry: false, reason: "the run exceeded its budget — a retry would spend it again" };
  }

  const permanent = PERMANENT.find(p => p.test(res.stderrTail));
  if (permanent) {
    return { retry: false, reason: "the failure is a configuration error, not a transient one" };
  }

  // The run reached its `result` event, so its tokens and cost are accounted
  // for and non-trivial. It ran, and it failed on its own terms.
  if (res.usage !== null) {
    return {
      retry: false,
      reason: "the agent ran to completion and failed on its own terms — a retry would spend a full run",
    };
  }

  if (elapsedMs >= TRANSIENT_WINDOW_MS) {
    return {
      retry: false,
      reason: "the run lasted long enough to have done billable work before dying, so its cost is unknown",
    };
  }

  return {
    retry: true,
    reason: `the run died after ${(elapsedMs / 1000).toFixed(1)}s having accounted for no tokens`,
  };
}
