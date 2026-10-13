import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOwnPalettePort,
  isPalettePortName,
  mountPaletteHost,
  PALETTE_READY_TIMEOUT_MS,
  palettePortName,
} from "../../src/palette-host.js";

const TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const ORIGIN = "chrome-extension://test";
const FRAME_URL = `${ORIGIN}/palette.html#t=${TOKEN}`;

type FakePort = {
  name: string;
  disconnect: ReturnType<typeof vi.fn>;
  onDisconnect: { addListener: ReturnType<typeof vi.fn> };
};

let ports: FakePort[];
let shadows: ShadowRoot[];

function hostRoot(): HTMLElement | null {
  return document.querySelector("[data-provenance-lens-palette]");
}

function frameOf(index = shadows.length - 1): HTMLIFrameElement {
  const frame = shadows[index]?.querySelector("iframe");
  if (!frame) throw new Error("no palette frame");
  return frame;
}

/**
 * jsdom gives a frame inside a shadow root no window, so each palette frame
 * borrows one from a frame in the light DOM.
 */
function frameWindow(): Window {
  const frame = frameOf();
  if (!frame.contentWindow) {
    const stand = document.createElement("iframe");
    document.body.append(stand);
    const window = stand.contentWindow;
    Object.defineProperty(frame, "contentWindow", {
      configurable: true,
      get: () => window,
    });
  }
  return frame.contentWindow as Window;
}

function post(
  data: unknown,
  source: MessageEventSource | null = frameWindow(),
  origin = ORIGIN,
): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

function disconnectPort(port: FakePort | undefined): void {
  const listener = port?.onDisconnect.addListener.mock.calls[0]?.[0] as
    (() => void) | undefined;
  listener?.();
}

beforeEach(() => {
  ports = [];
  shadows = [];
  const attachShadow = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "attachShadow",
  )?.value as (this: Element, init: ShadowRootInit) => ShadowRoot;
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    const shadow = attachShadow.call(this, init);
    shadows.push(shadow);
    return shadow;
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        connect: vi.fn(({ name }: { name: string }) => {
          const port: FakePort = {
            name,
            disconnect: vi.fn(),
            onDisconnect: { addListener: vi.fn() },
          };
          ports.push(port);
          return port;
        }),
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  hostRoot()?.remove();
  delete (globalThis as Record<string, unknown>)["__provenanceLensPaletteHost"];
  delete (document as { fullscreenElement?: unknown }).fullscreenElement;
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
  document.body.replaceChildren();
});

/** jsdom has no popovers: these record each call and track which are open. */
function stubPopovers(): {
  calls: string[];
} {
  const calls: string[] = [];
  const open = new WeakSet<Element>();
  Object.defineProperty(HTMLElement.prototype, "showPopover", {
    configurable: true,
    value(this: HTMLElement) {
      if (open.has(this)) throw new DOMException("already open");
      open.add(this);
      calls.push("show");
    },
  });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", {
    configurable: true,
    value(this: HTMLElement) {
      open.delete(this);
      calls.push("hide");
    },
  });
  const matches = Object.getOwnPropertyDescriptor(Element.prototype, "matches")
    ?.value as (this: Element, selector: string) => boolean;
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ":popover-open"
      ? open.has(this)
      : matches.call(this, selector);
  });
  return { calls };
}

describe("palette port names", () => {
  it("carry the token, so each palette keeps its own port", () => {
    expect(palettePortName(TOKEN)).toBe(`lens-palette:${TOKEN}`);
    expect(isPalettePortName(palettePortName(TOKEN))).toBe(true);
    expect(isPalettePortName("lens-picker")).toBe(false);
    expect(isOwnPalettePort({ name: palettePortName(TOKEN) }, TOKEN)).toBe(
      true,
    );
    expect(
      isOwnPalettePort(
        { name: palettePortName("223e4567-e89b-42d3-a456-426614174000") },
        TOKEN,
      ),
    ).toBe(false);
  });
});

describe("the palette host", () => {
  it("mounts a closed shadow frame and opens its own port once the frame is ready", async () => {
    const opened = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    const root = hostRoot();
    expect(root?.getAttribute("popover")).toBe("manual");
    expect(root?.style.getPropertyPriority("z-index")).toBe("important");
    expect(root?.style.getPropertyValue("color-scheme")).toBe("light dark");
    expect(root?.shadowRoot).toBeNull();
    expect(frameOf().getAttribute("src")).toBe(FRAME_URL);
    expect(frameOf().title).toBe("Provenance Lens");
    expect(chrome.runtime.connect).not.toHaveBeenCalled();

    post({ lens: "ready" });

    await expect(opened).resolves.toEqual({ status: "ready" });
    expect(chrome.runtime.connect).toHaveBeenCalledWith({
      name: palettePortName(TOKEN),
    });
    expect(shadows[0]?.activeElement).toBe(frameOf());
  });

  it("ignores messages from another window or origin", async () => {
    vi.useFakeTimers();
    const opened = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" }, window);
    post({ lens: "ready" }, frameWindow(), "https://example.com");
    post("ready");

    vi.advanceTimersByTime(PALETTE_READY_TIMEOUT_MS);
    await expect(opened).resolves.toEqual({ status: "timeout" });
    expect(chrome.runtime.connect).not.toHaveBeenCalled();
    expect(hostRoot()).toBeNull();
  });

  it("removes itself when the frame is not ready within 1.5 s", async () => {
    vi.useFakeTimers();
    let status: string | undefined;
    void mountPaletteHost(FRAME_URL, TOKEN, PALETTE_READY_TIMEOUT_MS).then(
      (result) => (status = result.status),
    );
    vi.advanceTimersByTime(PALETTE_READY_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(status).toBeUndefined();
    expect(hostRoot()).not.toBeNull();

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(status).toBe("timeout"));
    expect(hostRoot()).toBeNull();
  });

  it("closes the open palette on the second press instead of mounting another", async () => {
    const first = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await first;

    await expect(mountPaletteHost(FRAME_URL, TOKEN, 1_500)).resolves.toEqual({
      status: "closed",
    });
    expect(hostRoot()).toBeNull();
    expect(ports[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(shadows).toHaveLength(1);
  });

  it("closes when the frame asks or the port ends", async () => {
    const first = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await first;
    post({ lens: "close" });
    expect(hostRoot()).toBeNull();

    const second = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await second;
    disconnectPort(ports[1]);
    expect(hostRoot()).toBeNull();
  });

  it("returns focus once when the page takes it, then leaves focus alone", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    const opened = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await opened;
    expect(shadows[0]?.activeElement).toBe(frameOf());

    field.focus();
    expect(shadows[0]?.activeElement).toBe(frameOf());

    field.focus();
    expect(document.activeElement).toBe(field);
  });

  it("gives focus back to the element that had it before the palette", async () => {
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    const opened = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await opened;
    expect(document.activeElement).not.toBe(field);

    post({ lens: "close" });
    expect(document.activeElement).toBe(field);
  });

  it("closes when the tab is hidden", async () => {
    const opened = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await opened;
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    hidden.mockRestore();
    expect(hostRoot()).toBeNull();
  });
});

describe("the palette host's mount rule", () => {
  // jsdom has no hit testing; each test says what lies at the top left.
  let topLeft: Element | null = null;
  beforeEach(() => {
    topLeft = null;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => topLeft,
    });
  });
  afterEach(() => {
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  function fullscreen(element: Element): void {
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => element,
    });
  }

  it("mounts on the document by default", () => {
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
  });

  it("mounts inside a fullscreen element that can hold it", () => {
    const player = document.createElement("div");
    document.body.append(player);
    fullscreen(player);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(player);
  });

  it("does not mount inside a fullscreen video", () => {
    const video = document.createElement("video");
    document.body.append(video);
    fullscreen(video);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
  });

  /** jsdom has no showModal, so these dialogs match dialog:modal by hand. */
  function openModal(...dialogs: Element[]): Set<Element> {
    const open = new Set<Element>(dialogs);
    const nearestOpen = (start: Element): Element | null => {
      let node: Element | null = start;
      while (node && !open.has(node)) node = node.parentElement;
      return node;
    };
    const closest = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "closest",
    )?.value as (this: Element, selector: string) => Element | null;
    vi.spyOn(Element.prototype, "closest").mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      if (selector !== "dialog:modal") return closest.call(this, selector);
      return nearestOpen(this);
    });
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(
      (selector: string) =>
        selector === "dialog:modal"
          ? (Array.from(querySelectorAll("dialog")).filter((dialog) =>
              open.has(dialog),
            ) as unknown as NodeListOf<Element>)
          : querySelectorAll(selector),
    );
    return open;
  }

  function dialogWithButton(): [HTMLDialogElement, HTMLButtonElement] {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    const button = document.createElement("button");
    dialog.append(button);
    return [dialog, button];
  }

  it("mounts inside the last modal dialog when none holds focus or hit-tests", () => {
    const first = document.createElement("dialog");
    const top = document.createElement("dialog");
    document.body.append(first, top);
    openModal(first, top);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(top);
  });

  it("mounts inside the modal dialog a hit test finds when none holds focus", () => {
    const top = document.createElement("dialog");
    const under = document.createElement("dialog");
    document.body.append(top, under);
    // The first dialog opened last: its ::backdrop is what a hit test finds.
    openModal(under, top);
    topLeft = top;
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(top);
  });

  it("mounts inside a focused modal dialog that opened inside a fullscreen element", () => {
    const player = document.createElement("div");
    const [settings, button] = dialogWithButton();
    player.append(settings);
    document.body.append(player);
    fullscreen(player);
    openModal(settings);
    button.focus();
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(settings);
  });

  it("prefers a fullscreen element to a modal dialog without focus", () => {
    const player = document.createElement("div");
    const dialog = document.createElement("dialog");
    document.body.append(player, dialog);
    fullscreen(player);
    openModal(dialog);
    topLeft = dialog;
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(player);
  });

  it("mounts inside the modal dialog that holds focus when two opened in reverse order", () => {
    const [earlier, earlierButton] = dialogWithButton();
    const [later] = dialogWithButton();
    document.body.append(earlier, later);
    // The later dialog opened first; the earlier one is on top with focus.
    openModal(later, earlier);
    earlierButton.focus();
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(
      earlier.querySelector("[data-provenance-lens-palette]"),
    ).not.toBeNull();
  });

  it("mounts inside a modal dialog in an open shadow root", () => {
    const component = document.createElement("div");
    document.body.append(component);
    const shadow = component.attachShadow({ mode: "open" });
    const [dialog, button] = dialogWithButton();
    shadow.append(dialog);
    openModal(dialog);
    button.focus();
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(
      dialog.querySelector("[data-provenance-lens-palette]"),
    ).not.toBeNull();
  });

  it("mounts inside a fullscreen element in an open shadow root", () => {
    const component = document.createElement("div");
    document.body.append(component);
    const shadow = component.attachShadow({ mode: "open" });
    const player = document.createElement("div");
    shadow.append(player);
    fullscreen(component);
    Object.defineProperty(shadow, "fullscreenElement", {
      configurable: true,
      get: () => player,
    });
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(
      player.querySelector("[data-provenance-lens-palette]"),
    ).not.toBeNull();
  });

  it("mounts again on top when the page closes the dialog it is in", () => {
    const [dialog, button] = dialogWithButton();
    document.body.append(dialog);
    const open = openModal(dialog);
    button.focus();
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(dialog);

    open.delete(dialog);
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new Event("close"));
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
  });

  it("mounts again on top when the page leaves fullscreen", () => {
    const player = document.createElement("div");
    document.body.append(player);
    fullscreen(player);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(player);

    delete (document as { fullscreenElement?: unknown }).fullscreenElement;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
  });

  it("mounts inside a fullscreen element the page enters after it opened", () => {
    const player = document.createElement("div");
    document.body.append(player);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);

    fullscreen(player);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(hostRoot()?.parentElement).toBe(player);
  });

  it("closes when the page closes the dialog it is in and removes it", async () => {
    const [dialog, button] = dialogWithButton();
    document.body.append(dialog);
    const open = openModal(dialog);
    button.focus();
    const first = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    const root = hostRoot();
    expect(root?.parentElement).toBe(dialog);

    // dialog.close() queues its close event; dialog.remove() runs first.
    open.delete(dialog);
    dialog.remove();
    dialog.dispatchEvent(new Event("close"));
    await expect(first).resolves.toEqual({ status: "closed" });
    expect(root?.isConnected).toBe(false);
    expect(hostRoot()).toBeNull();

    // The next open mounts a new palette instead of closing a hidden one.
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
    expect(hostRoot()).not.toBe(root);
  });

  it("mounts a new palette when the page removed the open one with no close event", async () => {
    const [dialog, button] = dialogWithButton();
    document.body.append(dialog);
    const open = openModal(dialog);
    button.focus();
    const first = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await first;
    const root = hostRoot();
    expect(root?.parentElement).toBe(dialog);

    // dialog.remove() without close(): no event tells the host.
    open.delete(dialog);
    dialog.remove();
    expect(root?.isConnected).toBe(false);

    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
    expect(hostRoot()).not.toBe(root);
    expect(shadows).toHaveLength(2);
    expect(ports[0]?.disconnect).toHaveBeenCalledTimes(1);
  });

  it("shows the host again on top when the root element goes fullscreen", () => {
    const { calls } = stubPopovers();
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(calls).toEqual(["show"]);

    // The parent stays the root element, but the fullscreen layer is now
    // above the host until it is shown again.
    fullscreen(document.documentElement);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(hostRoot()?.parentElement).toBe(document.documentElement);
    expect(calls).toEqual(["show", "hide", "show"]);
  });

  it("does not mount again once the palette has closed", async () => {
    const [dialog, button] = dialogWithButton();
    document.body.append(dialog);
    const open = openModal(dialog);
    button.focus();
    const first = mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    post({ lens: "ready" });
    await first;
    await mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()).toBeNull();

    open.delete(dialog);
    dialog.dispatchEvent(new Event("close"));
    const player = document.createElement("div");
    document.body.append(player);
    fullscreen(player);
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(hostRoot()).toBeNull();
  });

  it("falls back to the fullscreen element or the document when :modal is not supported", () => {
    const unsupported = (): never => {
      throw new SyntaxError("unknown pseudo-class");
    };
    vi.spyOn(Element.prototype, "closest").mockImplementation(unsupported);
    vi.spyOn(document, "querySelectorAll").mockImplementation(unsupported);
    const [dialog, button] = dialogWithButton();
    document.body.append(dialog);
    button.focus();
    topLeft = dialog;
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(document.documentElement);

    hostRoot()?.remove();
    delete (globalThis as Record<string, unknown>)[
      "__provenanceLensPaletteHost"
    ];
    const player = document.createElement("div");
    document.body.append(player);
    fullscreen(player);
    void mountPaletteHost(FRAME_URL, TOKEN, 1_500);
    expect(hostRoot()?.parentElement).toBe(player);
  });
});
