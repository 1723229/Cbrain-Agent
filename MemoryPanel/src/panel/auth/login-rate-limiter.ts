interface AttemptBucket {
  failures: number[];
  lockedUntil: number;
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 5 * 60_000,
    private readonly lockMs = 15 * 60_000,
  ) {}

  assertAllowed(key: string, now = Date.now()): void {
    const bucket = this.buckets.get(key);
    if (bucket && bucket.lockedUntil > now) throw new Error('rate_limited');
  }

  recordFailure(key: string, now = Date.now()): void {
    const previous = this.buckets.get(key) ?? { failures: [], lockedUntil: 0 };
    previous.failures = previous.failures.filter((time) => now - time <= this.windowMs);
    previous.failures.push(now);
    if (previous.failures.length >= this.maxFailures) previous.lockedUntil = now + this.lockMs;
    this.buckets.set(key, previous);
  }

  clear(key: string): void {
    this.buckets.delete(key);
  }
}
