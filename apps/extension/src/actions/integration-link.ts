import {
  LINK_ACTION_ID,
  LinkDownloadOptionsSchema,
  sanitizeDisplayText,
  type LinkDownloadOptions,
} from "@provenance-lens/shared";

import {
  createLinkDownload,
  getIntegrationSession,
  IntegrationClientError,
} from "../integration-client.js";
import { setWorkflowState } from "../storage.js";

export const PAGE_LINK_SENDING_MESSAGE = "Sending this page's link to DigiBot…";
export const PAGE_LINK_QUEUED_MESSAGE =
  "Queued in DigiBot; the result arrives in your Telegram chat.";
const PAGE_LINK_URL_MESSAGE =
  "Only an HTTP or HTTPS page address can be sent to Telegram.";
export const PAGE_LINK_OPTIONS_MESSAGE =
  "Choose a clip that starts before it ends and stays within 24 hours.";
const PAGE_LINK_FAILED_MESSAGE = "The page link could not be sent to DigiBot.";

/** The active page as the background sees it; only its address is used. */
export type PageLinkSource = { url?: string | undefined };

export class PageLinkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PageLinkError";
  }
}

/**
 * Sends only the current page's HTTP(S) address, with the MP3 output or clip
 * range when asked, over the connected session. DigiBot fetches the media
 * itself and posts the result in that account's own Telegram chat, so nothing
 * is stored locally and there is nothing to poll.
 */
export async function sendPageLink(
  page: PageLinkSource,
  options: LinkDownloadOptions = {},
): Promise<void> {
  try {
    const session = await getIntegrationSession();
    if (!session)
      throw new PageLinkError(
        "Connect Provenance Lens to DigiBot before sending a page link.",
      );
    const sourceUrl = pageLinkUrl(page.url);
    // DigiBot would refuse a one-sided or inverted clip anyway; say so first.
    const parsedOptions = LinkDownloadOptionsSchema.safeParse(options);
    if (!parsedOptions.success)
      throw new PageLinkError(PAGE_LINK_OPTIONS_MESSAGE);
    await setPageLinkWorkflow("sending", PAGE_LINK_SENDING_MESSAGE);
    await createLinkDownload(
      crypto.randomUUID(),
      sourceUrl,
      { accountId: session.accountId, sessionId: session.sessionId },
      parsedOptions.data,
    );
    await setPageLinkWorkflow("idle", PAGE_LINK_QUEUED_MESSAGE);
  } catch (error: unknown) {
    await setPageLinkWorkflow("error", pageLinkErrorMessage(error)).catch(
      () => undefined,
    );
    throw error;
  }
}

function pageLinkUrl(candidate: string | undefined): string {
  let parsed: URL;
  try {
    parsed = new URL(candidate ?? "");
  } catch {
    throw new PageLinkError(PAGE_LINK_URL_MESSAGE);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== ""
  )
    throw new PageLinkError(PAGE_LINK_URL_MESSAGE);
  // The fragment never reaches a server and can carry tokens or share keys.
  parsed.hash = "";
  return parsed.toString();
}

/** The message a failed send shows; DigiBot's own refusal stays verbatim. */
export function pageLinkErrorMessage(error: unknown): string {
  // DigiBot's own refusal (a limit, an unsupported source) is shown verbatim.
  if (error instanceof PageLinkError || error instanceof IntegrationClientError)
    return error.message;
  return PAGE_LINK_FAILED_MESSAGE;
}

async function setPageLinkWorkflow(
  status: "sending" | "idle" | "error",
  message: string,
): Promise<void> {
  await setWorkflowState({
    status,
    actionId: status === "idle" ? null : LINK_ACTION_ID,
    message: sanitizeDisplayText(message, 512),
    updatedAt: new Date().toISOString(),
  });
}
