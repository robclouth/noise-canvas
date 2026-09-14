/** Serialises captures and rejects pictures from an obsolete view revision. */
export class ViewSnapshot {
  private revision = 0;
  private disposed = false;
  private inFlight: Promise<boolean> | null = null;

  constructor(private requestLatest: () => void) {}

  invalidate(): void {
    this.revision++;
  }

  capture(draw: (canPublish: () => boolean) => Promise<boolean>): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    const revision = this.revision;
    const canPublish = () => !this.disposed && revision === this.revision;
    this.inFlight = draw(canPublish)
      .then((ok) => ok && canPublish())
      .finally(() => {
        this.inFlight = null;
        if (!this.disposed && revision !== this.revision) this.requestLatest();
      });
    return this.inFlight;
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
  }
}
