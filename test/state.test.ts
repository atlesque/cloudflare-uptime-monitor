import { describe, expect, it } from "vitest";
import { applyCheck, type Counters } from "../src/state";

function run(start: Counters["state"], checks: boolean[]) {
  let c: Counters = { state: start, consecutiveFailures: 0, consecutiveSuccesses: 0 };
  const transitions = [];
  for (const ok of checks) {
    const next = applyCheck(c, ok);
    transitions.push(next.transition);
    c = next;
  }
  return { state: c.state, transitions: transitions.filter(Boolean) };
}

describe("availability state machine", () => {
  it("moves Pending to Up on the first success without a recovery event", () => {
    expect(run("pending", [true])).toEqual({ state: "up", transitions: [] });
  });

  it("keeps Pending after one failure and goes Down after two", () => {
    expect(run("pending", [false])).toEqual({ state: "pending", transitions: [] });
    expect(run("pending", [false, false])).toEqual({ state: "down", transitions: ["down"] });
  });

  it("ignores isolated failures while Up", () => {
    expect(run("up", [false, true, false, true])).toEqual({ state: "up", transitions: [] });
  });

  it("goes Down after two consecutive failures, once", () => {
    expect(run("up", [false, false, false, false])).toEqual({ state: "down", transitions: ["down"] });
  });

  it("ignores isolated successes while Down", () => {
    expect(run("down", [true, false, true, false])).toEqual({ state: "down", transitions: [] });
  });

  it("recovers after two consecutive successes, once", () => {
    expect(run("down", [true, true, true])).toEqual({ state: "up", transitions: ["up"] });
  });
});
