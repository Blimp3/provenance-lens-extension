import { describe, expect, it } from "vitest";

import {
  samePageBinding,
  type PageSnapshot,
} from "../../src/screenshot-binding.js";

const selected = {
  sourceUrlSha256: "1".repeat(64),
  tagName: "IMG",
  rect: { x: 10, y: 20, width: 300, height: 200 },
};

const base: PageSnapshot = {
  documentMarker: "document-1",
  pageUrlSha256: "a".repeat(64),
  viewportWidth: 1280,
  viewportHeight: 720,
  devicePixelRatio: 2,
  scrollX: 0,
  scrollY: 320,
  selection: selected,
};

const changes: Array<[string, Partial<PageSnapshot>]> = [
  ["document", { documentMarker: "document-2" }],
  ["URL", { pageUrlSha256: "b".repeat(64) }],
  ["viewport width", { viewportWidth: 1024 }],
  ["viewport height", { viewportHeight: 768 }],
  ["device pixel ratio", { devicePixelRatio: 1 }],
  ["horizontal scroll", { scrollX: 12 }],
  ["vertical scroll", { scrollY: 321 }],
  [
    "selected source URL",
    {
      selection: { ...selected, sourceUrlSha256: "2".repeat(64) },
    },
  ],
  [
    "selected rectangle",
    { selection: { ...selected, rect: { ...selected.rect, width: 301 } } },
  ],
];

describe("screenshot fallback page binding", () => {
  it.each(changes)("rejects a changed %s", (_label, change) => {
    expect(samePageBinding(base, { ...base, ...change })).toBe(false);
  });

  it("accepts an unchanged document, viewport, scroll, and selected element", () => {
    expect(samePageBinding(base, { ...base })).toBe(true);
  });
});
