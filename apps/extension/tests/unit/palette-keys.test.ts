import { describe, expect, it } from "vitest";

import {
  nextTabStop,
  paletteKey,
  type PaletteKeyEvent,
  type PaletteKeyState,
} from "../../src/ui/palette-commands.js";

function key(
  keyName: string,
  code: string,
  overrides: Partial<PaletteKeyEvent> = {},
): PaletteKeyEvent {
  return {
    key: keyName,
    code,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    isTrusted: true,
    repeat: false,
    ...overrides,
  };
}

const ROOT: PaletteKeyState = { actionsOpen: false, query: "", depth: 0 };

describe("palette keys", () => {
  it("runs row N for ⌥1–⌥9 by the physical key, whatever the layout types", () => {
    expect(paletteKey(key("¡", "Digit1", { altKey: true }), ROOT)).toEqual({
      type: "digit",
      index: 0,
    });
    expect(paletteKey(key("«", "Digit1", { altKey: true }), ROOT)).toEqual({
      type: "digit",
      index: 0,
    });
    expect(paletteKey(key("9", "Numpad9", { altKey: true }), ROOT)).toEqual({
      type: "digit",
      index: 8,
    });
    expect(paletteKey(key("º", "Digit0", { altKey: true }), ROOT).type).toBe(
      "none",
    );
    expect(paletteKey(key("1", "Digit1"), ROOT).type).toBe("none");
  });

  it("runs a held ↵ or ⌥digit once, never for its auto-repeat", () => {
    expect(paletteKey(key("Enter", "Enter", { repeat: true }), ROOT)).toEqual({
      type: "repeat",
    });
    expect(
      paletteKey(key("¡", "Digit1", { altKey: true, repeat: true }), ROOT),
    ).toEqual({ type: "repeat" });
    // A held arrow keeps moving.
    expect(
      paletteKey(key("ArrowDown", "ArrowDown", { repeat: true }), ROOT),
    ).toEqual({ type: "move", delta: 1 });
  });

  it("leaves ⌥digit with Shift, Ctrl or Meta alone", () => {
    for (const extra of [
      { shiftKey: true },
      { ctrlKey: true },
      { metaKey: true },
    ])
      expect(
        paletteKey(key("1", "Digit1", { altKey: true, ...extra }), ROOT).type,
      ).toBe("none");
  });

  it("takes one Esc step per press: actions, query, back, close", () => {
    const esc = key("Escape", "Escape");
    expect(
      paletteKey(esc, { actionsOpen: true, query: "x", depth: 2 }),
    ).toEqual({ type: "escape", step: "close-actions" });
    expect(
      paletteKey(esc, { actionsOpen: false, query: "x", depth: 2 }),
    ).toEqual({ type: "escape", step: "clear-query" });
    expect(
      paletteKey(esc, { actionsOpen: false, query: "", depth: 2 }),
    ).toEqual({ type: "escape", step: "back" });
    expect(paletteKey(esc, ROOT)).toEqual({ type: "escape", step: "close" });
  });

  it("ignores events the page synthesised", () => {
    for (const event of [
      key("Escape", "Escape"),
      key("Enter", "Enter"),
      key("1", "Digit1", { altKey: true }),
      key("k", "KeyK", { metaKey: true }),
      key("Tab", "Tab"),
    ])
      expect(paletteKey({ ...event, isTrusted: false }, ROOT)).toEqual({
        type: "none",
      });
  });

  it("leaves Enter, arrows, Esc and ⌥digit to the IME while it composes", () => {
    for (const composing of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const event of [
        key("Enter", "Enter"),
        key("ArrowDown", "ArrowDown"),
        key("Escape", "Escape"),
        key("1", "Digit1", { altKey: true }),
      ])
        expect(paletteKey({ ...event, ...composing }, ROOT).type).toBe("none");
    }
    // Focus still never leaves the frame.
    expect(paletteKey(key("Tab", "Tab", { keyCode: 229 }), ROOT)).toEqual({
      type: "tab",
      backward: false,
    });
  });

  it("moves with the arrows and ⌃N/⌃P, and jumps with ⌘↑/⌘↓", () => {
    expect(paletteKey(key("ArrowDown", "ArrowDown"), ROOT)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(paletteKey(key("ArrowUp", "ArrowUp"), ROOT)).toEqual({
      type: "move",
      delta: -1,
    });
    expect(paletteKey(key("n", "KeyN", { ctrlKey: true }), ROOT)).toEqual({
      type: "move",
      delta: 1,
    });
    expect(paletteKey(key("p", "KeyP", { ctrlKey: true }), ROOT)).toEqual({
      type: "move",
      delta: -1,
    });
    expect(
      paletteKey(key("ArrowDown", "ArrowDown", { metaKey: true }), ROOT),
    ).toEqual({ type: "edge", edge: "last" });
    expect(
      paletteKey(key("ArrowUp", "ArrowUp", { metaKey: true }), ROOT),
    ).toEqual({ type: "edge", edge: "first" });
    expect(
      paletteKey(key("ArrowDown", "ArrowDown", { shiftKey: true }), ROOT).type,
    ).toBe("none");
    expect(paletteKey(key("Home", "Home"), ROOT).type).toBe("none");
  });

  it("opens the action panel with ⌘K or Ctrl+K and runs a row with ↵", () => {
    expect(paletteKey(key("k", "KeyK", { metaKey: true }), ROOT)).toEqual({
      type: "actions",
    });
    expect(paletteKey(key("k", "KeyK", { ctrlKey: true }), ROOT)).toEqual({
      type: "actions",
    });
    expect(
      paletteKey(key("K", "KeyK", { metaKey: true, shiftKey: true }), ROOT)
        .type,
    ).toBe("none");
    expect(paletteKey(key("Enter", "Enter"), ROOT)).toEqual({ type: "run" });
    expect(
      paletteKey(key("Enter", "Enter", { metaKey: true }), ROOT).type,
    ).toBe("none");
  });

  it("goes back with ⌫ only on an empty input below the root", () => {
    const backspace = key("Backspace", "Backspace");
    expect(
      paletteKey(backspace, { actionsOpen: false, query: "", depth: 1 }),
    ).toEqual({ type: "back" });
    expect(paletteKey(backspace, ROOT).type).toBe("none");
    expect(
      paletteKey(backspace, { actionsOpen: false, query: "a", depth: 1 }).type,
    ).toBe("none");
  });

  it("traps Tab and ⇧Tab inside the frame", () => {
    expect(paletteKey(key("Tab", "Tab"), ROOT)).toEqual({
      type: "tab",
      backward: false,
    });
    expect(paletteKey(key("Tab", "Tab", { shiftKey: true }), ROOT)).toEqual({
      type: "tab",
      backward: true,
    });
    expect(nextTabStop(0, 2, false)).toBe(1);
    expect(nextTabStop(1, 2, false)).toBe(0);
    expect(nextTabStop(0, 2, true)).toBe(1);
    expect(nextTabStop(0, 1, false)).toBe(0);
    expect(nextTabStop(-1, 3, false)).toBe(0);
    expect(nextTabStop(-1, 3, true)).toBe(2);
    expect(nextTabStop(0, 0, false)).toBe(-1);
  });
});
