export type VerificationRun = {
  controller: AbortController;
  tabId: number;
  historyId: string | null;
};

export class VerificationRunRegistry {
  readonly #runs = new Map<number, VerificationRun>();

  public claim(tabId: number): VerificationRun | null {
    if (this.#runs.has(tabId)) return null;
    const run: VerificationRun = {
      controller: new AbortController(),
      tabId,
      historyId: null,
    };
    this.#runs.set(tabId, run);
    return run;
  }

  public get(tabId: number): VerificationRun | undefined {
    return this.#runs.get(tabId);
  }

  public tabIds(): number[] {
    return [...this.#runs.keys()];
  }

  public abort(tabId: number, reason: unknown): boolean {
    const run = this.#runs.get(tabId);
    if (!run) return false;
    run.controller.abort(reason);
    return true;
  }

  public release(tabId: number, controller: AbortController): boolean {
    const run = this.#runs.get(tabId);
    if (!run || run.controller !== controller) return false;
    this.#runs.delete(tabId);
    return true;
  }
}
