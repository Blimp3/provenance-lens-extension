import {
  ACTION_ID,
  AUDIO_ACTION_ID,
  DOWNLOAD_ACTION_ID,
  type ExtensionSettings,
  type ImageSelection,
} from "@provenance-lens/shared";

import {
  verifySelection,
  type ImageRetrievalContext,
  type VerificationOutcome,
} from "./verify-openai-provenance.js";
import {
  verifySelectionOnWebsite,
  type WebsiteVerificationOutcome,
} from "./verify-openai-website.js";
import { openAudioCheck } from "./verify-openai-audio.js";
import { runIntegratedImageAction } from "./integration-image.js";

export interface ActionContext {
  selection: ImageSelection;
  settings: ExtensionSettings;
  retrieval: ImageRetrievalContext & { screenshotFallbackAvailable?: boolean };
}

export type ActionExecutionResult =
  | { kind: "api"; outcome: VerificationOutcome }
  | WebsiteVerificationOutcome
  | {
      kind: "integration";
      outcome: Awaited<ReturnType<typeof runIntegratedImageAction>>;
    };

export type ActionHandler = (
  context: ActionContext,
) => Promise<ActionExecutionResult>;

interface ActionDescription {
  displayName: string;
  triggerLabel: string;
  description: string;
  iconRef: string;
  resultType:
    | "normalized-provenance"
    | "website-handoff"
    | "mode-dependent"
    | "integration-operation";
  settings?: readonly (keyof ExtensionSettings)[];
}
export type ActionDefinition = ActionDescription &
  (
    | { id: typeof ACTION_ID; inputType: "image-file"; handler: ActionHandler }
    | {
        id: typeof DOWNLOAD_ACTION_ID;
        inputType: "image-file";
        handler: ActionHandler;
      }
    | {
        id: typeof AUDIO_ACTION_ID;
        inputType: "audio-file";
        handler: () => Promise<void>;
      }
  );

export const ACTION_REGISTRY: readonly ActionDefinition[] = Object.freeze([
  {
    id: DOWNLOAD_ACTION_ID,
    displayName: "Download image to DigiBot",
    triggerLabel: "Pick an image to download",
    description:
      "Send the selected original image to the linked DigiBot account without running a provenance check.",
    iconRef: "icons/icon-48.png",
    inputType: "image-file",
    resultType: "integration-operation",
    settings: [],
    handler: async (context) => ({
      kind: "integration",
      outcome: await runIntegratedImageAction(
        "download",
        context.selection,
        context.retrieval,
      ),
    }),
  },
  {
    id: ACTION_ID,
    displayName: "Check image provenance",
    triggerLabel: "Pick an image on this page",
    description:
      "Check embedded Content Credentials and supported OpenAI signals in one selected image.",
    iconRef: "icons/icon-48.png",
    inputType: "image-file",
    resultType: "mode-dependent",
    settings: [
      "backendBaseUrl",
      "clientToken",
      "verificationMode",
      "screenshotFallbackEnabled",
      "localCacheLimit",
    ],
    handler: async (context) =>
      context.settings.verificationMode === "website"
        ? verifySelectionOnWebsite(context.selection, context.retrieval)
        : {
            kind: "api",
            outcome: await verifySelection(
              context.selection,
              context.settings,
              context.retrieval,
            ),
          },
  },
  {
    id: AUDIO_ACTION_ID,
    displayName: "Check audio or video segment",
    triggerLabel: "Check audio or video segment",
    description:
      "Check supported OpenAI SynthID signals in one short audio file or an explicit video segment.",
    iconRef: "icons/icon-48.png",
    inputType: "audio-file",
    resultType: "normalized-provenance",
    settings: ["backendBaseUrl", "clientToken", "localCacheLimit"],
    handler: openAudioCheck,
  },
]);

const actionsById = new Map(
  ACTION_REGISTRY.map((action) => [action.id, action]),
);

export function getActionDefinition(
  actionId: string,
): ActionDefinition | undefined {
  return actionsById.get(
    actionId as
      typeof ACTION_ID | typeof AUDIO_ACTION_ID | typeof DOWNLOAD_ACTION_ID,
  );
}
