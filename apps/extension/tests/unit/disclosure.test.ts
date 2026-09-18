import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../../src/storage.js", () => ({
  getSettings: mocks.getSettings,
}));

describe("disclosure acknowledgement", () => {
  const validPendingId = "123e4567-e89b-42d3-a456-426614174000";

  beforeEach(() => {
    vi.resetModules();
    history.replaceState(null, "", "/disclosure.html");
    document.body.innerHTML = `
      <div id="disclosure-status"></div>
      <div id="website-disclosure"></div>
      <div id="api-disclosure"></div>
      <button id="acknowledge" type="button"></button>
      <button id="cancel" type="button"></button>
    `;
    mocks.getSettings.mockReset().mockResolvedValue({
      verificationMode: "website",
    });
    mocks.sendMessage.mockReset().mockResolvedValue(undefined);
    vi.spyOn(window, "close").mockImplementation(() => undefined);
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: {
        runtime: { sendMessage: mocks.sendMessage },
      },
    });
  });

  it("rejects a malformed pending ID before enabling acknowledgement", async () => {
    history.replaceState(null, "", "/disclosure.html?pending=not-a-uuid");
    await import("../../src/ui/disclosure.js");

    await vi.waitFor(() =>
      expect(document.getElementById("disclosure-status")?.textContent).toBe(
        "This disclosure link is invalid.",
      ),
    );
    const acknowledge = document.getElementById("acknowledge");
    expect(acknowledge).toBeInstanceOf(HTMLButtonElement);
    expect((acknowledge as HTMLButtonElement).disabled).toBe(true);

    acknowledge?.dispatchEvent(new MouseEvent("click"));
    await Promise.resolve();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(
      document.getElementById("disclosure-status")?.textContent,
    ).not.toContain("Disclosure acknowledged");
  });

  it("sends a valid pending ID with the rendered verification mode", async () => {
    history.replaceState(
      null,
      "",
      `/disclosure.html?pending=${validPendingId}`,
    );
    await import("../../src/ui/disclosure.js");

    const acknowledge = document.getElementById("acknowledge");
    await vi.waitFor(() =>
      expect((acknowledge as HTMLButtonElement).disabled).toBe(false),
    );
    acknowledge?.dispatchEvent(new MouseEvent("click"));

    await vi.waitFor(() =>
      expect(mocks.sendMessage).toHaveBeenCalledWith({
        type: "resume-permission",
        pendingId: validPendingId,
        verificationMode: "website",
      }),
    );
    expect(document.getElementById("disclosure-status")?.textContent).toBe(
      "Disclosure acknowledged. The picker is starting.",
    );
  });
});
