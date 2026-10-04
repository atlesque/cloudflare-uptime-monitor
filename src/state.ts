// Availability state machine.
//
// Pending -> Up after one success; any state -> Down after two consecutive
// failures; Down -> Up after two consecutive successes.

export type MonitorState = "pending" | "up" | "down";
export type Transition = "down" | "up" | null;

export const FAILURES_FOR_DOWN = 2;
export const SUCCESSES_FOR_UP = 2;

export interface Counters {
  state: MonitorState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

export function applyCheck(prev: Counters, ok: boolean): Counters & { transition: Transition } {
  const consecutiveFailures = ok ? 0 : prev.consecutiveFailures + 1;
  const consecutiveSuccesses = ok ? prev.consecutiveSuccesses + 1 : 0;
  const counters = { consecutiveFailures, consecutiveSuccesses };

  if (prev.state !== "down" && consecutiveFailures >= FAILURES_FOR_DOWN) {
    return { state: "down", ...counters, transition: "down" };
  }
  if (prev.state === "pending" && ok) {
    // First observation of a healthy site; not a recovery, so no transition event.
    return { state: "up", ...counters, transition: null };
  }
  if (prev.state === "down" && consecutiveSuccesses >= SUCCESSES_FOR_UP) {
    return { state: "up", ...counters, transition: "up" };
  }
  return { state: prev.state, ...counters, transition: null };
}
