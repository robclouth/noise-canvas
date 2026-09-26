/** LRU keyed by node id, bounded by the bytes its values hold. */
export class ByteBudgetCache<T> {
  private readonly map = new Map<string, T>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (value: T) => number,
  ) {}

  get byteCount(): number {
    return this.bytes;
  }

  get(id: string): T | undefined {
    const v = this.map.get(id);
    if (v === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, v);
    return v;
  }

  /** Stores the value unless it alone would overrun the budget. */
  set(id: string, value: T): void {
    const size = this.sizeOf(value);
    if (size > this.maxBytes) return;
    this.delete(id);
    this.map.set(id, value);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
  }

  /**
   * Stores the value only if it fits without evicting anything: a sweep over
   * more than the budget then keeps what it found cached, where evicting as it
   * went would leave none of it for the next sweep.
   */
  setIfRoom(id: string, value: T): void {
    const size = this.sizeOf(value);
    const existing = this.map.get(id);
    const freed = existing === undefined ? 0 : this.sizeOf(existing);
    if (this.bytes - freed + size > this.maxBytes) return;
    this.delete(id);
    this.map.set(id, value);
    this.bytes += size;
  }

  delete(id: string): void {
    const existing = this.map.get(id);
    if (existing === undefined) return;
    this.bytes -= this.sizeOf(existing);
    this.map.delete(id);
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }
}
