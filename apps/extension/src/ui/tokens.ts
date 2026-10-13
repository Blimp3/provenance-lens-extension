/**
 * The Lens color tokens, light and dark. The picker, its banner and the
 * result toast style a closed shadow root through the CSSOM only, so they set
 * these as custom properties on their own container and pick the set with
 * matchMedia.
 */
export const LENS_TOKENS = {
  light: {
    "--lens-page": "#F4F5F7",
    "--lens-surface": "#FFFFFF",
    "--lens-surface-2": "#F6F7F9",
    "--lens-line": "#E4E7EC",
    "--lens-line-strong": "#D0D5DD",
    "--lens-text": "#101828",
    "--lens-muted": "#4D5566",
    "--lens-hover": "#F2F4F7",
    "--lens-selected": "#E3F1F6",
    "--lens-accent": "#0B6E8A",
    "--lens-accent-ink": "#FFFFFF",
    "--lens-accent-soft": "#E6F4F8",
    "--lens-ok": "#157A42",
    "--lens-ok-soft": "#E7F5EC",
    "--lens-neutral": "#475467",
    "--lens-neutral-soft": "#EEF1F5",
    "--lens-warn": "#8A5300",
    "--lens-warn-soft": "#FCF1DA",
    "--lens-danger": "#B42318",
    "--lens-danger-soft": "#FDECEA",
    "--lens-kbd-bg": "#FFFFFF",
    "--lens-kbd-text": "#344054",
    "--lens-scrim": "#1018285C",
    "--lens-shadow": "0 24px 64px #10182847, 0 2px 8px #1018281F",
  },
  dark: {
    "--lens-page": "#0F1115",
    "--lens-surface": "#1B1E25",
    "--lens-surface-2": "#16181E",
    "--lens-line": "#2C313B",
    "--lens-line-strong": "#3B4250",
    "--lens-text": "#F2F4F7",
    "--lens-muted": "#A6AEBD",
    "--lens-hover": "#232731",
    "--lens-selected": "#173F4B",
    "--lens-accent": "#22D3EE",
    "--lens-accent-ink": "#04222B",
    "--lens-accent-soft": "#12313A",
    "--lens-ok": "#4ADE80",
    "--lens-ok-soft": "#123222",
    "--lens-neutral": "#A3ADBD",
    "--lens-neutral-soft": "#262B35",
    "--lens-warn": "#FBBF24",
    "--lens-warn-soft": "#3A2A08",
    "--lens-danger": "#FB8F8F",
    "--lens-danger-soft": "#3F1A1A",
    "--lens-kbd-bg": "#2A2F3A",
    "--lens-kbd-text": "#D0D5DD",
    "--lens-scrim": "#0000008F",
    "--lens-shadow": "0 24px 64px #00000099, 0 2px 8px #00000066",
  },
} as const;

export type LensTokenName = keyof (typeof LENS_TOKENS)["light"];
export type LensTokenSet = Readonly<Record<LensTokenName, string>>;

/**
 * Forced colors: the browser repaints with system colors anyway; these keep
 * the 1px CanvasText border and a Highlight accent explicit.
 */
const FORCED_COLOR_TOKENS: Partial<Record<LensTokenName, string>> = {
  "--lens-surface": "Canvas",
  "--lens-surface-2": "Canvas",
  "--lens-line": "CanvasText",
  "--lens-line-strong": "CanvasText",
  "--lens-text": "CanvasText",
  "--lens-muted": "CanvasText",
  "--lens-accent": "Highlight",
  "--lens-shadow": "none",
};

export function lensTokenSet(
  dark: boolean,
  forcedColors: boolean,
): LensTokenSet {
  const base = dark ? LENS_TOKENS.dark : LENS_TOKENS.light;
  return forcedColors ? { ...base, ...FORCED_COLOR_TOKENS } : base;
}

export const LENS_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif';
export const LENS_MONO_FONT =
  'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
