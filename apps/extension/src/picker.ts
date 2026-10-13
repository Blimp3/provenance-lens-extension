import {
  MAX_INLINE_IMAGE_BYTES,
  PICKER_RUNTIME_VERSION,
  PickerRuntimeMessageSchema,
  sanitizeDisplayText,
  validateInlineImageSize,
  validateImageBytes,
  type ImageSelection,
  type PickerLabel,
  type PickerRuntimeMessage,
  type ToastAction,
  type ToastTone,
} from "@provenance-lens/shared";

import { readBoundedResponseBytes } from "./bounded-response.js";
import {
  linkCandidateFor,
  type LinkCandidate,
} from "./page-link-candidates.js";
import { LENS_FONT, LENS_MONO_FONT, lensTokenSet } from "./ui/tokens.js";

type ImageCandidate = {
  kind: "image";
  element: Element;
  url: string;
  sourceKind: ImageSelection["sourceKind"];
};
/** Image mode picks an image's bytes; link mode picks a post or page link. */
type PickCandidate = ImageCandidate | ({ kind: "link" } & LinkCandidate);
type PickerMode = "image" | "link";

type PickerOverlay = {
  root: HTMLElement;
  shadowRoot: ShadowRoot;
  dimmers: HTMLDivElement[];
  focus: HTMLDivElement;
  label: HTMLDivElement;
  stopTheme: () => void;
};

type PickerBanner = {
  root: HTMLElement;
  warn: (text: string) => void;
  remove: () => void;
};

type PickerState = {
  sessionToken: string;
  mode: PickerMode;
  label: PickerLabel;
  overlay: PickerOverlay;
  banner: PickerBanner;
  previousCursor: string;
  candidate: PickCandidate | null;
  cleanup: () => void;
};

type ShowToastMessage = Extract<PickerRuntimeMessage, { type: "show-toast" }>;

type PageToast = {
  root: HTMLElement;
  region: HTMLElement;
  /** The run whose toast this is now; a hide for another run leaves it. */
  sessionToken: string;
  render: (message: ShowToastMessage) => void;
  cleanup: () => void;
};

type IconName =
  | "check"
  | "shield-check"
  | "info"
  | "clock"
  | "alert-triangle"
  | "x"
  | "download"
  | "film"
  | "external";

declare global {
  interface Window {
    __provenanceLensPickerInstalled?: boolean | string;
  }
}

if (window.__provenanceLensPickerInstalled !== PICKER_RUNTIME_VERSION) {
  window.__provenanceLensPickerInstalled = PICKER_RUNTIME_VERSION;
  let activePicker: PickerState | null = null;
  let activeToast: PageToast | null = null;
  let boundSessionToken: string | null = null;
  // Every run bound in this document may still report on the page's toast:
  // a page-link send binds the page again while a verification still runs.
  // Only the latest binding may start the picker.
  const boundSessionTokens = new Set<string>();
  const MAX_BOUND_SESSION_TOKENS = 16;

  const BANNER_TEXT: Record<
    PickerLabel,
    { name: string; target: string; icon: IconName }
  > = {
    verify: { name: "Verify", target: "Click an image", icon: "shield-check" },
    "send-image": {
      name: "Send image",
      target: "Click an image",
      icon: "download",
    },
    "send-video": {
      name: "Send video",
      target: "Click a post with a video",
      icon: "film",
    },
    synthid: {
      name: "Google SynthID",
      target: "Click an image",
      icon: "external",
    },
  };
  const HOVER_VERB: Record<PickerLabel, string> = {
    verify: "Click to verify",
    "send-image": "Click to send",
    "send-video": "Click to send",
    synthid: "Click to save",
  };
  const TOAST_TONE: Record<ToastTone, { color: string; icon: IconName }> = {
    success: { color: "var(--lens-ok)", icon: "check" },
    detected: { color: "var(--lens-ok)", icon: "shield-check" },
    "no-signal": { color: "var(--lens-neutral)", icon: "info" },
    pending: { color: "var(--lens-neutral)", icon: "clock" },
    progress: { color: "var(--lens-accent)", icon: "clock" },
    error: { color: "var(--lens-danger)", icon: "alert-triangle" },
  };
  const TOAST_BUTTON_TEXT: Record<ToastAction, string> = {
    details: "Details",
    history: "History",
    cancel: "Cancel",
    "stop-waiting": "Stop waiting",
    retry: "Retry",
    "connect-digibot": "Connect DigiBot",
    "grant-access": "Grant access",
    "switch-to-api": "Switch to API",
    "check-synthid": "Also check with Google ↗",
  };
  // 16px icons on a 24 viewBox, 1.5 stroke.
  const ICON_PATHS: Record<IconName, readonly string[]> = {
    check: ["M5 12.5l4.5 4.5L19 7.5"],
    "shield-check": [
      "M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z",
      "M8.75 12.25l2.25 2.25 4.25-4.5",
    ],
    info: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 11v5", "M12 8h.01"],
    clock: ["M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z", "M12 7v5l3 2"],
    "alert-triangle": [
      "M10.3 4.2L2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
      "M12 9.5v4",
      "M12 17h.01",
    ],
    x: ["M6 6l12 12", "M18 6L6 18"],
    download: ["M12 4v11", "M7.5 10.5L12 15l4.5-4.5", "M5 19h14"],
    film: [
      "M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z",
      "M8 4v16",
      "M16 4v16",
      "M4 9h4",
      "M4 15h4",
      "M16 9h4",
      "M16 15h4",
    ],
    external: [
      "M14 4h6v6",
      "M20 4l-9 9",
      "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    ],
  };
  const FULLSCREEN_MEDIA_ELEMENTS = new Set([
    "video",
    "img",
    "iframe",
    "embed",
    "object",
    "canvas",
  ]);
  const SUCCESS_TOAST_MS = 6_000;
  const BANNER_WARNING_MS = 2_000;

  chrome.runtime.onMessage.addListener((message: unknown) => {
    const parsed = PickerRuntimeMessageSchema.safeParse(message);
    if (!parsed.success) return;
    switch (parsed.data.type) {
      case "page-bind":
        if (activePicker?.sessionToken !== parsed.data.sessionToken) {
          activePicker?.cleanup();
          activePicker = null;
        }
        boundSessionToken = parsed.data.sessionToken;
        boundSessionTokens.add(parsed.data.sessionToken);
        if (boundSessionTokens.size > MAX_BOUND_SESSION_TOKENS) {
          const oldest = boundSessionTokens.values().next().value;
          if (oldest !== undefined) boundSessionTokens.delete(oldest);
        }
        return;
      case "picker-start": {
        if (boundSessionToken !== parsed.data.sessionToken) return;
        const mode = parsed.data.mode ?? "image";
        startPicker(
          parsed.data.sessionToken,
          mode,
          parsed.data.label ?? (mode === "link" ? "send-video" : "verify"),
        );
        return;
      }
      case "picker-stop":
        if (activePicker?.sessionToken === parsed.data.sessionToken) {
          activePicker.cleanup();
          activePicker = null;
        }
        return;
      case "show-toast":
        if (boundSessionTokens.has(parsed.data.sessionToken)) {
          showToast(parsed.data);
        }
        return;
      case "hide-toast":
        if (activeToast?.sessionToken === parsed.data.sessionToken) {
          activeToast.cleanup();
        }
        return;
    }
  });

  function startPicker(
    sessionToken: string,
    mode: PickerMode,
    label: PickerLabel,
  ): void {
    activePicker?.cleanup();
    const overlay = createPickerOverlay(mode);
    const banner = createPickerBanner(label);

    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    const state: PickerState = {
      sessionToken,
      mode,
      label,
      overlay,
      banner,
      previousCursor,
      candidate: null,
      cleanup: () => undefined,
    };

    let closed = false;
    let latestPointer: { x: number; y: number } | null = null;
    let pendingFrame: number | null = null;
    let pendingFrameKind: "animation" | "timeout" | null = null;

    const renderCandidate = (): void => {
      pendingFrame = null;
      pendingFrameKind = null;
      if (closed || !latestPointer) return;
      const candidate = candidateAt(latestPointer.x, latestPointer.y, mode);
      state.candidate = candidate;
      if (candidate) {
        renderOverlay(overlay, candidate, HOVER_VERB[label]);
      } else {
        overlay.root.style.setProperty("display", "none", "important");
      }
    };

    const cancelPendingRender = (): void => {
      if (pendingFrame === null) return;
      if (
        pendingFrameKind === "animation" &&
        typeof window.cancelAnimationFrame === "function"
      ) {
        window.cancelAnimationFrame(pendingFrame);
      } else {
        window.clearTimeout(pendingFrame);
      }
      pendingFrame = null;
      pendingFrameKind = null;
    };

    const scheduleRender = (): void => {
      if (pendingFrame !== null) return;
      if (typeof window.requestAnimationFrame === "function") {
        pendingFrameKind = "animation";
        pendingFrame = window.requestAnimationFrame(renderCandidate);
      } else {
        // jsdom and a few embedded Chromium contexts do not expose rAF. Keep
        // the same one-render-per-turn behavior for those environments.
        pendingFrameKind = "timeout";
        pendingFrame = window.setTimeout(renderCandidate, 0);
      }
    };

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      cancelPendingRender();
      latestPointer = null;
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", consumeHostGesture, true);
      document.removeEventListener("pointerup", consumeHostGesture, true);
      document.removeEventListener("mousedown", consumeHostGesture, true);
      document.removeEventListener("mouseup", consumeHostGesture, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.documentElement.style.cursor = state.previousCursor;
      overlay.stopTheme();
      overlay.root.remove();
      banner.remove();
      state.candidate = null;
    };
    state.cleanup = cleanup;
    activePicker = state;

    document.addEventListener("pointermove", onPointerMove, {
      capture: true,
      passive: true,
    });
    document.addEventListener("pointerdown", consumeHostGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("pointerup", consumeHostGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("mousedown", consumeHostGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("mouseup", consumeHostGesture, {
      capture: true,
      passive: false,
    });
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);

    function onPointerMove(event: PointerEvent): void {
      latestPointer = { x: event.clientX, y: event.clientY };
      scheduleRender();
    }

    function consumeHostGesture(event: PointerEvent | MouseEvent): void {
      if (closed || !event.isTrusted || targetsToast(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function onClick(event: MouseEvent): void {
      // The toast's buttons stay usable while the picker is armed.
      if (closed || !event.isTrusted || targetsToast(event)) return;
      const candidate = candidateAt(event.clientX, event.clientY, mode);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!candidate) {
        banner.warn(
          mode === "link"
            ? "This post shows no video"
            : "No supported image here",
        );
        return;
      }
      state.candidate = candidate;
      if (candidate.kind === "link") {
        cleanup();
        activePicker = null;
        void chrome.runtime.sendMessage({
          type: "picker-link-selected",
          sessionToken,
          url: candidate.url,
        });
        return;
      }
      const selection = makeSelection(candidate);
      cleanup();
      activePicker = null;
      void addInlineBytes(selection)
        .then((finalSelection) => {
          void chrome.runtime.sendMessage({
            type: "picker-selected",
            sessionToken,
            selection: finalSelection,
          });
        })
        .catch(() => {
          void chrome.runtime.sendMessage({
            type: "picker-selected",
            sessionToken,
            selection,
          });
        });
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      activePicker = null;
      void chrome.runtime.sendMessage({
        type: "picker-cancelled",
        sessionToken,
      });
    }
  }

  function targetsToast(event: Event): boolean {
    // A closed shadow root retargets its events to the toast's host element.
    return activeToast !== null && event.target === activeToast.root;
  }

  /**
   * The mount rule: a surface outside a fullscreen element or a modal dialog
   * is hidden or inert, so it goes inside them, and then into the top layer
   * as a manual popover.
   */
  function mountParent(): Element {
    const fullscreen = fullscreenElement();
    if (fullscreen && !FULLSCREEN_MEDIA_ELEMENTS.has(fullscreen.localName)) {
      return fullscreen;
    }
    const dialog = topmostModalDialog();
    if (dialog) return dialog;
    return document.documentElement ?? document.body;
  }

  /** The fullscreen element itself, also inside open shadow roots. */
  function fullscreenElement(): Element | null {
    let element = document.fullscreenElement;
    while (element?.shadowRoot?.fullscreenElement)
      element = element.shadowRoot.fullscreenElement;
    return element;
  }

  /**
   * The modal dialog on top holds the focused element, so this starts there
   * and looks through open shadow roots and across their hosts. With no focus
   * inside a modal dialog, it takes the last one in document order.
   */
  function topmostModalDialog(): Element | null {
    try {
      let focused = document.activeElement;
      while (focused?.shadowRoot?.activeElement)
        focused = focused.shadowRoot.activeElement;
      for (let node: Element | null = focused; node;) {
        const dialog = node.closest("dialog:modal");
        if (dialog) return dialog;
        const root = node.getRootNode();
        node = root instanceof ShadowRoot ? root.host : null;
      }
      return (
        Array.from(document.querySelectorAll("dialog:modal")).at(-1) ?? null
      );
    } catch {
      return null;
    }
  }

  function mountOnTop(root: HTMLElement): void {
    const parent = mountParent();
    if (root.parentNode !== parent) parent.append(root);
    if (typeof root.showPopover !== "function") return;
    try {
      root.showPopover();
    } catch {
      // Already in the top layer, or the browser has no popover support.
    }
  }

  function createSurfaceRoot(dataName: string, value: string): HTMLElement {
    const root = document.createElement("div");
    root.dataset[dataName] = value;
    root.setAttribute("popover", "manual");
    return root;
  }

  function mediaQuery(query: string): MediaQueryList | null {
    if (typeof window.matchMedia !== "function") return null;
    try {
      return window.matchMedia(query);
    } catch {
      return null;
    }
  }

  function prefersReducedMotion(): boolean {
    return mediaQuery("(prefers-reduced-motion: reduce)")?.matches === true;
  }

  /** Sets the light or dark Lens tokens on a surface and follows changes. */
  function followTheme(element: HTMLElement): () => void {
    const dark = mediaQuery("(prefers-color-scheme: dark)");
    const forced = mediaQuery("(forced-colors: active)");
    const apply = (): void => {
      const tokens = lensTokenSet(
        dark?.matches === true,
        forced?.matches === true,
      );
      for (const [name, value] of Object.entries(tokens)) {
        element.style.setProperty(name, value);
      }
    };
    apply();
    dark?.addEventListener("change", apply);
    forced?.addEventListener("change", apply);
    return () => {
      dark?.removeEventListener("change", apply);
      forced?.removeEventListener("change", apply);
    };
  }

  function icon(name: IconName, size: number): SVGSVGElement {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    for (const [attribute, value] of Object.entries({
      viewBox: "0 0 24 24",
      width: String(size),
      height: String(size),
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.5",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    })) {
      svg.setAttribute(attribute, value);
    }
    svg.style.display = "block";
    svg.style.flex = "none";
    for (const path of ICON_PATHS[name]) {
      const element = document.createElementNS(namespace, "path");
      element.setAttribute("d", path);
      svg.append(element);
    }
    return svg;
  }

  function createPickerOverlay(mode: PickerMode): PickerOverlay {
    const root = createSurfaceRoot("provenanceLensPicker", "overlay");
    root.setAttribute("aria-label", pickerName(mode));
    setImportantStyles(root, {
      all: "initial",
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      left: "0",
      "z-index": "2147483647",
      display: "none",
      "pointer-events": "none",
      overflow: "hidden",
      isolation: "isolate",
      contain: "layout style paint",
      width: "auto",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      opacity: "1",
      visibility: "visible",
      transform: "none",
      transition: "none",
      animation: "none",
    });

    // A closed shadow tree prevents page styles and scripts from changing the
    // picker surface. The host's security-critical declarations are also
    // inline !important so ordinary author CSS cannot make it intercept hits.
    const shadowRoot = root.attachShadow({ mode: "closed" });
    const surface = document.createElement("div");
    Object.assign(surface.style, {
      position: "fixed",
      inset: "0",
      display: "block",
      pointerEvents: "none",
      overflow: "hidden",
      isolation: "isolate",
      fontFamily: LENS_FONT,
    });
    const stopTheme = followTheme(surface);
    shadowRoot.append(surface);

    const dimmers = (["top", "right", "bottom", "left"] as const).map(
      (side) => {
        const dimmer = document.createElement("div");
        dimmer.dataset["pickerDimmer"] = side;
        Object.assign(dimmer.style, {
          position: "fixed",
          display: "none",
          pointerEvents: "none",
          background: "var(--lens-scrim)",
        });
        surface.append(dimmer);
        return dimmer;
      },
    );

    const focus = document.createElement("div");
    focus.dataset["pickerFocus"] = "true";
    Object.assign(focus.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      boxSizing: "border-box",
      border: "2px solid var(--lens-accent)",
      borderRadius: "4px",
      boxShadow: "0 0 0 1px var(--lens-surface)",
    });
    surface.append(focus);

    const label = document.createElement("div");
    label.dataset["pickerLabel"] = "true";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    Object.assign(label.style, {
      position: "fixed",
      display: "none",
      pointerEvents: "none",
      boxSizing: "border-box",
      maxWidth: "calc(100vw - 16px)",
      overflow: "hidden",
      padding: "6px 10px",
      border: "1px solid var(--lens-line)",
      borderRadius: "6px",
      background: "var(--lens-surface)",
      color: "var(--lens-text)",
      font: `500 12px/16px ${LENS_FONT}`,
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      boxShadow: "var(--lens-shadow)",
    });
    surface.append(label);

    mountOnTop(root);
    return { root, shadowRoot, dimmers, focus, label, stopTheme };
  }

  function createPickerBanner(label: PickerLabel): PickerBanner {
    const root = createSurfaceRoot("provenanceLensPicker", "banner");
    setImportantStyles(root, {
      all: "initial",
      position: "fixed",
      top: "16px",
      right: "16px",
      bottom: "auto",
      left: "16px",
      "z-index": "2147483647",
      display: "flex",
      "justify-content": "center",
      "pointer-events": "none",
      width: "auto",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      opacity: "1",
      visibility: "visible",
      transform: "none",
      transition: "none",
      animation: "none",
      direction: "ltr",
      isolation: "isolate",
    });

    const shadowRoot = root.attachShadow({ mode: "closed" });
    const pill = document.createElement("div");
    pill.dataset["pickerBanner"] = "true";
    pill.setAttribute("role", "status");
    pill.setAttribute("aria-live", "polite");
    Object.assign(pill.style, {
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      gap: "8px",
      height: "36px",
      maxWidth: "100%",
      padding: "0 16px 0 12px",
      border: "1px solid var(--lens-line)",
      borderRadius: "18px",
      background: "var(--lens-surface)",
      color: "var(--lens-text)",
      boxShadow: "var(--lens-shadow)",
      font: `400 13px/18px ${LENS_FONT}`,
      whiteSpace: "nowrap",
      overflow: "hidden",
      pointerEvents: "none",
    });
    const stopTheme = followTheme(pill);
    shadowRoot.append(pill);

    const text = BANNER_TEXT[label];
    const renderNormal = (): void => {
      pill.dataset["pickerBannerState"] = "armed";
      pill.style.borderColor = "var(--lens-line)";
      pill.style.background = "var(--lens-surface)";
      pill.style.color = "var(--lens-text)";
      const name = document.createElement("strong");
      name.textContent = text.name;
      name.style.fontWeight = "600";
      const key = document.createElement("kbd");
      key.textContent = "Esc";
      Object.assign(key.style, {
        padding: "0 4px",
        border: "1px solid var(--lens-line-strong)",
        borderRadius: "4px",
        background: "var(--lens-kbd-bg)",
        color: "var(--lens-kbd-text)",
        font: `500 11px/16px ${LENS_MONO_FONT}`,
      });
      const line = document.createElement("span");
      line.style.overflow = "hidden";
      line.style.textOverflow = "ellipsis";
      line.append(name, ` · ${text.target} · `, key, " to cancel");
      pill.replaceChildren(icon(text.icon, 16), line);
    };
    renderNormal();

    let warningTimer: number | null = null;
    const clearWarning = (): void => {
      if (warningTimer === null) return;
      window.clearTimeout(warningTimer);
      warningTimer = null;
    };
    mountOnTop(root);
    return {
      root,
      warn: (message) => {
        clearWarning();
        pill.dataset["pickerBannerState"] = "warning";
        pill.style.borderColor = "var(--lens-warn)";
        pill.style.background = "var(--lens-warn-soft)";
        pill.style.color = "var(--lens-warn)";
        const line = document.createElement("span");
        line.textContent = message;
        line.style.fontWeight = "600";
        pill.replaceChildren(icon("alert-triangle", 16), line);
        warningTimer = window.setTimeout(() => {
          warningTimer = null;
          renderNormal();
        }, BANNER_WARNING_MS);
      },
      remove: () => {
        clearWarning();
        stopTheme();
        root.remove();
      },
    };
  }

  function showToast(message: ShowToastMessage): void {
    // A result replaces the progress toast in place, without a new entrance.
    const entering = activeToast === null;
    const toast = activeToast ?? createToast();
    activeToast = toast;
    toast.sessionToken = message.sessionToken;
    toast.render(message);
    mountOnTop(toast.root);
    if (entering && !prefersReducedMotion()) {
      animate(
        toast.region,
        [
          { opacity: 0, transform: "translateY(-8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  }

  function createToast(): PageToast {
    const root = createSurfaceRoot("provenanceLensToast", "true");
    setImportantStyles(root, {
      all: "initial",
      position: "fixed",
      top: "16px",
      right: "16px",
      bottom: "auto",
      left: "auto",
      "z-index": "2147483647",
      display: "block",
      width: "min(380px, calc(100vw - 32px))",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      background: "transparent",
      overflow: "visible",
      opacity: "1",
      visibility: "visible",
      transform: "none",
      transition: "none",
      animation: "none",
      direction: "ltr",
      isolation: "isolate",
      contain: "layout style paint",
      "pointer-events": "none",
    });

    const shadowRoot = root.attachShadow({ mode: "closed" });
    const region = document.createElement("section");
    region.dataset["toastRegion"] = "true";
    region.setAttribute("aria-atomic", "true");
    Object.assign(region.style, {
      pointerEvents: "auto",
      position: "relative",
      boxSizing: "border-box",
      display: "grid",
      gridTemplateColumns: "20px minmax(0, 1fr) 24px",
      columnGap: "12px",
      alignItems: "start",
      width: "100%",
      padding: "12px 12px 12px 16px",
      overflow: "hidden",
      border: "1px solid var(--lens-line)",
      borderRadius: "12px",
      background: "var(--lens-surface)",
      color: "var(--lens-text)",
      boxShadow: "var(--lens-shadow)",
      font: `400 13px/18px ${LENS_FONT}`,
      textAlign: "left",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
    });
    const stopTheme = followTheme(region);
    shadowRoot.append(region);
    // Page handlers in the bubble phase, the modal dialog the toast sits in
    // among them, do not see toast input. Capture-phase listeners on window
    // or document can still see a click on the toast host.
    for (const type of [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "auxclick",
      "contextmenu",
      "keydown",
      "keyup",
    ])
      region.addEventListener(type, (event) => event.stopPropagation());

    // Success hides after 6 s; hover or keyboard focus pauses the countdown.
    // A new render can remove the hovered or focused button without a
    // pointerleave or focusout, so the end of the countdown checks again.
    let hideTimer: number | null = null;
    let remainingMs = 0;
    let startedAt = 0;
    const stopTimer = (): void => {
      if (hideTimer === null) return;
      window.clearTimeout(hideTimer);
      hideTimer = null;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAt));
    };
    const runTimer = (): void => {
      if (hideTimer !== null || remainingMs <= 0) return;
      startedAt = Date.now();
      hideTimer = window.setTimeout(expire, remainingMs);
    };
    const expire = (): void => {
      hideTimer = null;
      if (region.matches(":hover, :focus-within")) {
        remainingMs = SUCCESS_TOAST_MS;
        runTimer();
        return;
      }
      cleanup();
    };
    region.addEventListener("pointerenter", stopTimer);
    region.addEventListener("pointerleave", runTimer);
    region.addEventListener("focusin", stopTimer);
    region.addEventListener("focusout", (event) => {
      if (
        event.relatedTarget instanceof Node &&
        region.contains(event.relatedTarget)
      )
        return;
      runTimer();
    });

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
      stopTheme();
      root.remove();
      if (activeToast?.root === root) activeToast = null;
    };

    const render = (message: ShowToastMessage): void => {
      if (hideTimer !== null) window.clearTimeout(hideTimer);
      hideTimer = null;
      const tone = TOAST_TONE[message.tone];
      region.dataset["toastTone"] = message.tone;
      region.setAttribute(
        "role",
        message.tone === "error" ? "alert" : "status",
      );
      region.setAttribute(
        "aria-live",
        message.tone === "error" ? "assertive" : "polite",
      );

      const toneBar = document.createElement("div");
      toneBar.dataset["toastToneBar"] = "true";
      Object.assign(toneBar.style, {
        position: "absolute",
        top: "0",
        bottom: "0",
        left: "0",
        width: "3px",
        background: tone.color,
      });

      const titleText = sanitizeDisplayText(message.title, 100);
      const toneIcon = document.createElement("span");
      Object.assign(toneIcon.style, {
        display: "block",
        width: "20px",
        height: "20px",
        color: tone.color,
      });
      if (message.tone === "progress") {
        toneIcon.dataset["toastSpinner"] = "true";
        toneIcon.setAttribute("role", "progressbar");
        toneIcon.setAttribute("aria-label", titleText);
        if (prefersReducedMotion()) {
          toneIcon.textContent = "…";
          toneIcon.style.font = `600 14px/20px ${LENS_FONT}`;
          toneIcon.style.textAlign = "center";
        } else {
          const ring = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "svg",
          );
          for (const [attribute, value] of Object.entries({
            viewBox: "0 0 24 24",
            width: "20",
            height: "20",
            fill: "none",
            stroke: "currentColor",
            "stroke-width": "2",
            "stroke-linecap": "round",
            "aria-hidden": "true",
            focusable: "false",
          })) {
            ring.setAttribute(attribute, value);
          }
          ring.style.display = "block";
          const arc = document.createElementNS(
            "http://www.w3.org/2000/svg",
            "path",
          );
          arc.setAttribute("d", "M12 3a9 9 0 1 1-9 9");
          ring.append(arc);
          toneIcon.append(ring);
          animate(
            toneIcon,
            [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }],
            { duration: 800, easing: "linear", iterations: Infinity },
          );
        }
      } else {
        toneIcon.append(icon(tone.icon, 20));
      }

      const content = document.createElement("div");
      Object.assign(content.style, {
        display: "grid",
        gap: "2px",
        minWidth: "0",
      });
      const title = document.createElement("span");
      title.dataset["toastTitle"] = "true";
      title.textContent = titleText;
      Object.assign(title.style, {
        display: "block",
        color: "var(--lens-text)",
        font: `600 14px/20px ${LENS_FONT}`,
      });
      const body = document.createElement("span");
      body.dataset["toastMessage"] = "true";
      body.textContent = sanitizeDisplayText(message.message, 512);
      Object.assign(body.style, {
        display: "block",
        color: "var(--lens-muted)",
        font: `400 13px/18px ${LENS_FONT}`,
      });
      content.append(title, body);

      const actions = (message.actions ?? []).filter(
        (action) => action !== "details" || message.resultId !== null,
      );
      if (actions.length > 0) {
        const row = document.createElement("div");
        Object.assign(row.style, {
          display: "flex",
          flexWrap: "wrap",
          gap: "4px",
          margin: "6px 0 0 -8px",
        });
        for (const action of actions) {
          const button = toastButton(TOAST_BUTTON_TEXT[action]);
          button.dataset["toastAction"] = action;
          button.addEventListener("click", () => {
            // A page can restyle the host to hide a button under a lure.
            const style = window.getComputedStyle(root);
            if (style.opacity !== "1" || style.visibility !== "visible") return;
            void chrome.runtime
              .sendMessage(
                action === "details"
                  ? {
                      type: "open-result-details",
                      sessionToken: message.sessionToken,
                      resultId: message.resultId,
                    }
                  : {
                      type: "toast-action",
                      sessionToken: message.sessionToken,
                      action,
                    },
              )
              .catch(() => undefined);
          });
          row.append(button);
        }
        content.append(row);
      }

      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.dataset["toastDismiss"] = "true";
      dismiss.setAttribute("aria-label", "Dismiss Provenance Lens result");
      Object.assign(dismiss.style, {
        appearance: "none",
        display: "grid",
        placeItems: "center",
        width: "24px",
        height: "24px",
        margin: "-2px 0 0",
        padding: "0",
        border: "0",
        borderRadius: "6px",
        background: "transparent",
        color: "var(--lens-muted)",
        cursor: "pointer",
      });
      dismiss.append(icon("x", 16));
      dismiss.addEventListener("click", cleanup, { once: true });
      hoverFill(dismiss);

      region.replaceChildren(toneBar, toneIcon, content, dismiss);
      remainingMs = message.tone === "success" ? SUCCESS_TOAST_MS : 0;
      runTimer();
    };

    return { root, region, sessionToken: "", render, cleanup };
  }

  function toastButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    Object.assign(button.style, {
      appearance: "none",
      boxSizing: "border-box",
      margin: "0",
      padding: "4px 8px",
      border: "0",
      borderRadius: "6px",
      background: "transparent",
      color: "var(--lens-accent)",
      cursor: "pointer",
      font: `600 13px/18px ${LENS_FONT}`,
    });
    hoverFill(button);
    return button;
  }

  function hoverFill(button: HTMLButtonElement): void {
    button.addEventListener("pointerenter", () => {
      button.style.background = "var(--lens-hover)";
    });
    button.addEventListener("pointerleave", () => {
      button.style.background = "transparent";
    });
  }

  function animate(
    element: HTMLElement,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ): void {
    if (typeof element.animate !== "function") return;
    try {
      element.animate(keyframes, options);
    } catch {
      // Motion is decoration; the toast works without it.
    }
  }

  function setImportantStyles(
    element: HTMLElement,
    styles: Record<string, string>,
  ): void {
    for (const [property, value] of Object.entries(styles)) {
      element.style.setProperty(property, value, "important");
    }
  }

  function renderOverlay(
    overlay: PickerOverlay,
    candidate: PickCandidate,
    verb: string,
  ): void {
    const rect = candidate.element.getBoundingClientRect();
    const viewportWidth = Math.max(1, window.innerWidth);
    const viewportHeight = Math.max(1, window.innerHeight);
    const left = clamp(rect.left, 0, viewportWidth);
    const top = clamp(rect.top, 0, viewportHeight);
    const right = clamp(
      Number.isFinite(rect.right) ? rect.right : rect.left + rect.width,
      left,
      viewportWidth,
    );
    const bottom = clamp(
      Number.isFinite(rect.bottom) ? rect.bottom : rect.top + rect.height,
      top,
      viewportHeight,
    );
    const [topDimmer, rightDimmer, bottomDimmer, leftDimmer] = overlay.dimmers;
    if (!topDimmer || !rightDimmer || !bottomDimmer || !leftDimmer) return;

    overlay.root.style.setProperty("display", "block", "important");
    setOverlayRect(topDimmer, 0, 0, viewportWidth, top);
    setOverlayRect(
      rightDimmer,
      right,
      top,
      viewportWidth - right,
      bottom - top,
    );
    setOverlayRect(
      bottomDimmer,
      0,
      bottom,
      viewportWidth,
      viewportHeight - bottom,
    );
    setOverlayRect(leftDimmer, 0, top, left, bottom - top);
    setOverlayRect(overlay.focus, left, top, right - left, bottom - top);

    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const labelText =
      candidate.kind === "link"
        ? `Post link · ${candidate.host} · ${verb} · Esc to cancel`
        : `${pickerKindLabel(candidate.sourceKind)} · ${width} × ${height} px · ${verb} · Esc to cancel`;
    overlay.label.textContent = labelText;
    overlay.root.setAttribute(
      "aria-label",
      `${pickerName(candidate.kind)}. ${labelText}`,
    );
    if (candidate.kind === "link") {
      overlay.label.dataset["linkHost"] = candidate.host;
    } else {
      overlay.label.dataset["imageKind"] = candidate.sourceKind;
      overlay.label.dataset["imageWidth"] = String(width);
      overlay.label.dataset["imageHeight"] = String(height);
    }
    overlay.label.style.display = "block";

    const labelWidth = Math.max(
      180,
      overlay.label.getBoundingClientRect().width || 320,
    );
    const labelHeight = Math.max(
      30,
      overlay.label.getBoundingClientRect().height || 30,
    );
    const maxLabelLeft = Math.max(8, viewportWidth - labelWidth - 8);
    const labelLeft = clamp(left, 8, maxLabelLeft);
    const preferredTop = top - labelHeight - 8;
    const maxLabelTop = Math.max(8, viewportHeight - labelHeight - 8);
    const labelTop =
      preferredTop >= 8 ? preferredTop : clamp(bottom + 8, 8, maxLabelTop);
    overlay.label.style.left = `${labelLeft}px`;
    overlay.label.style.top = `${labelTop}px`;
  }

  function setOverlayRect(
    element: HTMLDivElement,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void {
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.width = `${Math.max(0, width)}px`;
    element.style.height = `${Math.max(0, height)}px`;
    element.style.display = width > 0 && height > 0 ? "block" : "none";
  }

  function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(
      maximum,
      Math.max(minimum, Number.isFinite(value) ? value : minimum),
    );
  }

  function pickerName(mode: PickerMode): string {
    return mode === "link"
      ? "Provenance Lens video picker"
      : "Provenance Lens image picker";
  }

  function pickerKindLabel(sourceKind: ImageSelection["sourceKind"]): string {
    switch (sourceKind) {
      case "background-image":
        return "Background image";
      case "video-poster":
        return "Video poster";
      case "picture":
        return "Picture image";
      case "data-url":
        return "Inline image";
      case "blob-url":
        return "Blob image";
      default:
        return "Image";
    }
  }

  function candidateAt(
    clientX: number,
    clientY: number,
    mode: PickerMode,
  ): PickCandidate | null {
    const seen = new Set<Element>();
    // Each hit-test chain climbs until the page root, the overlay or an
    // ancestor an earlier chain already covered.
    const visit = (element: Element): boolean => {
      if (
        element === document.body ||
        element === document.documentElement ||
        isPickerOverlayElement(element) ||
        seen.has(element)
      )
        return false;
      seen.add(element);
      return true;
    };
    for (const element of deepestElementsFromPoint(
      document,
      clientX,
      clientY,
    )) {
      // The toast covers what is under it.
      if (activeToast && element === activeToast.root) return null;
      if (mode === "link") {
        const link = linkCandidateFor(element, document.baseURI, visit);
        if (link) return { kind: "link", ...link };
        continue;
      }
      let current: Element | null = element;
      while (current && visit(current)) {
        const candidate = candidateForElement(current);
        if (candidate) return candidate;
        current = current.parentElement;
      }
    }
    return null;
  }

  function isPickerOverlayElement(element: Element): boolean {
    if (activeToast && element === activeToast.root) return true;
    if (!activePicker) return false;
    const { overlay, banner } = activePicker;
    return (
      element === overlay.root ||
      element === banner.root ||
      element.getRootNode() === overlay.shadowRoot
    );
  }

  function deepestElementsFromPoint(
    root: Document | ShadowRoot,
    x: number,
    y: number,
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
      if (element instanceof HTMLElement && element.shadowRoot) {
        for (const nested of deepestElementsFromPoint(
          element.shadowRoot,
          x,
          y,
        )) {
          if (!seen.has(nested)) {
            seen.add(nested);
            flattened.push(nested);
          }
        }
      }
      seen.add(element);
      flattened.push(element);
    }
    return flattened;
  }

  function candidateForElement(element: Element): ImageCandidate | null {
    if (element instanceof HTMLImageElement) {
      const url = imageUrl(element);
      return url
        ? {
            kind: "image",
            element,
            url,
            sourceKind: sourceKindForUrl(
              url,
              element.closest("picture") ? "picture" : "img",
            ),
          }
        : null;
    }
    if (element instanceof HTMLPictureElement) {
      const image = element.querySelector("img");
      const url = image ? imageUrl(image) : null;
      return url && image
        ? {
            kind: "image",
            element: image,
            url,
            sourceKind: sourceKindForUrl(url, "picture"),
          }
        : null;
    }
    if (element instanceof HTMLVideoElement && element.poster) {
      const url = resolveUrl(element.poster);
      return url
        ? {
            kind: "image",
            element,
            url,
            sourceKind: sourceKindForUrl(url, "video-poster"),
          }
        : null;
    }
    if (element instanceof HTMLElement) {
      const background = backgroundImageUrl(element);
      if (background) {
        return {
          kind: "image",
          element,
          url: background,
          sourceKind: sourceKindForUrl(background, "background-image"),
        };
      }
    }
    return null;
  }

  function imageUrl(image: HTMLImageElement): string | null {
    const raw =
      image.currentSrc ||
      image.getAttribute("src") ||
      image.getAttribute("data-src") ||
      image.getAttribute("data-lazy-src") ||
      image.getAttribute("data-original") ||
      image.getAttribute("data-url");
    return raw ? resolveUrl(raw) : null;
  }

  function backgroundImageUrl(element: HTMLElement): string | null {
    const value = getComputedStyle(element).backgroundImage;
    if (!value || value === "none") return null;
    const match = /url\(\s*(["']?)(.*?)\1\s*\)/u.exec(value);
    return match?.[2] ? resolveUrl(match[2]) : null;
  }

  function resolveUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith("data:") || trimmed.startsWith("blob:"))
      return trimmed;
    try {
      return new URL(trimmed, document.baseURI).toString();
    } catch {
      return null;
    }
  }

  function sourceKindForUrl(
    url: string,
    defaultKind: ImageSelection["sourceKind"],
  ): ImageSelection["sourceKind"] {
    if (url.startsWith("data:")) return "data-url";
    if (url.startsWith("blob:")) return "blob-url";
    return defaultKind;
  }

  function makeSelection(candidate: ImageCandidate): ImageSelection {
    const rect = candidate.element.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const pageOrigin =
      location.origin === "null"
        ? new URL(location.href).origin
        : location.origin;
    return {
      url: candidate.url,
      sourceKind: candidate.sourceKind,
      pageOrigin,
      sourceHostname: location.hostname || "unknown",
      pageTitle: sanitizeDisplayText(document.title, 256) || null,
      rect: {
        x: rect.x,
        y: rect.y,
        width,
        height,
        viewportWidth: Math.max(1, window.innerWidth),
        viewportHeight: Math.max(1, window.innerHeight),
        devicePixelRatio: Math.min(
          10,
          Math.max(1, window.devicePixelRatio || 1),
        ),
      },
    };
  }

  async function addInlineBytes(
    selection: ImageSelection,
  ): Promise<ImageSelection> {
    if (
      !selection.url.startsWith("data:") &&
      !selection.url.startsWith("blob:")
    )
      return selection;
    try {
      const response = await fetch(selection.url, { credentials: "omit" });
      if (!response.ok) return selection;
      const contentType = response.headers.get("content-type") ?? "";
      const bytes = await readBoundedResponseBytes(
        response,
        MAX_INLINE_IMAGE_BYTES,
      );
      validateInlineImageSize(bytes);
      const mime = validateImageBytes(bytes, contentType);
      return { ...selection, inlineBase64: toBase64(bytes), inlineMime: mime };
    } catch {
      return selection;
    }
  }

  function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(
        ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
      );
    }
    return btoa(binary);
  }
}
