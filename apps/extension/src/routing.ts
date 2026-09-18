import type { ImageSelection } from "@provenance-lens/shared";

export type ActionTrigger = "popup" | "keyboard" | "context-menu";

export type ActionRoute =
  | { kind: "pick"; trigger: ActionTrigger }
  | {
      kind: "verify-selection";
      trigger: ActionTrigger;
      selection: ImageSelection;
    };

export function routeActionRequest(
  trigger: ActionTrigger,
  selection: ImageSelection | null = null,
): ActionRoute {
  return selection
    ? { kind: "verify-selection", trigger, selection }
    : { kind: "pick", trigger };
}

export function resolveCancellationTabId(
  senderTabId: number | undefined,
  activeTabIds: readonly number[],
  focusedTabId: number | undefined,
): number | undefined {
  if (senderTabId !== undefined && activeTabIds.includes(senderTabId)) {
    return senderTabId;
  }
  if (focusedTabId !== undefined && activeTabIds.includes(focusedTabId)) {
    return focusedTabId;
  }
  return activeTabIds.length === 1 ? activeTabIds[0] : undefined;
}
