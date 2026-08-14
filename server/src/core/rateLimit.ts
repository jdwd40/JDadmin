type Bucket = { count: number; resetAt: number };

/**
 * Fixed-window in-memory rate limiter. Suitable for a single-process admin
 * deployment; swap for a shared store if the server is ever multi-process.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly max: number;
  private readonly windowMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(opts: { max: number; windowMs: number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    if (opts.windowMs >= 10_000) {
      this.sweeper = setInterval(() => this.sweep(), Math.min(opts.windowMs, 60_000));
      this.sweeper.unref?.();
    }
  }

  /** Returns true when the action is allowed; false when limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.max) return false;
    bucket.count += 1;
    return true;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}
