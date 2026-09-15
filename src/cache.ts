interface Entry<V> {
  value: V;
  expiresAt: number;
}

/**
 * Small in-process TTL cache with a size cap.
 *
 * Downloads are the scarce resource here: the OpenSubtitles free tier allows a
 * handful per day, and one anchor gets reused by every language for the same
 * video. Caching is what makes that affordable.
 */
export class TtlCache<V> {
  private readonly store = new Map<string, Entry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Refresh insertion order so the entry counts as recently used.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs = this.ttlMs): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next();
      if (!oldest.done) this.store.delete(oldest.value);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Runs `factory` only on a miss, and shares one in-flight call per key.
   * The lifetime can depend on the value, so a failure can be kept for less
   * time than a success.
   */
  async wrap(
    key: string,
    factory: () => Promise<V>,
    ttlMs: number | ((value: V) => number) = this.ttlMs,
  ): Promise<V> {
    const hit = this.get(key);
    if (hit !== undefined) return hit;

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<V>;

    const task = factory()
      .then((value) => {
        this.set(key, value, typeof ttlMs === "function" ? ttlMs(value) : ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, task);
    return task;
  }

  private readonly inFlight = new Map<string, Promise<V>>();
}
