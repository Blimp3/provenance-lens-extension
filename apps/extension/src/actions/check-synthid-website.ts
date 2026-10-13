import {
  SYNTHID_DETECTOR_URL,
  type ImageSelection,
} from "@provenance-lens/shared";

import type { ImageRetrievalContext } from "./verify-openai-provenance.js";
import {
  verifySelectionOnWebsite,
  type WebsiteBrowser,
  type WebsiteHandoffTarget,
  type WebsiteVerificationOutcome,
} from "./verify-openai-website.js";

/**
 * Google has no public SynthID detection API, and the SynthID Detector is a
 * signed-in portal whose terms forbid automated use. So Lens hands the file
 * over: the Website-mode handoff with Google's site as the target. Lens never
 * injects into, fills, reads or automates synthid.com, uploads nothing to
 * Google, and keeps no history record or cache entry, because it never sees
 * Google's result.
 */
export const SYNTHID_HANDOFF_TARGET: WebsiteHandoffTarget = Object.freeze({
  url: SYNTHID_DETECTOR_URL,
  handoffMessage:
    "The exact image was saved. Upload it on Google's SynthID Detector in the new tab.",
  toastMessage: "Upload it on Google's SynthID Detector in the new tab.",
  retrievalErrorMessage:
    "The selected image could not be retrieved for Google SynthID.",
  downloadPermissionMessage:
    "Grant optional download access in Settings before checking with Google SynthID.",
  openErrorMessage:
    "The exact image was saved, but Google's SynthID Detector could not be opened. Open synthid.com to upload the file.",
  cancelledMessage: "The Google SynthID handoff was cancelled.",
});

/** Saves the exact selected bytes and opens Google's SynthID Detector. */
export function checkSelectionOnSynthId(
  selection: ImageSelection,
  context: ImageRetrievalContext = {},
  browser?: WebsiteBrowser,
): Promise<WebsiteVerificationOutcome> {
  return verifySelectionOnWebsite(
    selection,
    context,
    browser,
    SYNTHID_HANDOFF_TARGET,
  );
}
