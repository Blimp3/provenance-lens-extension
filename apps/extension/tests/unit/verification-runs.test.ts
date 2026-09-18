import { describe, expect, it } from "vitest";

import { VerificationRunRegistry } from "../../src/verification-runs.js";

describe("verification run registry", () => {
  it("atomically permits one run per tab and keeps it cancellable", () => {
    const registry = new VerificationRunRegistry();
    const first = registry.claim(7);
    expect(first).not.toBeNull();
    expect(registry.claim(7)).toBeNull();
    expect(registry.tabIds()).toEqual([7]);

    expect(registry.abort(7, "cancelled")).toBe(true);
    expect(first?.controller.signal.aborted).toBe(true);
    expect(first?.controller.signal.reason).toBe("cancelled");
  });

  it("releases only the controller that owns the active claim", () => {
    const registry = new VerificationRunRegistry();
    const run = registry.claim(9);
    if (!run) throw new Error("Expected a claimed run");

    expect(registry.release(9, new AbortController())).toBe(false);
    expect(registry.get(9)).toBe(run);
    expect(registry.release(9, run.controller)).toBe(true);
    expect(registry.get(9)).toBeUndefined();
    expect(registry.claim(9)).not.toBeNull();
  });
});
