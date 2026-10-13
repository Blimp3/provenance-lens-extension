import { beforeEach, describe, expect, it, vi } from "vitest";

import { PICKER_RUNTIME_VERSION } from "@provenance-lens/shared";

const SESSION_TOKEN = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_SESSION_TOKEN = "323e4567-e89b-42d3-a456-426614174000";

type PickerMessageListener = (message: unknown) => void;

function installChrome(): {
  sendMessage: ReturnType<typeof vi.fn>;
  sendPickerMessage: (message: unknown) => void;
} {
  let onMessage: PickerMessageListener | undefined;
  const sendMessage = vi.fn((...args: unknown[]) => {
    void args;
    return Promise.resolve();
  });
  Object.defineProperty(globalThis, "chrome", {
    configurable: true,
    value: {
      runtime: {
        onMessage: {
          addListener(listener: PickerMessageListener): void {
            onMessage = listener;
          },
        },
        sendMessage,
      },
    },
  });
  return {
    sendMessage,
    sendPickerMessage(message: unknown): void {
      onMessage?.(message);
    },
  };
}

function imageRect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    width,
    height,
    top,
    left,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

function startMessage(sendPickerMessage: (message: unknown) => void): void {
  sendPickerMessage({
    type: "page-bind",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: SESSION_TOKEN,
  });
  sendPickerMessage({
    type: "picker-start",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: SESSION_TOKEN,
  });
}

function bindMessage(sendPickerMessage: (message: unknown) => void): void {
  sendPickerMessage({
    type: "page-bind",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: SESSION_TOKEN,
  });
}

function pickerStartDocument(): void {
  expect(
    document.querySelector('[data-provenance-lens-picker="overlay"]'),
  ).not.toBeNull();
}

function startLinkMessage(sendPickerMessage: (message: unknown) => void): void {
  bindMessage(sendPickerMessage);
  sendPickerMessage({
    type: "picker-start",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: SESSION_TOKEN,
    mode: "link",
  });
}

type ClickListener = (event: MouseEvent) => void;

/**
 * The newest picker's capture-phase listener for one event type. Earlier
 * tests leave their pickers' document listeners behind, so a dispatched event
 * would reach those too.
 */
function listenerOf<T extends Event>(
  addEventListener: { mock: { calls: unknown[][] } },
  type: string,
): (event: T) => void {
  const listener = addEventListener.mock.calls
    .slice()
    .reverse()
    .find(([registeredType]) => registeredType === type)?.[1];
  if (typeof listener !== "function")
    throw new Error(`Missing ${type} listener`);
  return listener as (event: T) => void;
}

function clickListenerOf(addEventListener: {
  mock: { calls: unknown[][] };
}): ClickListener {
  return listenerOf<MouseEvent>(addEventListener, "click");
}

/** jsdom never dispatches a trusted click, so the listener gets one directly. */
function trustedClick(
  listener: ClickListener,
  clientX: number,
  clientY: number,
): void {
  listener({
    clientX,
    clientY,
    isTrusted: true,
    composedPath: () => [],
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as MouseEvent);
}

function hitTest(elements: Element[]): void {
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: (): Element[] => elements,
  });
}

/** Without requestAnimationFrame the picker renders on a zero timeout. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function captureOverlayShadow(): { value: ShadowRoot | null } {
  const originalAttachShadow = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "attachShadow",
  )?.value as (init: ShadowRootInit) => ShadowRoot;
  const capture: { value: ShadowRoot | null } = { value: null };
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const shadow = Reflect.apply(originalAttachShadow, this, [init]);
    if (
      this instanceof HTMLElement &&
      this.dataset["provenanceLensPicker"] === "overlay"
    )
      capture.value = shadow;
    return shadow;
  });
  return capture;
}

/** An X post as rendered on the timeline: author link, time permalink, text. */
function xPost(
  status: string,
  withVideo: boolean,
): { article: HTMLElement; author: HTMLAnchorElement; text: HTMLElement } {
  const article = document.createElement("article");
  const header = document.createElement("div");
  const author = document.createElement("a");
  author.href = "https://x.com/alice";
  author.textContent = "Alice";
  const permalink = document.createElement("a");
  permalink.href = status;
  const time = document.createElement("time");
  time.textContent = "2h";
  permalink.append(time);
  header.append(author, permalink);
  const text = document.createElement("div");
  text.textContent = "A post";
  article.append(header, text);
  if (withVideo) {
    const player = document.createElement("div");
    const video = document.createElement("video");
    video.poster = "https://pbs.example/poster.jpg";
    player.append(video);
    article.append(player);
  }
  document.body.append(article);
  return { article, author, text };
}

function overlayElement(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-provenance-lens-picker="overlay"]',
  );
}

function toastRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-provenance-lens-toast="true"]',
  );
}

function bannerRoot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[data-provenance-lens-picker="banner"]',
  );
}

/** The closed shadow roots of the newest overlay, banner and toast. */
function captureShadows(): {
  overlay: ShadowRoot | null;
  banner: ShadowRoot | null;
  toast: ShadowRoot | null;
} {
  const originalAttachShadow = Object.getOwnPropertyDescriptor(
    Element.prototype,
    "attachShadow",
  )?.value as (init: ShadowRootInit) => ShadowRoot;
  const capture: {
    overlay: ShadowRoot | null;
    banner: ShadowRoot | null;
    toast: ShadowRoot | null;
  } = { overlay: null, banner: null, toast: null };
  vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ): ShadowRoot {
    const shadow = Reflect.apply(originalAttachShadow, this, [init]);
    if (this instanceof HTMLElement) {
      const picker = this.dataset["provenanceLensPicker"];
      if (picker === "overlay") capture.overlay = shadow;
      if (picker === "banner") capture.banner = shadow;
      if (this.dataset["provenanceLensToast"] === "true")
        capture.toast = shadow;
    }
    return shadow;
  });
  return capture;
}

function toneBarColor(shadow: ShadowRoot | null): string | undefined {
  return shadow?.querySelector<HTMLElement>('[data-toast-tone-bar="true"]')
    ?.style.background;
}

function resetPickerEnvironment(): void {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
  document.documentElement.style.cursor = "";
  document
    .querySelectorAll("[data-provenance-lens-picker]")
    .forEach((element) => element.remove());
  document
    .querySelectorAll('[data-provenance-lens-toast="true"]')
    .forEach((element) => element.remove());
  Reflect.deleteProperty(document, "elementsFromPoint");
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(window, "requestAnimationFrame");
  Reflect.deleteProperty(window, "cancelAnimationFrame");
  Reflect.deleteProperty(window, "matchMedia");
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  (
    window as Window & { __provenanceLensPickerInstalled?: boolean | string }
  ).__provenanceLensPickerInstalled = false;
}

describe("image picker lifecycle", () => {
  beforeEach(resetPickerEnvironment);

  it("installs the current runtime over a legacy boolean marker", async () => {
    const { sendPickerMessage } = installChrome();
    (
      window as Window & { __provenanceLensPickerInstalled?: boolean | string }
    ).__provenanceLensPickerInstalled = true;

    await import("../../src/picker.js");
    sendPickerMessage({
      type: "page-bind",
      runtimeVersion: "0.4.0",
      sessionToken: SESSION_TOKEN,
    });
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    expect(
      document.querySelector('[data-provenance-lens-picker="overlay"]'),
    ).toBeNull();

    startMessage(sendPickerMessage);

    pickerStartDocument();
    sendPickerMessage({
      type: "picker-stop",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
  });

  it("cancels and removes the overlay, listeners, cursor, and pending render", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const callbacks: FrameRequestCallback[] = [];
    const requestAnimationFrame = vi.fn(
      (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    );
    const cancelAnimationFrame = vi.fn();
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: requestAnimationFrame,
    });
    Object.defineProperty(window, "cancelAnimationFrame", {
      configurable: true,
      value: cancelAnimationFrame,
    });

    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    pickerStartDocument();
    expect(document.documentElement.style.cursor).toBe("crosshair");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 11, clientY: 21 }),
    );
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "picker-cancelled",
      sessionToken: SESSION_TOKEN,
    });
    expect(
      document.querySelector('[data-provenance-lens-picker="overlay"]'),
    ).toBeNull();
    expect(document.documentElement.style.cursor).toBe("");

    callbacks[0]?.(16);
    expect(
      document.querySelector('[data-provenance-lens-picker="overlay"]'),
    ).toBeNull();

    sendPickerMessage({
      type: "picker-stop",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    expect(
      document.querySelector('[data-provenance-lens-picker="overlay"]'),
    ).toBeNull();
  });

  it("resolves the first image in the ordered hit-test stack and renders an isolated cutout", async () => {
    const { sendPickerMessage } = installChrome();
    const originalAttachShadow = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "attachShadow",
    )?.value as (init: ShadowRootInit) => ShadowRoot;
    const shadowCapture: { value: ShadowRoot | null } = { value: null };
    vi.spyOn(Element.prototype, "attachShadow").mockImplementation(function (
      this: Element,
      init: ShadowRootInit,
    ): ShadowRoot {
      const shadow = Reflect.apply(originalAttachShadow, this, [init]);
      if (
        this instanceof HTMLElement &&
        this.dataset["provenanceLensPicker"] === "overlay"
      )
        shadowCapture.value = shadow;
      return shadow;
    });
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(12.4, 30.6, 36.6, 18.6),
    });
    const coveringElement = document.createElement("button");
    document.body.append(coveringElement, image);
    const elementsFromPoint = vi.fn((): Element[] => [coveringElement, image]);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: elementsFromPoint,
    });

    const callbacks: FrameRequestCallback[] = [];
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);

    const originalImageStyle = image.style.cssText;
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 35 }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 21, clientY: 36 }),
    );
    expect(callbacks).toHaveLength(1);
    callbacks[0]?.(16);

    const overlay = document.querySelector<HTMLElement>(
      '[data-provenance-lens-picker="overlay"]',
    );
    const focus = shadowCapture.value?.querySelector<HTMLElement>(
      "[data-picker-focus]",
    );
    const label = shadowCapture.value?.querySelector<HTMLElement>(
      "[data-picker-label]",
    );
    expect(overlay?.style.display).toBe("block");
    expect(overlay?.style.pointerEvents).toBe("none");
    expect(overlay?.style.getPropertyPriority("pointer-events")).toBe(
      "important",
    );
    expect(focus?.style.left).toBe("12.4px");
    expect(focus?.style.top).toBe("30.6px");
    expect(focus?.style.width).toBe("36.6px");
    expect(focus?.style.height).toBe("18.6px");
    expect(label?.textContent).toContain("Image · 37 × 19 px");
    expect(label?.textContent).toContain("Click to verify · Esc to cancel");
    expect(image.style.cssText).toBe(originalImageStyle);
  });

  it("ignores its own overlay and document backgrounds in an adversarial hit stack", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const image = document.createElement("img");
    image.src = "https://page.example/real-image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(10, 20, 30, 40),
    });
    document.body.append(image);
    document.documentElement.style.backgroundImage =
      'url("https://page.example/decoy.png")';

    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    const overlay = document.querySelector<HTMLElement>(
      '[data-provenance-lens-picker="overlay"]',
    );
    expect(overlay).not.toBeNull();
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (): Element[] => [
        overlay as HTMLElement,
        document.documentElement,
        image,
      ],
    });

    const clickListener = addEventListener.mock.calls.find(
      ([type]) => type === "click",
    )?.[1] as unknown as (event: MouseEvent) => void;
    clickListener({
      clientX: 20,
      clientY: 30,
      isTrusted: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as MouseEvent);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "picker-selected",
      selection: { url: "https://page.example/real-image.png" },
    });
  });

  it("ignores synthetic clicks, recomputes the candidate, and consumes trusted clicks", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(10, 20, 2, 2),
    });
    document.body.append(image);
    const elementFromPoint = vi.fn((): Element | null => image);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });

    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    const clickListener = addEventListener.mock.calls.find(
      ([type]) => type === "click",
    )?.[1] as unknown as (event: MouseEvent) => void;
    const makeClick = (
      trusted: boolean,
    ): {
      event: MouseEvent;
      preventDefault: ReturnType<typeof vi.fn>;
      stopPropagation: ReturnType<typeof vi.fn>;
      stopImmediatePropagation: ReturnType<typeof vi.fn>;
    } => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      const stopImmediatePropagation = vi.fn();
      const event = {
        clientX: 11,
        clientY: 21,
        isTrusted: trusted,
        preventDefault,
        stopPropagation,
        stopImmediatePropagation,
      } as unknown as MouseEvent;
      return {
        event,
        preventDefault,
        stopPropagation,
        stopImmediatePropagation,
      };
    };

    const syntheticClick = makeClick(false);
    clickListener(syntheticClick.event);
    expect(sendMessage).not.toHaveBeenCalled();

    elementFromPoint.mockReturnValueOnce(null);
    const emptyTrustedClick = makeClick(true);
    clickListener(emptyTrustedClick.event);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(emptyTrustedClick.preventDefault).toHaveBeenCalledTimes(1);
    expect(emptyTrustedClick.stopPropagation).toHaveBeenCalledTimes(1);
    expect(emptyTrustedClick.stopImmediatePropagation).toHaveBeenCalledTimes(1);

    elementFromPoint.mockReturnValue(image);
    const trustedClick = makeClick(true);
    clickListener(trustedClick.event);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(trustedClick.preventDefault).toHaveBeenCalledTimes(1);
    expect(trustedClick.stopPropagation).toHaveBeenCalledTimes(1);
    expect(trustedClick.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    const sentMessage: unknown = sendMessage.mock.calls[0]?.[0];
    expect(sentMessage).toMatchObject({
      type: "picker-selected",
      sessionToken: SESSION_TOKEN,
      selection: { url: "https://page.example/image.png" },
    });
  });

  it("consumes trusted press gestures before linked-image activation and selects once", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const link = document.createElement("a");
    link.href = "https://page.example/viewer";
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(10, 20, 40, 30),
    });
    link.append(image);
    document.body.append(link);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (): Element => image,
    });

    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    const listenerFor = <T extends Event>(
      type: string,
    ): ((event: T) => void) => {
      const listener = addEventListener.mock.calls.find(
        ([registeredType]) => registeredType === type,
      )?.[1];
      if (typeof listener !== "function")
        throw new Error(`Missing ${type} listener`);
      return listener;
    };
    const makeGesture = (): {
      event: MouseEvent;
      preventDefault: ReturnType<typeof vi.fn>;
      stopPropagation: ReturnType<typeof vi.fn>;
      stopImmediatePropagation: ReturnType<typeof vi.fn>;
    } => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      const stopImmediatePropagation = vi.fn();
      return {
        event: {
          clientX: 20,
          clientY: 30,
          isTrusted: true,
          preventDefault,
          stopPropagation,
          stopImmediatePropagation,
        } as unknown as MouseEvent,
        preventDefault,
        stopPropagation,
        stopImmediatePropagation,
      };
    };

    const pointerDown = makeGesture();
    listenerFor<PointerEvent>("pointerdown")(
      pointerDown.event as unknown as PointerEvent,
    );
    const pointerUp = makeGesture();
    listenerFor<PointerEvent>("pointerup")(
      pointerUp.event as unknown as PointerEvent,
    );
    const mouseDown = makeGesture();
    listenerFor<MouseEvent>("mousedown")(mouseDown.event);
    const mouseUp = makeGesture();
    listenerFor<MouseEvent>("mouseup")(mouseUp.event);
    expect(pointerDown.preventDefault).toHaveBeenCalledTimes(1);
    expect(pointerDown.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(pointerUp.preventDefault).toHaveBeenCalledTimes(1);
    expect(pointerUp.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(mouseDown.preventDefault).toHaveBeenCalledTimes(1);
    expect(mouseDown.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(mouseUp.preventDefault).toHaveBeenCalledTimes(1);
    expect(mouseUp.stopImmediatePropagation).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    const clickListener = listenerFor<MouseEvent>("click");
    const click = makeGesture();
    clickListener(click.event);
    clickListener(makeGesture().event);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "picker-selected",
      sessionToken: SESSION_TOKEN,
      selection: { url: "https://page.example/image.png" },
    });
  });

  it("renders one document-bound accessible toast as text without stealing focus", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    const focused = document.createElement("button");
    focused.textContent = "Page control";
    document.body.append(focused);
    focused.focus();

    await import("../../src/picker.js");
    const resultId = "223e4567-e89b-42d3-a456-426614174000";
    const toast = {
      type: "show-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
      tone: "error",
      title: "Verification failed",
      message: '<img src=x onerror="globalThis.pwned=true">\u202e',
      resultId,
    } as const;

    sendPickerMessage(toast);
    expect(toastRoot()).toBeNull();
    sendPickerMessage({
      type: "page-bind",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    sendPickerMessage(toast);
    expect(toastRoot()).toBeNull();
    bindMessage(sendPickerMessage);
    sendPickerMessage(toast);
    const firstRoot = toastRoot();
    const shadow = shadows.toast;
    const region = shadow?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    expect(firstRoot?.tagName).toBe("DIV");
    expect(region?.getAttribute("role")).toBe("alert");
    expect(region?.getAttribute("aria-live")).toBe("assertive");
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.dataset["toastTone"]).toBe("error");
    expect(toneBarColor(shadow)).toBe("var(--lens-danger)");
    expect(region?.style.background).toBe("var(--lens-surface)");
    expect(region?.style.borderRadius).toBe("12px");
    expect(firstRoot?.style.getPropertyValue("width")).toContain("380px");
    expect(region?.style.getPropertyValue("--lens-surface")).toBe("#FFFFFF");
    expect(region?.textContent).toContain(
      '<img src=x onerror="globalThis.pwned=true">',
    );
    expect(shadow?.querySelector("img, script")).toBeNull();
    expect(document.activeElement).toBe(focused);
    // A result toast without buttons still offers ×; Details needs its button.
    expect(shadow?.querySelector("[data-toast-action]")).toBeNull();

    // The next toast updates the same one in place.
    sendPickerMessage({
      ...toast,
      tone: "no-signal",
      title: "No supported OpenAI signal detected",
      message: "This does not prove that the image is human-made.",
      actions: ["details", "check-synthid"],
    });
    expect(firstRoot?.isConnected).toBe(true);
    expect(
      document.querySelectorAll('[data-provenance-lens-toast="true"]'),
    ).toHaveLength(1);
    expect(region?.getAttribute("role")).toBe("status");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(toneBarColor(shadow)).toBe("var(--lens-neutral)");
    expect(
      shadow?.querySelector('[data-toast-title="true"]')?.textContent,
    ).toBe("No supported OpenAI signal detected");
    const buttons = Array.from(
      shadow?.querySelectorAll<HTMLButtonElement>("[data-toast-action]") ?? [],
    );
    expect(buttons.map((button) => button.textContent)).toEqual([
      "Details",
      "Also check with Google ↗",
    ]);
    buttons[0]?.click();
    buttons[1]?.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenNthCalledWith(1, {
      type: "open-result-details",
      sessionToken: SESSION_TOKEN,
      resultId,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, {
      type: "toast-action",
      sessionToken: SESSION_TOKEN,
      action: "check-synthid",
    });
    expect(toastRoot()).not.toBeNull();
    expect(document.activeElement).toBe(focused);
  });

  it("dismisses a persistent toast only after the user activates Dismiss", async () => {
    vi.useFakeTimers();
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage({
      type: "show-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
      tone: "detected",
      title: "OpenAI provenance detected",
      message: "Detected signals: C2PA.",
      resultId: null,
      // Details needs a saved result, so it is not drawn without one.
      actions: ["details", "history"],
    });
    expect(toastRoot()).not.toBeNull();
    expect(toneBarColor(shadows.toast)).toBe("var(--lens-ok)");
    expect(
      Array.from(
        shadows.toast?.querySelectorAll("[data-toast-action]") ?? [],
      ).map((button) => button.textContent),
    ).toEqual(["History"]);
    // A verdict stays until the user dismisses it.
    vi.advanceTimersByTime(60_000);
    expect(toastRoot()).not.toBeNull();
    const dismiss = shadows.toast?.querySelector<HTMLButtonElement>(
      "[data-toast-dismiss]",
    );
    expect(dismiss?.type).toBe("button");
    expect(dismiss?.getAttribute("aria-label")).toBe(
      "Dismiss Provenance Lens result",
    );
    dismiss?.click();
    expect(toastRoot()).toBeNull();
  });

  it("resolves image candidates inside an open shadow root", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const image = document.createElement("img");
    image.src = "https://page.example/shadow-image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(4, 5, 40, 25),
    });
    shadow.append(image);
    document.body.append(host);
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: (): Element[] => [host],
    });
    Object.defineProperty(shadow, "elementsFromPoint", {
      configurable: true,
      value: (): Element[] => [image],
    });

    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    const clickListener = addEventListener.mock.calls.find(
      ([type]) => type === "click",
    )?.[1] as unknown as (event: MouseEvent) => void;
    clickListener({
      clientX: 10,
      clientY: 12,
      isTrusted: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as MouseEvent);

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "picker-selected",
      selection: { url: "https://page.example/shadow-image.png" },
    });
  });
});

describe("video picker (link mode)", () => {
  beforeEach(resetPickerEnvironment);

  it("sends an X post's own status link when the post shows a video", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadow = captureOverlayShadow();
    const { author } = xPost("https://x.com/alice/status/123?s=20", true);
    // Inside a post no other link counts, not even the author's profile.
    hitTest([author]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);
    const overlay = overlayElement();
    expect(overlay?.getAttribute("aria-label")).toBe(
      "Provenance Lens video picker",
    );
    expect(document.documentElement.style.cursor).toBe("crosshair");

    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    const label = shadow.value?.querySelector<HTMLElement>(
      "[data-picker-label]",
    );
    expect(label?.textContent).toBe(
      "Post link · x.com · Click to send · Esc to cancel",
    );
    expect(label?.dataset["linkHost"]).toBe("x.com");
    expect(overlay?.style.display).toBe("block");
    expect(overlay?.getAttribute("aria-label")).toBe(
      "Provenance Lens video picker. Post link · x.com · Click to send · Esc to cancel",
    );

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "picker-link-selected",
      sessionToken: SESSION_TOKEN,
      url: "https://x.com/alice/status/123",
    });
    expect(overlayElement()).toBeNull();
    expect(document.documentElement.style.cursor).toBe("");
  });

  it("picks nothing from an X post without a video, and Escape cancels", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const { text } = xPost("https://x.com/alice/status/456", false);
    hitTest([text]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    const overlay = overlayElement();
    expect(overlay?.style.display).toBe("none");

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(overlay?.isConnected).toBe(true);

    listenerOf<KeyboardEvent>(
      addEventListener,
      "keydown",
    )({
      key: "Escape",
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "picker-cancelled",
      sessionToken: SESSION_TOKEN,
    });
    expect(overlayElement()).toBeNull();
    expect(document.documentElement.style.cursor).toBe("");
  });

  it("sends a YouTube card's one watch link, even from its channel link", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadow = captureOverlayShadow();
    const card = document.createElement("div");
    const thumbnail = document.createElement("a");
    thumbnail.href = "https://www.youtube.com/watch?v=abcdefghijk&t=5s";
    const title = document.createElement("a");
    title.href = "https://www.youtube.com/watch?v=abcdefghijk";
    title.textContent = "A video";
    const channel = document.createElement("a");
    channel.href = "https://www.youtube.com/@channel";
    channel.textContent = "A channel";
    card.append(thumbnail, title, channel);
    document.body.append(card);
    hitTest([channel]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    expect(
      shadow.value?.querySelector<HTMLElement>("[data-picker-label]")
        ?.textContent,
    ).toBe("Post link · www.youtube.com · Click to send · Esc to cancel");

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "picker-link-selected",
      sessionToken: SESSION_TOKEN,
      url: "https://www.youtube.com/watch?v=abcdefghijk",
    });
  });

  it("picks nothing from a container that holds two YouTube videos", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const grid = document.createElement("div");
    const heading = document.createElement("span");
    heading.textContent = "Up next";
    grid.append(heading);
    for (const id of ["abcdefghijk", "zyxwvutsrqp"]) {
      const link = document.createElement("a");
      link.href = `https://www.youtube.com/watch?v=${id}`;
      grid.append(link);
    }
    document.body.append(grid);
    hitTest([heading]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(overlayElement()).not.toBeNull();
  });

  it("sends another site's nearest link without its fragment", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadow = captureOverlayShadow();
    const link = document.createElement("a");
    link.href = "https://page.example/post?id=1#comments";
    const inner = document.createElement("span");
    inner.textContent = "Open";
    link.append(inner);
    document.body.append(link);
    hitTest([inner]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    expect(
      shadow.value?.querySelector<HTMLElement>("[data-picker-label]")
        ?.textContent,
    ).toBe("Post link · page.example · Click to send · Esc to cancel");

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "picker-link-selected",
      sessionToken: SESSION_TOKEN,
      url: "https://page.example/post?id=1",
    });
  });

  it("keeps image mode unchanged on a post that shows a video", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadow = captureOverlayShadow();
    const { article } = xPost("https://x.com/alice/status/123", true);
    const video = article.querySelector("video");
    if (!video) throw new Error("Missing video");
    Object.defineProperty(video, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(10, 20, 320, 180),
    });
    hitTest([video]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    expect(overlayElement()?.getAttribute("aria-label")).toBe(
      "Provenance Lens image picker",
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    expect(
      shadow.value?.querySelector<HTMLElement>("[data-picker-label]")
        ?.textContent,
    ).toBe("Video poster · 320 × 180 px · Click to verify · Esc to cancel");

    trustedClick(clickListenerOf(addEventListener), 20, 30);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      type: "picker-selected",
      sessionToken: SESSION_TOKEN,
      selection: {
        url: "https://pbs.example/poster.jpg",
        sourceKind: "video-poster",
      },
    });
  });
});

function matchMediaFor(matching: readonly string[]): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: matching.includes(query),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function showToastMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "show-toast",
    runtimeVersion: PICKER_RUNTIME_VERSION,
    sessionToken: SESSION_TOKEN,
    tone: "success",
    title: "Sent to DigiBot",
    message: "Queued in DigiBot. The result arrives in your Telegram chat.",
    resultId: null,
    ...overrides,
  };
}

describe("pick banner", () => {
  beforeEach(resetPickerEnvironment);

  it.each([
    [undefined, undefined, "Verify · Click an image · Esc to cancel"],
    ["image", "send-image", "Send image · Click an image · Esc to cancel"],
    [
      "link",
      undefined,
      "Send video · Click a post with a video · Esc to cancel",
    ],
    ["image", "synthid", "Google SynthID · Click an image · Esc to cancel"],
  ] as const)(
    "names the armed picker (mode %s, label %s)",
    async (mode, label, text) => {
      const { sendPickerMessage } = installChrome();
      const shadows = captureShadows();
      await import("../../src/picker.js");
      bindMessage(sendPickerMessage);
      sendPickerMessage({
        type: "picker-start",
        runtimeVersion: PICKER_RUNTIME_VERSION,
        sessionToken: SESSION_TOKEN,
        ...(mode ? { mode } : {}),
        ...(label ? { label } : {}),
      });
      const pill = shadows.banner?.querySelector<HTMLElement>(
        '[data-picker-banner="true"]',
      );
      expect(pill?.textContent).toBe(text);
      expect(pill?.getAttribute("role")).toBe("status");
      expect(pill?.style.height).toBe("36px");
      expect(pill?.style.borderRadius).toBe("18px");
      expect(pill?.querySelector("kbd")?.textContent).toBe("Esc");
      expect(bannerRoot()?.style.pointerEvents).toBe("none");
    },
  );

  it("names the save verb on hover in SynthID mode", async () => {
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    Object.defineProperty(image, "getBoundingClientRect", {
      configurable: true,
      value: () => imageRect(10, 20, 30, 40),
    });
    document.body.append(image);
    hitTest([image]);
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
      label: "synthid",
    });
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 20, clientY: 30 }),
    );
    await flush();
    expect(
      shadows.overlay?.querySelector("[data-picker-label]")?.textContent,
    ).toBe("Image · 30 × 40 px · Click to save · Esc to cancel");
  });

  it("warns for 2 s on a click that hits no candidate, then goes on pick", async () => {
    vi.useFakeTimers();
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    const text = document.createElement("p");
    document.body.append(text);
    hitTest([text]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    const pill = shadows.banner?.querySelector<HTMLElement>(
      '[data-picker-banner="true"]',
    );

    trustedClick(clickListenerOf(addEventListener), 5, 5);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(pill?.textContent).toBe("No supported image here");
    expect(pill?.dataset["pickerBannerState"]).toBe("warning");
    expect(pill?.style.color).toBe("var(--lens-warn)");
    vi.advanceTimersByTime(1_999);
    expect(pill?.textContent).toBe("No supported image here");
    vi.advanceTimersByTime(1);
    expect(pill?.textContent).toBe("Verify · Click an image · Esc to cancel");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bannerRoot()).toBeNull();
  });

  it("says when a clicked post shows no video", async () => {
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    const { text } = xPost("https://x.com/alice/status/123", false);
    hitTest([text]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startLinkMessage(sendPickerMessage);
    trustedClick(clickListenerOf(addEventListener), 5, 5);
    expect(
      shadows.banner?.querySelector('[data-picker-banner="true"]')?.textContent,
    ).toBe("This post shows no video");
  });

  it("removes the banner with the overlay when an image is picked", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    document.body.append(image);
    hitTest([image]);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    expect(bannerRoot()).not.toBeNull();
    trustedClick(clickListenerOf(addEventListener), 5, 5);
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(bannerRoot()).toBeNull();
    expect(overlayElement()).toBeNull();
  });
});

describe("mount rule for the banner, overlay and toast", () => {
  beforeEach(resetPickerEnvironment);

  /** The overlay, banner and toast hosts, also inside a shadow root. */
  function mountedRoots(scope: ParentNode = document): HTMLElement[] {
    return Array.from(
      scope.querySelectorAll<HTMLElement>(
        '[data-provenance-lens-picker], [data-provenance-lens-toast="true"]',
      ),
    );
  }

  async function showAll(
    scope: ParentNode = document,
  ): Promise<ReturnType<typeof vi.fn>> {
    const showPopover = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "showPopover", {
      configurable: true,
      value: showPopover,
    });
    const { sendPickerMessage } = installChrome();
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage());
    expect(mountedRoots(scope)).toHaveLength(3);
    return showPopover;
  }

  it("mounts on the root element as manual popovers by default", async () => {
    const showPopover = await showAll();
    for (const root of mountedRoots()) {
      expect(root.parentElement).toBe(document.documentElement);
      expect(root.getAttribute("popover")).toBe("manual");
    }
    expect(showPopover).toHaveBeenCalledTimes(3);
  });

  it("mounts inside the topmost modal dialog", async () => {
    const outer = document.createElement("dialog");
    const inner = document.createElement("dialog");
    outer.append(inner);
    document.body.append(outer);
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? [outer, inner]
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(inner);
  });

  it("mounts inside a fullscreen element, but not inside fullscreen media", async () => {
    const player = document.createElement("div");
    document.body.append(player);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => player,
    });
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(player);

    resetPickerEnvironment();
    const video = document.createElement("video");
    document.body.append(video);
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => video,
    });
    await showAll();
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(document.documentElement);
  });

  /**
   * Lets closest("dialog:modal") find these dialogs, listed outer to inner,
   * as it finds open modal dialogs.
   */
  function openModalDialogs(dialogs: readonly Element[]): void {
    const closest = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "closest",
    )?.value as (this: Element, selector: string) => Element | null;
    vi.spyOn(Element.prototype, "closest").mockImplementation(function (
      this: Element,
      selector: string,
    ): Element | null {
      if (selector !== "dialog:modal") return closest.call(this, selector);
      return dialogs.filter((dialog) => dialog.contains(this)).at(-1) ?? null;
    });
  }

  it("mounts inside the modal dialog on top when two were opened in reverse document order", async () => {
    const first = document.createElement("dialog");
    const second = document.createElement("dialog");
    const button = document.createElement("button");
    first.append(button);
    document.body.append(first, second);
    // The second dialog opened first; the first one opened over it and took
    // the focus, so the last one in document order is the covered one.
    openModalDialogs([first, second]);
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? [first, second]
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    button.focus();
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(first);
  });

  it("mounts inside a modal dialog in an open shadow root", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    const button = document.createElement("button");
    dialog.append(button);
    shadow.append(dialog);
    document.body.append(host);
    openModalDialogs([dialog]);
    button.focus();
    await showAll(shadow);
    for (const root of mountedRoots(shadow))
      expect(root.parentElement).toBe(dialog);
  });

  it("mounts inside the fullscreen element of an open shadow root", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const player = document.createElement("div");
    shadow.append(player);
    document.body.append(host);
    // The document names only the shadow host.
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => host,
    });
    Object.defineProperty(shadow, "fullscreenElement", {
      configurable: true,
      get: () => player,
    });
    await showAll(shadow);
    for (const root of mountedRoots(shadow))
      expect(root.parentElement).toBe(player);
  });

  it("moves an updated toast into a modal dialog opened after it", async () => {
    const { sendPickerMessage } = installChrome();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ tone: "progress" }));
    const root = toastRoot();
    expect(root?.parentElement).toBe(document.documentElement);

    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? [dialog]
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    sendPickerMessage(showToastMessage());
    expect(toastRoot()).toBe(root);
    expect(root?.parentElement).toBe(dialog);
  });

  it("keeps toast input from the modal dialog and the page's bubble-phase handlers", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? [dialog]
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    const pageEvents: string[] = [];
    const mouseTypes = [
      "pointerdown",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "auxclick",
      "contextmenu",
    ];
    const keyTypes = ["keydown", "keyup"];
    for (const type of [...mouseTypes, ...keyTypes]) {
      dialog.addEventListener(type, () => pageEvents.push(`dialog ${type}`));
      document.addEventListener(type, () => pageEvents.push(`page ${type}`));
    }
    // The limit: a capture-phase listener on the document still sees the
    // click, on the toast's host.
    const capturedTargets: (EventTarget | null)[] = [];
    document.addEventListener(
      "click",
      (event) => capturedTargets.push(event.target),
      true,
    );
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ actions: ["history"] }));
    const root = toastRoot();
    expect(root?.parentElement).toBe(dialog);

    const history = shadows.toast?.querySelector<HTMLButtonElement>(
      '[data-toast-action="history"]',
    );
    for (const type of mouseTypes.filter((type) => type !== "click"))
      history?.dispatchEvent(
        new MouseEvent(type, { bubbles: true, composed: true }),
      );
    for (const type of keyTypes)
      history?.dispatchEvent(
        new KeyboardEvent(type, {
          key: "Enter",
          bubbles: true,
          composed: true,
        }),
      );
    history?.click();
    expect(capturedTargets).toEqual([root]);
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "toast-action",
        sessionToken: SESSION_TOKEN,
        action: "history",
      }),
    );
    shadows.toast
      ?.querySelector<HTMLButtonElement>('[data-toast-dismiss="true"]')
      ?.click();
    expect(toastRoot()).toBeNull();
    expect(pageEvents).toEqual([]);
  });

  it("keeps a toast click inside an open shadow root's modal dialog from the armed picker", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const dialog = document.createElement("dialog");
    const button = document.createElement("button");
    dialog.append(button);
    shadow.append(dialog);
    document.body.append(host);
    openModalDialogs([dialog]);
    button.focus();
    const { sendMessage, sendPickerMessage } = installChrome();
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(
      showToastMessage({ tone: "detected", actions: ["check-synthid"] }),
    );
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
      label: "synthid",
    });
    const root = shadow.querySelector<HTMLElement>(
      '[data-provenance-lens-toast="true"]',
    );
    expect(root?.parentElement).toBe(dialog);

    // At the document, the page's shadow host is the target; the toast's
    // host is still on the composed path.
    const cancelled: string[] = [];
    for (const type of [
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
      "click",
    ])
      listenerOf<MouseEvent>(
        addEventListener,
        type,
      )({
        target: host,
        composedPath: () => [
          root,
          dialog,
          shadow,
          host,
          document.body,
          document.documentElement,
          document,
          window,
        ],
        clientX: 5,
        clientY: 5,
        isTrusted: true,
        preventDefault: () => cancelled.push(type),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
      } as unknown as MouseEvent);
    expect(cancelled).toEqual([]);
    expect(
      shadow.querySelector('[data-provenance-lens-picker="banner"]'),
    ).not.toBeNull();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("mounts inside a focused modal dialog that sits inside a fullscreen element", async () => {
    const player = document.createElement("div");
    const settings = document.createElement("dialog");
    const button = document.createElement("button");
    settings.append(button);
    player.append(settings);
    document.body.append(player);
    // The player's settings dialog makes the fullscreen player inert.
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => player,
    });
    openModalDialogs([settings]);
    button.focus();
    await showAll();
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(settings);
  });

  it("mounts inside the modal dialog hit at the top-left corner before the last one in document order", async () => {
    const first = document.createElement("dialog");
    const second = document.createElement("dialog");
    document.body.append(first, second);
    // Neither dialog holds the focus. The first one opened last, so its
    // ::backdrop covers the corner.
    openModalDialogs([first, second]);
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? [first, second]
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number): Element | null =>
        x === 0 && y === 0 ? first : null,
    });
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(first);
  });

  it("mounts the overlay, banner and toast again when the page closes their modal dialog", async () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    let modalDialogs: Element[] = [dialog];
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? modalDialogs
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    const showPopover = await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(dialog);

    // A closed dialog hides what is inside it, still attached.
    modalDialogs = [];
    dialog.dispatchEvent(new Event("close"));
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(document.documentElement);
    expect(showPopover).toHaveBeenCalledTimes(6);
  });

  it("mounts the overlay, banner and toast again after the page closes and removes their modal dialog", async () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    let modalDialogs: Element[] = [dialog];
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? modalDialogs
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(dialog);

    // dialog.close(); dialog.remove(): the close event comes after the
    // removal took the surfaces out of the document.
    modalDialogs = [];
    dialog.remove();
    expect(mountedRoots()).toHaveLength(0);
    dialog.dispatchEvent(new Event("close"));
    expect(mountedRoots()).toHaveLength(3);
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(document.documentElement);
  });

  it("mounts the overlay, banner and toast into a fullscreen element entered after they show", async () => {
    const player = document.createElement("div");
    document.body.append(player);
    let fullscreen: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreen,
    });
    await showAll();
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(document.documentElement);

    // For example the YouTube "f" key while the picker is armed.
    fullscreen = player;
    document.dispatchEvent(new Event("fullscreenchange"));
    for (const root of mountedRoots()) expect(root.parentElement).toBe(player);
  });

  it("mounts the overlay, banner and toast again when the page leaves fullscreen", async () => {
    const player = document.createElement("div");
    document.body.append(player);
    let fullscreen: Element | null = player;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreen,
    });
    await showAll();
    for (const root of mountedRoots()) expect(root.parentElement).toBe(player);

    fullscreen = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    for (const root of mountedRoots())
      expect(root.parentElement).toBe(document.documentElement);
  });

  it("leaves a removed surface out when its modal dialog closes", async () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    let modalDialogs: Element[] = [dialog];
    const querySelectorAll = document.querySelectorAll.bind(document);
    vi.spyOn(document, "querySelectorAll").mockImplementation(((
      selector: string,
    ) =>
      selector === "dialog:modal"
        ? modalDialogs
        : querySelectorAll(selector)) as typeof document.querySelectorAll);
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    startMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ tone: "detected" }));
    expect(mountedRoots(dialog)).toHaveLength(3);
    sendPickerMessage({
      type: "picker-stop",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    shadows.toast
      ?.querySelector<HTMLButtonElement>('[data-toast-dismiss="true"]')
      ?.click();
    expect(mountedRoots()).toHaveLength(0);

    modalDialogs = [];
    dialog.dispatchEvent(new Event("close"));
    expect(mountedRoots()).toHaveLength(0);
  });
});

describe("result toast", () => {
  beforeEach(resetPickerEnvironment);

  it("hides a success toast after 6 s, pausing while hovered", async () => {
    vi.useFakeTimers();
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage());
    const region = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    expect(toneBarColor(shadows.toast)).toBe("var(--lens-ok)");

    vi.advanceTimersByTime(4_000);
    region?.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(10_000);
    expect(toastRoot()).not.toBeNull();
    region?.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(1_999);
    expect(toastRoot()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(toastRoot()).toBeNull();
  });

  it("pauses the countdown while a toast button has focus", async () => {
    vi.useFakeTimers();
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ actions: ["history"] }));
    const region = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    region?.dispatchEvent(new FocusEvent("focusin"));
    vi.advanceTimersByTime(30_000);
    expect(toastRoot()).not.toBeNull();
    region?.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(6_000);
    expect(toastRoot()).toBeNull();
  });

  it("hides a success toast after a new render removed the hovered or focused button", async () => {
    vi.useFakeTimers();
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ tone: "error", actions: ["retry"] }));
    const region = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    // Retry is hovered and focused when it is clicked. The new render removes
    // it, and the browser sends no pointerleave or focusout for that.
    region?.dispatchEvent(new Event("pointerenter"));
    region?.dispatchEvent(new FocusEvent("focusin"));
    sendPickerMessage(showToastMessage({ tone: "progress" }));
    sendPickerMessage(showToastMessage());
    vi.advanceTimersByTime(5_999);
    expect(toastRoot()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(toastRoot()).toBeNull();
  });

  it("keeps a success toast that is still hovered or focused at 6 s", async () => {
    vi.useFakeTimers();
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage());
    const region = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    if (!region) throw new Error("Missing toast region");
    const matches = vi.spyOn(region, "matches").mockReturnValue(true);
    vi.advanceTimersByTime(6_000);
    expect(matches).toHaveBeenCalledWith(":hover, :focus-within");
    expect(toastRoot()).not.toBeNull();
    matches.mockReturnValue(false);
    vi.advanceTimersByTime(6_000);
    expect(toastRoot()).toBeNull();
  });

  it("keeps a running verify's toast after a page-link send binds the page again", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    // The verify's binding and its progress toast.
    bindMessage(sendPickerMessage);
    sendPickerMessage(
      showToastMessage({
        tone: "progress",
        title: "Verifying image…",
        actions: ["cancel"],
      }),
    );
    // The popup's page-link send binds the page again and reports first.
    sendPickerMessage({
      type: "page-bind",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    sendPickerMessage(
      showToastMessage({
        sessionToken: OTHER_SESSION_TOKEN,
        tone: "progress",
        title: "Sending to DigiBot…",
      }),
    );
    sendPickerMessage(showToastMessage({ sessionToken: OTHER_SESSION_TOKEN }));

    sendPickerMessage(
      showToastMessage({
        tone: "detected",
        title: "OpenAI provenance detected",
        actions: ["history"],
      }),
    );
    expect(
      shadows.toast?.querySelector('[data-toast-title="true"]')?.textContent,
    ).toBe("OpenAI provenance detected");
    shadows.toast
      ?.querySelector<HTMLButtonElement>('[data-toast-action="history"]')
      ?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "toast-action",
        sessionToken: SESSION_TOKEN,
        action: "history",
      }),
    );

    // A hide for the send leaves the verify's toast; its own hide removes it.
    sendPickerMessage({
      type: "hide-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    expect(toastRoot()).not.toBeNull();
    sendPickerMessage({
      type: "hide-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    expect(toastRoot()).toBeNull();

    // Only the latest binding starts the picker.
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    expect(bannerRoot()).toBeNull();
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    expect(bannerRoot()).not.toBeNull();
  });

  it("ignores a toast button while the page hides the toast's host", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ actions: ["history"] }));
    const root = toastRoot();
    const history = shadows.toast?.querySelector<HTMLButtonElement>(
      '[data-toast-action="history"]',
    );
    root?.style.setProperty("opacity", "0.01", "important");
    history?.click();
    root?.style.setProperty("opacity", "1", "important");
    root?.style.setProperty("visibility", "hidden", "important");
    history?.click();
    await flush();
    expect(sendMessage).not.toHaveBeenCalled();

    root?.style.setProperty("visibility", "visible", "important");
    history?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "toast-action",
        sessionToken: SESSION_TOKEN,
        action: "history",
      }),
    );
  });

  it("shows a labelled spinner and Cancel while work runs", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(
      showToastMessage({
        tone: "progress",
        title: "Verifying image…",
        message: "page.example · API check",
        actions: ["cancel"],
      }),
    );
    const spinner = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-spinner="true"]',
    );
    expect(spinner?.getAttribute("role")).toBe("progressbar");
    expect(spinner?.getAttribute("aria-label")).toBe("Verifying image…");
    expect(spinner?.querySelector("svg")).not.toBeNull();
    shadows.toast
      ?.querySelector<HTMLButtonElement>('[data-toast-action="cancel"]')
      ?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "toast-action",
        sessionToken: SESSION_TOKEN,
        action: "cancel",
      }),
    );

    sendPickerMessage({
      type: "hide-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    expect(toastRoot()).not.toBeNull();
    sendPickerMessage({
      type: "hide-toast",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
    });
    expect(toastRoot()).toBeNull();
  });

  it("labels a connected stop Stop waiting", async () => {
    const { sendMessage, sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(
      showToastMessage({
        tone: "progress",
        title: "Verifying image…",
        message: "page.example · DigiBot check",
        actions: ["stop-waiting"],
      }),
    );
    const stop = shadows.toast?.querySelector<HTMLButtonElement>(
      '[data-toast-action="stop-waiting"]',
    );
    expect(stop?.textContent).toBe("Stop waiting");
    stop?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "toast-action",
        sessionToken: SESSION_TOKEN,
        action: "stop-waiting",
      }),
    );
  });
  it("uses a static ellipsis and no entrance motion with reduced motion", async () => {
    matchMediaFor(["(prefers-reduced-motion: reduce)"]);
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      const { sendPickerMessage } = installChrome();
      const shadows = captureShadows();
      await import("../../src/picker.js");
      bindMessage(sendPickerMessage);
      sendPickerMessage(showToastMessage({ tone: "progress" }));
      const spinner = shadows.toast?.querySelector<HTMLElement>(
        '[data-toast-spinner="true"]',
      );
      expect(spinner?.textContent).toBe("…");
      expect(animate).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });

  it("slides in once and spins without reduced motion", async () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    try {
      const { sendPickerMessage } = installChrome();
      await import("../../src/picker.js");
      bindMessage(sendPickerMessage);
      sendPickerMessage(showToastMessage({ tone: "progress" }));
      sendPickerMessage(showToastMessage());
      const durations = animate.mock.calls.map(
        (call) => (call[1] as KeyframeAnimationOptions).duration,
      );
      expect(durations).toEqual([800, 160]);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
    }
  });

  it("uses the dark tokens and forced colors from matchMedia", async () => {
    matchMediaFor(["(prefers-color-scheme: dark)", "(forced-colors: active)"]);
    const { sendPickerMessage } = installChrome();
    const shadows = captureShadows();
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage());
    const region = shadows.toast?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    expect(region?.style.getPropertyValue("--lens-ok")).toBe("#4ADE80");
    expect(region?.style.getPropertyValue("--lens-line")).toBe("CanvasText");
  });

  it("lets the toast's buttons work while the picker is armed", async () => {
    const { sendPickerMessage } = installChrome();
    const image = document.createElement("img");
    image.src = "https://page.example/image.png";
    document.body.append(image);
    const addEventListener = vi.spyOn(document, "addEventListener");
    await import("../../src/picker.js");
    bindMessage(sendPickerMessage);
    sendPickerMessage(showToastMessage({ tone: "detected" }));
    sendPickerMessage({
      type: "picker-start",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: SESSION_TOKEN,
      label: "synthid",
    });
    const root = toastRoot();
    // The toast covers what is under it.
    hitTest([root as HTMLElement, image]);
    const preventDefault = vi.fn();
    clickListenerOf(addEventListener)({
      target: root,
      clientX: 5,
      clientY: 5,
      isTrusted: true,
      preventDefault,
      stopPropagation: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    } as unknown as MouseEvent);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(bannerRoot()).not.toBeNull();

    trustedClick(clickListenerOf(addEventListener), 5, 5);
    expect(bannerRoot()).not.toBeNull();
  });
});
