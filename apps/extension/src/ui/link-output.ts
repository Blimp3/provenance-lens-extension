import type { LinkDownloadOptions } from "@provenance-lens/shared";

/** The popup's send control: the page's video, an MP3 of it, or one clip of it. */
export type LinkOutput = "video" | "mp3" | "clip";
export const LINK_OUTPUTS: readonly LinkOutput[] = ["video", "mp3", "clip"];
/** The dropdown's option text, in LINK_OUTPUTS order. */
export const LINK_OUTPUT_LABELS: Readonly<Record<LinkOutput, string>> = {
  video: "Video",
  mp3: "MP3",
  clip: "Clip",
};

/** DigiBot's trim ceiling, the 24 hours LinkDownloadOptionsSchema also allows. */
const MAX_CLIP_SECONDS = 24 * 60 * 60;

export const CLIP_FORMAT_MESSAGE =
  "Enter the start and end as ss, m:ss or h:mm:ss.";
export const CLIP_LIMIT_MESSAGE = "Keep the clip within 24 hours.";
export const CLIP_ORDER_MESSAGE = "The clip must start before it ends.";

export type ClipField = "start" | "end";
export type LinkOptionsResult =
  | { ok: true; options: LinkDownloadOptions | null }
  | { ok: false; message: string; fields: readonly ClipField[] };

export function isLinkOutput(value: string): value is LinkOutput {
  return (LINK_OUTPUTS as readonly string[]).includes(value);
}

/**
 * Whole seconds from "ss", "m:ss" or "h:mm:ss", read the way DigiBot reads a
 * Telegram timestamp (two-digit seconds and minutes under 60 after a colon);
 * null for anything else, an empty field included. Digits are not capped, so
 * "024:00:00" and "100:00:00" both parse; the caller checks the 24-hour limit
 * and gives an over-long clip its own message.
 */
export function parseClock(text: string): number | null {
  const value = text.trim();
  if (/^\d+$/u.test(value)) return Number(value);
  const minutesClock = /^(\d+):(\d{2})$/u.exec(value);
  if (minutesClock) {
    const seconds = Number(minutesClock[2]);
    return seconds < 60 ? Number(minutesClock[1]) * 60 + seconds : null;
  }
  const hoursClock = /^(\d+):(\d{2}):(\d{2})$/u.exec(value);
  if (!hoursClock) return null;
  const minutes = Number(hoursClock[2]);
  const seconds = Number(hoursClock[3]);
  if (minutes >= 60 || seconds >= 60) return null;
  return Number(hoursClock[1]) * 3600 + minutes * 60 + seconds;
}

/**
 * The options the chosen output sends with the page link: none for the video,
 * the MP3 flag, or a clip whose bounds are whole seconds with
 * 0 <= start < end <= 86400. An invalid clip names the fields to correct.
 */
export function linkOptionsFor(
  output: LinkOutput,
  start: string,
  end: string,
): LinkOptionsResult {
  if (output === "video") return { ok: true, options: null };
  if (output === "mp3") return { ok: true, options: { output: "mp3" } };
  const startSeconds = parseClock(start);
  const endSeconds = parseClock(end);
  if (startSeconds === null || endSeconds === null) {
    return {
      ok: false,
      message: CLIP_FORMAT_MESSAGE,
      fields: clipFields(startSeconds === null, endSeconds === null),
    };
  }
  if (startSeconds > MAX_CLIP_SECONDS || endSeconds > MAX_CLIP_SECONDS) {
    return {
      ok: false,
      message: CLIP_LIMIT_MESSAGE,
      fields: clipFields(
        startSeconds > MAX_CLIP_SECONDS,
        endSeconds > MAX_CLIP_SECONDS,
      ),
    };
  }
  if (endSeconds <= startSeconds)
    return { ok: false, message: CLIP_ORDER_MESSAGE, fields: ["end"] };
  return { ok: true, options: { startSeconds, endSeconds } };
}

function clipFields(start: boolean, end: boolean): ClipField[] {
  return [
    ...(start ? ["start" as const] : []),
    ...(end ? ["end" as const] : []),
  ];
}
