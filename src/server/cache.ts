/** A small in-memory cache with per-entry expiry and a size cap (oldest entries go first). */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Stores `value` for `ttlMs`. A lifetime that isn't a positive finite number stores nothing (never "forever"). */
  set(key: K, value: V, ttlMs: number): void {
    if (!(ttlMs > 0) || !Number.isFinite(ttlMs)) {
      this.entries.delete(key);
      return;
    }
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
