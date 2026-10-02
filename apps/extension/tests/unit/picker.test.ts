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

function resetPickerEnvironment(): void {
  vi.restoreAllMocks();
  vi.resetModules();
  document.body.replaceChildren();
  document.documentElement.style.cursor = "";
  document
    .querySelectorAll('[data-provenance-lens-picker="overlay"]')
    .forEach((element) => element.remove());
  document
    .querySelectorAll('[data-provenance-lens-toast="true"]')
    .forEach((element) => element.remove());
  Reflect.deleteProperty(document, "elementsFromPoint");
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(window, "requestAnimationFrame");
  Reflect.deleteProperty(window, "cancelAnimationFrame");
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
    expect(label?.textContent).toContain("Click to select · Esc to cancel");
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
        this.dataset["provenanceLensToast"] === "true"
      ) {
        shadowCapture.value = shadow;
      }
      return shadow;
    });
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
    expect(
      document.querySelector('[data-provenance-lens-toast="true"]'),
    ).toBeNull();
    sendPickerMessage({
      type: "page-bind",
      runtimeVersion: PICKER_RUNTIME_VERSION,
      sessionToken: OTHER_SESSION_TOKEN,
    });
    sendPickerMessage(toast);
    expect(
      document.querySelector('[data-provenance-lens-toast="true"]'),
    ).toBeNull();
    bindMessage(sendPickerMessage);
    sendPickerMessage(toast);
    const firstRoot = document.querySelector<HTMLElement>(
      '[data-provenance-lens-toast="true"]',
    );
    const firstShadow = shadowCapture.value;
    const region = firstShadow?.querySelector<HTMLElement>(
      '[data-toast-region="true"]',
    );
    expect(firstRoot?.tagName).toBe("DIV");
    expect(region?.getAttribute("role")).toBe("alert");
    expect(region?.getAttribute("aria-live")).toBe("assertive");
    expect(region?.getAttribute("aria-atomic")).toBe("true");
    expect(region?.style.borderColor).toBe("rgb(251, 113, 133)");
    expect(region?.style.background).toBe("rgb(17, 17, 17)");
    expect(region?.textContent).toContain(
      '<img src=x onerror="globalThis.pwned=true">',
    );
    expect(firstShadow?.querySelector("img, script")).toBeNull();
    expect(document.activeElement).toBe(focused);

    sendPickerMessage({
      ...toast,
      tone: "no-signal",
      title: "No supported OpenAI signal detected",
      message: "This does not prove that the image is human-made.",
    });
    expect(firstRoot?.isConnected).toBe(false);
    expect(
      document.querySelectorAll('[data-provenance-lens-toast="true"]'),
    ).toHaveLength(1);
    const secondShadow = shadowCapture.value;
    expect(
      secondShadow?.querySelector<HTMLElement>('[data-toast-region="true"]')
        ?.style.borderColor,
    ).toBe("rgb(251, 113, 133)");
    const details = secondShadow?.querySelector<HTMLButtonElement>(
      '[data-toast-details="true"]',
    );
    expect(details?.type).toBe("button");
    expect(details?.getAttribute("aria-label")).toContain(
      "Open full verification details",
    );
    expect(details?.getAttribute("aria-label")).toContain(
      "No supported OpenAI signal detected.",
    );
    expect(details?.style.width).toBe("100%");
    expect(
      Array.from(details?.children ?? []).map((child) => child.tagName),
    ).toEqual(["SPAN", "SPAN"]);
    details?.click();
    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: "open-result-details",
        sessionToken: SESSION_TOKEN,
        resultId,
      }),
    );
    expect(
      document.querySelector('[data-provenance-lens-toast="true"]'),
    ).not.toBeNull();
  });

  it("dismisses a persistent toast only after the user activates Dismiss", async () => {
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
      const attached = Reflect.apply(originalAttachShadow, this, [init]);
      if (
        this instanceof HTMLElement &&
        this.dataset["provenanceLensToast"] === "true"
      ) {
        shadowCapture.value = attached;
      }
      return attached;
    });
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
    });
    await Promise.resolve();
    expect(
      document.querySelector('[data-provenance-lens-toast="true"]'),
    ).not.toBeNull();
    expect(
      shadowCapture.value?.querySelector<HTMLElement>(
        '[data-toast-region="true"]',
      )?.style.borderColor,
    ).toBe("rgb(74, 222, 128)");
    expect(
      shadowCapture.value?.querySelector('[data-toast-details="true"]'),
    ).toBeNull();
    const dismiss = Array.from(
      shadowCapture.value?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Dismiss");
    expect(dismiss?.type).toBe("button");
    dismiss?.click();
    expect(
      document.querySelector('[data-provenance-lens-toast="true"]'),
    ).toBeNull();
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
    ).toBe("Video poster · 320 × 180 px · Click to select · Esc to cancel");

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
