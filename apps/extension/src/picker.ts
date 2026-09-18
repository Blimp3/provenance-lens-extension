import {
  MAX_INLINE_IMAGE_BYTES,
  PICKER_RUNTIME_VERSION,
  PickerRuntimeMessageSchema,
  sanitizeDisplayText,
  validateInlineImageSize,
  validateImageBytes,
  type ImageSelection,
  type PickerRuntimeMessage,
} from "@provenance-lens/shared";

import { readBoundedResponseBytes } from "./bounded-response.js";

type PickCandidate = {
  element: Element;
  url: string;
  sourceKind: ImageSelection["sourceKind"];
};

type PickerOverlay = {
  root: HTMLElement;
  shadowRoot: ShadowRoot;
  dimmers: HTMLDivElement[];
  focus: HTMLDivElement;
  label: HTMLDivElement;
};

type PickerState = {
  sessionToken: string;
  overlay: PickerOverlay;
  previousCursor: string;
  candidate: PickCandidate | null;
  cleanup: () => void;
};

type ShowToastMessage = Extract<PickerRuntimeMessage, { type: "show-toast" }>;

declare global {
  interface Window {
    __provenanceLensPickerInstalled?: boolean | string;
  }
}

if (window.__provenanceLensPickerInstalled !== PICKER_RUNTIME_VERSION) {
  window.__provenanceLensPickerInstalled = PICKER_RUNTIME_VERSION;
  let activePicker: PickerState | null = null;
  let activeToastCleanup: (() => void) | null = null;
  let boundSessionToken: string | null = null;

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
        return;
      case "picker-start":
        if (boundSessionToken !== parsed.data.sessionToken) return;
        startPicker(parsed.data.sessionToken);
        return;
      case "picker-stop":
        if (activePicker?.sessionToken === parsed.data.sessionToken) {
          activePicker.cleanup();
          activePicker = null;
        }
        return;
      case "show-toast":
        if (boundSessionToken === parsed.data.sessionToken) {
          showToast(parsed.data);
        }
        return;
    }
  });

  function startPicker(sessionToken: string): void {
    activePicker?.cleanup();
    const overlay = createPickerOverlay();

    const previousCursor = document.documentElement.style.cursor;
    document.documentElement.style.cursor = "crosshair";
    const state: PickerState = {
      sessionToken,
      overlay,
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
      const candidate = candidateAt(latestPointer.x, latestPointer.y);
      state.candidate = candidate;
      if (candidate) {
        renderOverlay(overlay, candidate);
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
      overlay.root.remove();
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
      if (closed || !event.isTrusted) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }

    function onClick(event: MouseEvent): void {
      if (closed || !event.isTrusted) return;
      const candidate = candidateAt(event.clientX, event.clientY);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (!candidate) return;
      state.candidate = candidate;
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

  function createPickerOverlay(): PickerOverlay {
    const root = document.createElement("div");
    root.dataset["provenanceLensPicker"] = "overlay";
    root.setAttribute("aria-label", "Provenance Lens image picker");
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
      fontFamily: "system-ui, -apple-system, sans-serif",
    });
    shadowRoot.append(surface);

    const dimmers = (["top", "right", "bottom", "left"] as const).map(
      (side) => {
        const dimmer = document.createElement("div");
        dimmer.dataset["pickerDimmer"] = side;
        Object.assign(dimmer.style, {
          position: "fixed",
          display: "none",
          pointerEvents: "none",
          background: "rgba(3, 7, 18, .64)",
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
      border: "2px solid #22d3ee",
      borderRadius: "4px",
      boxShadow:
        "0 0 0 1px rgba(15, 23, 42, .9), 0 0 20px rgba(34, 211, 238, .45)",
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
      padding: "7px 10px",
      border: "1px solid rgba(103, 232, 249, .9)",
      borderRadius: "8px",
      background: "#0f172a",
      color: "#f8fafc",
      font: "600 12px/1.25 system-ui, -apple-system, sans-serif",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      boxShadow: "0 4px 18px rgba(2, 6, 23, .42)",
    });
    surface.append(label);

    (document.documentElement ?? document.body).append(root);
    return { root, shadowRoot, dimmers, focus, label };
  }

  function showToast(message: ShowToastMessage): void {
    activeToastCleanup?.();

    const root = document.createElement("div");
    root.dataset["provenanceLensToast"] = "true";
    setImportantStyles(root, {
      all: "initial",
      position: "fixed",
      top: "16px",
      right: "16px",
      "z-index": "2147483647",
      display: "block",
      width: "min(420px, calc(100vw - 32px))",
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
      direction: "ltr",
      isolation: "isolate",
      contain: "layout style paint",
      "pointer-events": "none",
    });

    const shadowRoot = root.attachShadow({ mode: "closed" });
    const region = document.createElement("section");
    region.dataset["toastRegion"] = "true";
    region.setAttribute("role", message.tone === "error" ? "alert" : "status");
    region.setAttribute(
      "aria-live",
      message.tone === "error" ? "assertive" : "polite",
    );
    region.setAttribute("aria-atomic", "true");
    Object.assign(region.style, {
      pointerEvents: "auto",
      boxSizing: "border-box",
      display: "grid",
      gap: "10px",
      width: "100%",
      padding: "14px",
      border:
        message.tone === "detected" ? "1px solid #4ade80" : "1px solid #fb7185",
      borderRadius: "12px",
      background: "#111111",
      color: "#fafafa",
      boxShadow: "0 12px 32px rgba(0, 0, 0, .45)",
      font: "14px/1.45 system-ui, -apple-system, sans-serif",
      textAlign: "left",
      whiteSpace: "normal",
      overflowWrap: "anywhere",
    });

    const summaryTitle = sanitizeDisplayText(message.title, 100);
    const summaryMessage = sanitizeDisplayText(message.message, 512);
    const summary = document.createElement(message.resultId ? "button" : "div");
    if (summary instanceof HTMLButtonElement) {
      summary.type = "button";
      summary.dataset["toastDetails"] = "true";
      summary.setAttribute(
        "aria-label",
        `${summaryTitle}. ${summaryMessage} Open full verification details.`,
      );
      Object.assign(summary.style, {
        appearance: "none",
        boxSizing: "border-box",
        display: "grid",
        gap: "6px",
        width: "100%",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        font: "inherit",
        textAlign: "left",
      });
      summary.addEventListener("click", () => {
        void chrome.runtime
          .sendMessage({
            type: "open-result-details",
            sessionToken: message.sessionToken,
            resultId: message.resultId,
          })
          .catch(() => undefined);
      });
    } else {
      Object.assign(summary.style, {
        display: "grid",
        gap: "6px",
      });
    }

    const title = document.createElement("span");
    title.textContent = summaryTitle;
    Object.assign(title.style, {
      display: "block",
      color: "#fafafa",
      font: "700 15px/1.3 system-ui, -apple-system, sans-serif",
    });
    const body = document.createElement("span");
    body.textContent = summaryMessage;
    Object.assign(body.style, {
      display: "block",
      color: "#d4d4d4",
      font: "14px/1.45 system-ui, -apple-system, sans-serif",
    });
    summary.append(title, body);
    region.append(summary);

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      flexWrap: "wrap",
      gap: "8px",
      justifyContent: "flex-end",
    });
    const dismiss = toastButton("Dismiss");
    dismiss.setAttribute("aria-label", "Dismiss Provenance Lens result");
    dismiss.addEventListener("click", () => activeToastCleanup?.(), {
      once: true,
    });
    actions.append(dismiss);
    region.append(actions);
    shadowRoot.append(region);

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      root.remove();
      if (activeToastCleanup === cleanup) activeToastCleanup = null;
    };
    activeToastCleanup = cleanup;
    (document.documentElement ?? document.body).append(root);
  }

  function toastButton(label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    Object.assign(button.style, {
      appearance: "none",
      boxSizing: "border-box",
      minHeight: "36px",
      padding: "7px 11px",
      border: "1px solid #737373",
      borderRadius: "8px",
      background: "#262626",
      color: "#fafafa",
      cursor: "pointer",
      font: "600 13px/1.2 system-ui, -apple-system, sans-serif",
    });
    return button;
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
    const labelText = `${pickerKindLabel(candidate.sourceKind)} · ${width} × ${height} px · Click to select · Esc to cancel`;
    overlay.label.textContent = labelText;
    overlay.root.setAttribute(
      "aria-label",
      `Provenance Lens image picker. ${labelText}`,
    );
    overlay.label.dataset["imageKind"] = candidate.sourceKind;
    overlay.label.dataset["imageWidth"] = String(width);
    overlay.label.dataset["imageHeight"] = String(height);
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

  function candidateAt(clientX: number, clientY: number): PickCandidate | null {
    const seen = new Set<Element>();
    for (const element of deepestElementsFromPoint(
      document,
      clientX,
      clientY,
    )) {
      let current: Element | null = element;
      while (current) {
        if (
          current === document.body ||
          current === document.documentElement ||
          isPickerOverlayElement(current)
        )
          break;
        if (seen.has(current)) break;
        seen.add(current);
        const candidate = candidateForElement(current);
        if (candidate) return candidate;
        current = current.parentElement;
      }
    }
    return null;
  }

  function isPickerOverlayElement(element: Element): boolean {
    const overlay = activePicker?.overlay;
    if (!overlay) return false;
    return (
      element === overlay.root || element.getRootNode() === overlay.shadowRoot
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

  function candidateForElement(element: Element): PickCandidate | null {
    if (element instanceof HTMLImageElement) {
      const url = imageUrl(element);
      return url
        ? {
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
        ? { element: image, url, sourceKind: sourceKindForUrl(url, "picture") }
        : null;
    }
    if (element instanceof HTMLVideoElement && element.poster) {
      const url = resolveUrl(element.poster);
      return url
        ? { element, url, sourceKind: sourceKindForUrl(url, "video-poster") }
        : null;
    }
    if (element instanceof HTMLElement) {
      const background = backgroundImageUrl(element);
      if (background) {
        return {
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

  function makeSelection(candidate: PickCandidate): ImageSelection {
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
