export type OptionalAccessState = {
  allSites: boolean;
  downloads: boolean;
  complete: boolean;
};

export type OptionalAccessRequestResult = {
  outcome: "granted" | "denied";
  state: OptionalAccessState;
};

const ALL_SITE_ORIGINS = ["http://*/*", "https://*/*"] as const;

export function fullOptionalAccessRequest(): chrome.permissions.Permissions {
  return {
    permissions: ["downloads"],
    origins: [...ALL_SITE_ORIGINS],
  };
}

export async function getOptionalAccessState(): Promise<OptionalAccessState> {
  const [allSites, downloads] = await Promise.all([
    chrome.permissions.contains({ origins: [...ALL_SITE_ORIGINS] }),
    chrome.permissions.contains({ permissions: ["downloads"] }),
  ]);
  return { allSites, downloads, complete: allSites && downloads };
}

export async function requestFullOptionalAccess(): Promise<OptionalAccessRequestResult> {
  // Keep the browser request as the first asynchronous API call so it remains
  // directly associated with the button's user gesture. Always ask Chrome for
  // the current result instead of trusting UI state that may have gone stale.
  await chrome.permissions.request(fullOptionalAccessRequest());
  const state = await getOptionalAccessState();
  return {
    outcome: state.complete ? "granted" : "denied",
    state,
  };
}

export function optionalAccessStatusText(state: OptionalAccessState): string {
  if (state.complete) return "Full optional access is ready.";
  if (state.allSites)
    return "Image-host access is ready; exact-file download access is still optional.";
  if (state.downloads)
    return "Exact-file download access is ready; image-host access is still optional.";
  return "Optional image-host and exact-file download access has not been granted.";
}
