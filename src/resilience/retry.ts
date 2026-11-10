import type { RetryConfig } from '../config.js';
import { DependencyError, HttpStatusError, RetryAfterTooLongError } from './errors.js';

export interface RetryDeps {
  /** Returns a number in [0, 1). Injected so tests can pin the jitter. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: DependencyError }) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter: a random delay in [0, min(maxDelay, base * 2^attempt)).
 * Full jitter spreads synchronized clients apart better than "equal" or no jitter.
 */
export function backoffDelayMs(
  retryNumber: number,
  policy: Pick<RetryConfig, 'baseDelayMs' | 'maxDelayMs'>,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryNumber);
  return Math.floor(random() * ceiling);
}

/**
 * Parses an HTTP Retry-After header (RFC 9110 section 10.2.3): either delay-seconds or an HTTP-date.
 * Returns undefined for a missing or unparseable header.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (header == null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Date.parse is lenient ("-1" and "1.5" parse as years), so require an HTTP-date shape.
  if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/**
 * Runs `fn` and retries retryable DependencyErrors up to `policy.maxRetries` times.
 * A Retry-After hint is a floor for the wait; a hint above `retryAfterMaxMs` stops retrying,
 * because blocking the caller for longer than that is worse than failing fast.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryConfig,
  deps: RetryDeps = {},
): Promise<T> {
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!(error instanceof DependencyError) || !error.retryable) throw error;
      if (attempt >= policy.maxRetries) throw error;

      let delayMs = backoffDelayMs(attempt, policy, random);
      if (error instanceof HttpStatusError && error.retryAfterMs !== undefined) {
        if (error.retryAfterMs > policy.retryAfterMaxMs) {
          throw new RetryAfterTooLongError(error.dependency, error.retryAfterMs, { cause: error });
        }
        delayMs = Math.max(delayMs, error.retryAfterMs);
      }
      deps.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }
}
