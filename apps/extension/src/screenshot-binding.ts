export type SelectionRectFingerprint = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectionFingerprint = {
  sourceUrlSha256: string;
  tagName: string;
  rect: SelectionRectFingerprint;
};

export type PageSnapshot = {
  documentMarker: string;
  pageUrlSha256: string;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
  selection: SelectionFingerprint | null;
};

export function samePageBinding(
  left: PageSnapshot,
  right: PageSnapshot,
): boolean {
  return (
    left.documentMarker === right.documentMarker &&
    left.pageUrlSha256 === right.pageUrlSha256 &&
    left.viewportWidth === right.viewportWidth &&
    left.viewportHeight === right.viewportHeight &&
    left.devicePixelRatio === right.devicePixelRatio &&
    left.scrollX === right.scrollX &&
    left.scrollY === right.scrollY &&
    sameSelectionFingerprint(left.selection, right.selection)
  );
}

function sameSelectionFingerprint(
  left: SelectionFingerprint | null,
  right: SelectionFingerprint | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.sourceUrlSha256 === right.sourceUrlSha256 &&
    left.tagName === right.tagName &&
    left.rect.x === right.rect.x &&
    left.rect.y === right.rect.y &&
    left.rect.width === right.rect.width &&
    left.rect.height === right.rect.height
  );
}
