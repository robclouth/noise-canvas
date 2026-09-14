/** Keeps a view live until its transform has stopped changing. */
export class ViewMotion {
  active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  touch(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (!this.active) {
      this.active = true;
      this.notify();
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.active = false;
      this.notify();
    }, 180);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.active = false;
    this.listeners.clear();
  }
}
