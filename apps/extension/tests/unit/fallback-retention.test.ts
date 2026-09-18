import { describe, expect, it } from "vitest";

import {
  boundedExpiredIds,
  unretainedIds,
} from "../../src/fallback-retention.js";

describe("fallback retention cleanup", () => {
  it("identifies byte-buffer and screenshot entries no longer represented by history or latest", () => {
    expect(
      unretainedIds(
        ["removed", "latest", "retained"],
        new Set(["latest", "retained"]),
      ),
    ).toEqual(["removed"]);
  });

  it("expires screenshot bindings and removes the oldest overflow", () => {
    expect(
      boundedExpiredIds(
        [
          ["expired", { createdAt: 0 }],
          ["oldest", { createdAt: 9_100 }],
          ["newest", { createdAt: 9_200 }],
        ],
        10_000,
        1_000,
        1,
      ),
    ).toEqual(["expired", "oldest"]);
  });
});
