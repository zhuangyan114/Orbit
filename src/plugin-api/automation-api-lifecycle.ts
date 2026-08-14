export interface AutomationApiServerLifecycle {
  start(): Promise<unknown>;
  dispose(): void | Promise<void>;
}

/** Serializes enable/disable transitions so rapid settings changes cannot leak a server. */
export class AutomationApiLifecycle<T extends AutomationApiServerLifecycle = AutomationApiServerLifecycle> {
  private active: T | null = null;
  private transition: Promise<void> = Promise.resolve();

  constructor(
    private readonly create: () => T,
    private readonly beforeActivate?: (candidate: T) => void,
  ) {}

  setEnabled(enabled: boolean): Promise<void> {
    const operation = this.transition
      .catch(() => undefined)
      .then(() => this.apply(enabled));
    this.transition = operation;
    return operation;
  }

  isEnabled(): boolean {
    return this.active !== null;
  }

  getActive(): T | undefined {
    return this.active ?? undefined;
  }

  private async apply(enabled: boolean): Promise<void> {
    if (enabled) {
      if (this.active) return;
      const candidate = this.create();
      try {
        await candidate.start();
        this.beforeActivate?.(candidate);
        this.active = candidate;
      } catch (error) {
        await candidate.dispose();
        throw error;
      }
      return;
    }

    const current = this.active;
    if (current) {
      try {
        await current.dispose();
      } finally {
        if (this.active === current) this.active = null;
      }
    }
  }
}
