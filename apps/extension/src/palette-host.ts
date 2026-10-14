/**
 * The Lens palette host: the small wrapper the worker injects into frame 0 of
 * the page. `mountPaletteHost` runs through
 * `chrome.scripting.executeScript({ func })`, which sends only its source, so
 * it imports nothing and keeps every helper inside its own body.
 */

export type PaletteHostStatus = "ready" | "closed" | "timeout" | "failed";
export type PaletteHostResult = { status: PaletteHostStatus };

/** The ready handshake's limit before the worker opens the fallback popup. */
export const PALETTE_READY_TIMEOUT_MS = 1_500;
const PORT_PREFIX = "lens-palette:";

/** The port a host opens; the token keeps two palettes apart. */
export function palettePortName(token: string): string {
  return `${PORT_PREFIX}${token}`;
}

export function isPalettePortName(name: string): boolean {
  return name.startsWith(PORT_PREFIX);
}

/** Whether a port is this frame's own; every other port is left alone. */
export function isOwnPalettePort(
  port: { name: string },
  token: string,
): boolean {
  return port.name === palettePortName(token);
}

/**
 * Mounts the palette frame, or closes the palette when one is already open on
 * this page (the shortcut and the toolbar click toggle). Resolves "ready" once
 * the frame has its token, "timeout" when it does not answer in time (the host
 * is removed then), "closed" for a toggle and "failed" when the page cannot
 * hold the host.
 */
export function mountPaletteHost(
  frameUrl: string,
  token: string,
  readyTimeoutMs: number,
): Promise<PaletteHostResult> {
  type LiveHost = { close: () => void; isConnected: () => boolean };
  const HOST_KEY = "__provenanceLensPaletteHost";
  const FULLSCREEN_MEDIA_ELEMENTS = new Set([
    "video",
    "img",
    "iframe",
    "embed",
    "object",
    "canvas",
  ]);
  // The isolated world keeps this between injections; pages never see it.
  const scope = globalThis as unknown as Record<string, LiveHost | undefined>;
  const live = scope[HOST_KEY];
  if (live) {
    // A host the page removed without a close event toggles nothing: a new
    // one mounts in its place.
    const connected = live.isConnected();
    live.close();
    if (connected) return Promise.resolve({ status: "closed" });
  }

  return new Promise((resolve) => {
    let settled = false;
    let closed = false;
    let refocused = false;
    let port: chrome.runtime.Port | null = null;
    const finish = (status: PaletteHostStatus): void => {
      if (settled) return;
      settled = true;
      resolve({ status });
    };

    let frameOrigin: string;
    try {
      // URL.origin is "null" for schemes a runtime does not know as standard.
      const url = new URL(frameUrl);
      frameOrigin = `${url.protocol}//${url.host}`;
    } catch {
      finish("failed");
      return;
    }
    const previousFocus = document.activeElement;
    const root = document.createElement("div");
    const iframe = document.createElement("iframe");

    const setImportant = (
      element: HTMLElement,
      styles: Record<string, string>,
    ): void => {
      for (const [property, value] of Object.entries(styles))
        element.style.setProperty(property, value, "important");
    };

    /**
     * The mount rule: a surface outside a modal dialog or a fullscreen element
     * is inert or hidden, so it goes inside the one on top, and then into the
     * top layer as a manual popover. In order: the modal dialog that holds the
     * focus; the fullscreen element, unless it is media; the modal dialog hit
     * at the top-left corner, since a modal dialog's ::backdrop hit-tests to
     * the dialog; the last modal dialog in document order; the root element.
     * The focus, the fullscreen element and the hit test are followed into
     * open shadow roots.
     */
    function mountParent(): Element {
      const focused = modalDialogAround(deepActiveElement());
      if (focused) return focused;
      const fullscreen = fullscreenElement();
      if (fullscreen && !FULLSCREEN_MEDIA_ELEMENTS.has(fullscreen.localName)) {
        return fullscreen;
      }
      return (
        modalDialogAround(deepestElementsFromPoint(document, 0, 0)[0]) ??
        lastModalDialog() ??
        document.documentElement ??
        document.body
      );
    }

    /** The focused element, also inside open shadow roots. */
    function deepActiveElement(): Element | null {
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement)
        focused = focused.shadowRoot.activeElement;
      return focused;
    }

    /** The fullscreen element itself, also inside open shadow roots. */
    function fullscreenElement(): Element | null {
      let element = document.fullscreenElement;
      while (element?.shadowRoot?.fullscreenElement)
        element = element.shadowRoot.fullscreenElement;
      return element;
    }

    /** The nearest modal dialog around an element, across shadow hosts. */
    function modalDialogAround(
      element: Element | undefined | null,
    ): Element | null {
      try {
        for (let node = element ?? null; node;) {
          const dialog = node.closest("dialog:modal");
          if (dialog) return dialog;
          const root = node.getRootNode();
          node = root instanceof ShadowRoot ? root.host : null;
        }
      } catch {
        // A browser without :modal.
      }
      return null;
    }

    function lastModalDialog(): Element | null {
      try {
        return (
          Array.from(document.querySelectorAll("dialog:modal")).at(-1) ?? null
        );
      } catch {
        return null;
      }
    }

    // A shadow root's hits also hold its host and the host's ancestors, so
    // each root is searched once.
    function deepestElementsFromPoint(
      root: Document | ShadowRoot,
      x: number,
      y: number,
      searched = new Set<Node>([root]),
    ): Element[] {
      const pointLookup = root as Document & {
        elementsFromPoint?: (x: number, y: number) => Element[];
        elementFromPoint?: (x: number, y: number) => Element | null;
      };
      let elements: Element[] = [];
      if (typeof pointLookup.elementsFromPoint === "function") {
        const result = pointLookup.elementsFromPoint(x, y);
        if (Array.isArray(result)) elements = result;
      }
      if (
        elements.length === 0 &&
        typeof pointLookup.elementFromPoint === "function"
      ) {
        const element = pointLookup.elementFromPoint(x, y);
        if (element) elements = [element];
      }
      const flattened: Element[] = [];
      const seen = new Set<Element>();
      for (const element of elements) {
        if (!(element instanceof Element) || seen.has(element)) continue;
        const shadow =
          element instanceof HTMLElement ? element.shadowRoot : null;
        if (shadow && !searched.has(shadow)) {
          searched.add(shadow);
          for (const nested of deepestElementsFromPoint(
            shadow,
            x,
            y,
            searched,
          )) {
            if (!seen.has(nested)) {
              seen.add(nested);
              flattened.push(nested);
            }
          }
        }
        if (seen.has(element)) continue;
        seen.add(element);
        flattened.push(element);
      }
      return flattened;
    }

    // True while mountOnTop hides and shows the host to stack it on top.
    let restacking = false;

    /**
     * Mounts the host by the mount rule. Moving an attached host goes through
     * moveBefore, which keeps the frame alive; append would reload it, and its
     * spent token would leave it blank until its port ends and it closes.
     * An open popover keeps its top-layer place, below a fullscreen element
     * entered since, so it is hidden and shown again on top. A page that
     * cancels the show in beforetoggle leaves the host in its own stacking,
     * where it can cover or mask it, so the palette closes then.
     */
    function mountOnTop(root: HTMLElement): void {
      const parent = mountParent();
      if (root.parentNode !== parent) {
        if (root.isConnected && "moveBefore" in parent)
          parent.moveBefore(root, null);
        else parent.append(root);
      }
      watchMountParent(root, parent);
      if (typeof root.showPopover !== "function") return;
      restacking = true;
      try {
        if (isOpenPopover(root)) root.hidePopover();
        root.showPopover();
      } catch {
        // The page moved the host out of the document.
      } finally {
        restacking = false;
      }
      if (!isOpenPopover(root)) {
        close(settled ? "closed" : "failed");
        return;
      }
      lockEscape();
    }

    function isOpenPopover(root: HTMLElement): boolean {
      try {
        return root.matches(":popover-open");
      } catch {
        return false;
      }
    }

    // Whether this host asked for a keyboard lock on Escape.
    let escapeLocked = false;

    /**
     * Chromium leaves element fullscreen on Escape before the page sees the
     * key unless Keyboard Lock holds it, so while the palette is open over a
     * fullscreen element, Escape is locked: it reaches the palette, and the
     * browser asks for a press and hold to leave fullscreen. Unlocking on
     * close also ends a lock the page held.
     */
    function lockEscape(): void {
      const keyboard = escapeKeyboard();
      if (!document.fullscreenElement || !keyboard) return;
      escapeLocked = true;
      keyboard.lock(["Escape"]).catch(() => {
        // The browser refused the lock.
      });
    }

    function unlockEscape(): void {
      if (!escapeLocked) return;
      escapeLocked = false;
      try {
        escapeKeyboard()?.unlock();
      } catch {
        // Nothing was locked.
      }
    }

    type EscapeKeyboard = {
      lock: (codes: string[]) => Promise<void>;
      unlock: () => void;
    };

    /** Keyboard Lock, which TypeScript's DOM types leave out. */
    function escapeKeyboard(): EscapeKeyboard | null {
      const { keyboard } = navigator as Navigator & {
        keyboard?: Partial<EscapeKeyboard>;
      };
      return typeof keyboard?.lock === "function" &&
        typeof keyboard.unlock === "function"
        ? (keyboard as EscapeKeyboard)
        : null;
    }

    // The host's listeners for a dialog close or a fullscreen change that
    // would leave it hidden.
    const parentWatches = new WeakMap<HTMLElement, () => void>();

    /**
     * A host in a modal dialog disappears when the page closes that dialog,
     * and a fullscreen element entered later covers it, so the parent dialog's
     * close and every fullscreen change mount the host again while the
     * palette is open. A page that also removed the dialog closes the
     * palette instead; unmount drops the watch.
     */
    function watchMountParent(root: HTMLElement, parent: Element): void {
      parentWatches.get(root)?.();
      const dialog = parent.localName === "dialog" ? parent : null;
      const remount = (): void => {
        if (closed) return;
        // A page that removed the dialog took the frame with it, and a frame
        // put back would reload blank with its token spent, so it closes.
        if (root.isConnected) mountOnTop(root);
        else close("closed");
      };
      document.addEventListener("fullscreenchange", remount);
      dialog?.addEventListener("close", remount);
      parentWatches.set(root, () => {
        parentWatches.delete(root);
        document.removeEventListener("fullscreenchange", remount);
        dialog?.removeEventListener("close", remount);
      });
    }

    /** Removes the host and its parent watch. */
    function unmount(root: HTMLElement): void {
      parentWatches.get(root)?.();
      root.remove();
    }

    const onMessage = (event: MessageEvent): void => {
      if (event.source !== iframe.contentWindow) return;
      if (event.origin !== frameOrigin) return;
      const data: unknown = event.data;
      if (typeof data !== "object" || data === null) return;
      const lens = (data as { lens?: unknown }).lens;
      if (lens === "ready") onReady();
      else if (lens === "close") {
        stopKeyUps((data as { held?: unknown }).held);
        close("closed");
      }
    };

    /**
     * Closing moves the focus to the page while the key that closed the
     * palette is still down, so that key's keyup would reach the page. One
     * capture listener on window stops it; a new press of the key ends the
     * wait, since its keyup then went elsewhere. A page's own capture
     * listener on window, added before this one, can still see that keyup.
     */
    const stopKeyUps = (held: unknown): void => {
      if (!Array.isArray(held)) return;
      const codes = new Set(
        held
          .slice(0, 8)
          .filter(
            (code): code is string =>
              typeof code === "string" && /^[A-Za-z0-9]{1,32}$/u.test(code),
          ),
      );
      if (codes.size === 0) return;
      const onKey = (event: KeyboardEvent): void => {
        if (!event.isTrusted || !codes.has(event.code)) return;
        if (event.type === "keyup") {
          event.stopImmediatePropagation();
          event.preventDefault();
        } else if (event.repeat) return;
        codes.delete(event.code);
        if (codes.size > 0) return;
        window.removeEventListener("keyup", onKey, true);
        window.removeEventListener("keydown", onKey, true);
      };
      window.addEventListener("keyup", onKey, true);
      window.addEventListener("keydown", onKey, true);
    };

    const onReady = (): void => {
      if (settled || closed) return;
      clearTimeout(timer);
      try {
        iframe.focus();
        port = chrome.runtime.connect({ name: `lens-palette:${token}` });
        // An extension reload ends the port; the frame must not stay behind.
        port.onDisconnect.addListener(() => close("closed"));
      } catch {
        close("failed");
        return;
      }
      document.addEventListener("focusin", onFocusIn, true);
      finish("ready");
    };

    // A page that takes focus once gets it back once.
    const onFocusIn = (event: FocusEvent): void => {
      if (refocused || event.target === root) return;
      refocused = true;
      document.removeEventListener("focusin", onFocusIn, true);
      iframe.focus();
    };

    const onVisibility = (): void => {
      if (document.hidden) close("closed");
    };

    // The host's own inline declarations, taken once they are set.
    let hostStyle = new Map<string, string>();
    const inlineStyle = (): Map<string, string> => {
      const declarations = new Map<string, string>();
      for (let index = 0; index < root.style.length; index += 1) {
        const name = root.style.item(index);
        if (name.startsWith("--")) continue;
        declarations.set(
          name,
          `${root.style.getPropertyValue(name)} ${root.style.getPropertyPriority(name)}`,
        );
      }
      return declarations;
    };

    /**
     * IntersectionObserver v2 in the frame does not see a CSS mask and lets a
     * 2D translation through, so the palette closes when the page changes the
     * host's inline style or popover attribute. Custom properties are left
     * out: a dark-mode extension may add some, and the host uses none.
     */
    const styleWatch = new MutationObserver((records) => {
      const now = inlineStyle();
      if (
        records.some((record) => record.attributeName === "popover") ||
        now.size !== hostStyle.size ||
        [...now].some(([name, value]) => hostStyle.get(name) !== value)
      )
        close("closed");
    });

    /**
     * A host the page hides leaves the top layer, where the page's own styles
     * reach it through a parent, so any hide but mountOnTop's own closes the
     * palette. beforetoggle fires inside hidePopover, before the page script
     * can move the host; the close waits for that call to return.
     */
    const onBeforeToggle = (event: Event): void => {
      if (restacking || (event as ToggleEvent).newState !== "closed") return;
      queueMicrotask(() => close("closed"));
    };

    const close = (status: PaletteHostStatus): void => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      styleWatch.disconnect();
      root.removeEventListener("beforetoggle", onBeforeToggle);
      if (scope[HOST_KEY] === host) delete scope[HOST_KEY];
      window.removeEventListener("message", onMessage, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("visibilitychange", onVisibility, true);
      try {
        port?.disconnect();
      } catch {
        // The extension is already gone.
      }
      port = null;
      try {
        if (root.matches(":popover-open")) root.hidePopover();
      } catch {
        // No popover support.
      }
      unlockEscape();
      unmount(root);
      if (
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        previousFocus !== document.body
      ) {
        try {
          previousFocus.focus({ preventScroll: true });
        } catch {
          // The page refused focus.
        }
      }
      finish(status);
    };

    const host: LiveHost = {
      close: () => close("closed"),
      isConnected: () => root.isConnected,
    };
    const timer = setTimeout(() => close("timeout"), readyTimeoutMs);

    try {
      root.setAttribute("popover", "manual");
      root.dataset["provenanceLensPalette"] = "host";
      // Inline !important, so a page stylesheet cannot hide, move or shrink
      // the host. A page script that restyles it closes the palette, and one
      // that covers it is caught by IntersectionObserver v2 in the frame.
      setImportant(root, {
        all: "initial",
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        "max-width": "none",
        "max-height": "none",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        display: "block",
        "z-index": "2147483647",
        overflow: "hidden",
        visibility: "visible",
        opacity: "1",
        transform: "none",
        "pointer-events": "auto",
        "color-scheme": "light dark",
      });
      hostStyle = inlineStyle();
      styleWatch.observe(root, {
        attributes: true,
        attributeFilter: ["style", "popover"],
      });
      root.addEventListener("beforetoggle", onBeforeToggle);
      const shadow = root.attachShadow({ mode: "closed" });
      iframe.src = frameUrl;
      iframe.title = "Provenance Lens";
      setImportant(iframe, {
        all: "initial",
        position: "fixed",
        inset: "0",
        width: "100%",
        height: "100%",
        border: "0",
        margin: "0",
        padding: "0",
        display: "block",
        background: "transparent",
        // A scheme that differs from the frame's paints an opaque canvas.
        "color-scheme": "light dark",
      });
      shadow.append(iframe);
      window.addEventListener("message", onMessage, true);
      document.addEventListener("visibilitychange", onVisibility, true);
      scope[HOST_KEY] = host;
      mountOnTop(root);
    } catch {
      close("failed");
    }
  });
}
