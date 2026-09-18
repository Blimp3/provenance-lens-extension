import { beforeEach, describe, expect, it, vi } from "vitest";

describe("full optional extension access", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("requests downloads and both HTTP(S) host patterns in one user action", async () => {
    const contains = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const request = vi.fn().mockResolvedValue(true);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains, request } },
    });
    const { requestFullOptionalAccess } =
      await import("../../src/ui/optional-access.js");

    const result = requestFullOptionalAccess();
    expect(request).toHaveBeenCalledTimes(1);
    await expect(result).resolves.toMatchObject({
      outcome: "granted",
      state: { allSites: true, downloads: true, complete: true },
    });
    expect(request).toHaveBeenCalledWith({
      permissions: ["downloads"],
      origins: ["http://*/*", "https://*/*"],
    });
  });

  it("uses the authoritative post-request state instead of the request result", async () => {
    const contains = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const request = vi.fn().mockResolvedValue(false);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains, request } },
    });
    const { requestFullOptionalAccess } =
      await import("../../src/ui/optional-access.js");

    await expect(requestFullOptionalAccess()).resolves.toEqual({
      outcome: "granted",
      state: { allSites: true, downloads: true, complete: true },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports a partial state after denial without revoking existing access", async () => {
    const contains = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const request = vi.fn().mockResolvedValue(false);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: { contains, request } },
    });
    const { requestFullOptionalAccess } =
      await import("../../src/ui/optional-access.js");

    await expect(requestFullOptionalAccess()).resolves.toEqual({
      outcome: "denied",
      state: { allSites: false, downloads: true, complete: false },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("describes exact-file download and image-host access independently", async () => {
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { permissions: {} },
    });
    const { optionalAccessStatusText } =
      await import("../../src/ui/optional-access.js");

    expect(
      optionalAccessStatusText({
        allSites: true,
        downloads: false,
        complete: false,
      }),
    ).toContain("exact-file download access");
    expect(
      optionalAccessStatusText({
        allSites: false,
        downloads: true,
        complete: false,
      }),
    ).toContain("image-host access");
  });
});
