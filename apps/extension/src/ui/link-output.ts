/**
 * What a page link sends: the page's video, its audio as a voice note or an
 * audio file, or one clip of it.
 */
export type LinkOutput = "video" | "voice" | "m4a" | "clip";
/** Each output's name in a progress toast. */
export const LINK_OUTPUT_LABELS: Readonly<Record<LinkOutput, string>> = {
  video: "Video",
  voice: "Voice note",
  m4a: "Audio file",
  clip: "Clip",
};

/** DigiBot's trim ceiling, the 24 hours LinkDownloadOptionsSchema also allows. */
const MAX_CLIP_SECONDS = 24 * 60 * 60;

export const CLIP_FORMAT_MESSAGE =
  "Enter the start and end as ss, m:ss or h:mm:ss.";
export const CLIP_LIMIT_MESSAGE = "Keep the clip within 24 hours.";
export const CLIP_ORDER_MESSAGE = "The clip must start before it ends.";

export type ClipRangeResult =
  | { ok: true; startSeconds: number; endSeconds: number }
  | { ok: false; message: string };

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
 * A range typed in one field, as the palette's Clip view takes it:
 * "1:30-2:10", "1:30 2:10", "90-130" or "1:02:03-1:05:00". Each bound reads
 * as parseClock reads it, and the clip's whole-second bounds keep
 * 0 <= start < end <= 86400.
 */
export function parseClockRange(text: string): ClipRangeResult {
  const bounds = text.trim().split(/\s*-\s*|\s+/u);
  if (bounds.length !== 2) return { ok: false, message: CLIP_FORMAT_MESSAGE };
  const startSeconds = parseClock(bounds[0] ?? "");
  const endSeconds = parseClock(bounds[1] ?? "");
  if (startSeconds === null || endSeconds === null)
    return { ok: false, message: CLIP_FORMAT_MESSAGE };
  if (startSeconds > MAX_CLIP_SECONDS || endSeconds > MAX_CLIP_SECONDS)
    return { ok: false, message: CLIP_LIMIT_MESSAGE };
  if (endSeconds <= startSeconds)
    return { ok: false, message: CLIP_ORDER_MESSAGE };
  return { ok: true, startSeconds, endSeconds };
}
