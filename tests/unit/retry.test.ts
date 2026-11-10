import { describe, expect, it, vi } from 'vitest';
import type { RetryConfig } from '../../src/config.js';
import {
  HttpStatusError,
  NetworkError,
  RetryAfterTooLongError,
  TimeoutError,
} from '../../src/resilience/errors.js';
import { backoffDelayMs, parseRetryAfter, withRetry } from '../../src/resilience/retry.js';

const policy: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 100,
  maxDelayMs: 1000,
  retryAfterMaxMs: 5000,
};

/** Runs withRetry with a recorded fake sleep and pinned jitter. */
function run<T>(fn: (attempt: number) => Promise<T>, p: RetryConfig = policy, random = () => 0.5) {
  const sleeps: number[] = [];
  const promise = withRetry(fn, p, {
    random,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { promise, sleeps };
}

describe('backoffDelayMs (full jitter)', () => {
  it('grows the ceiling exponentially and caps it at maxDelayMs', () => {
    const top = () => 0.999_999;
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffDelayMs(n, policy, top))).toEqual([
      99, 199, 399, 799, 999, 999,
    ]);
  });

  it('can pick zero, which is what spreads synchronized clients apart', () => {
    expect(backoffDelayMs(3, policy, () => 0)).toBe(0);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');

  it.each([
    ['delay-seconds', '3', 3000],
    ['zero', '0', 0],
    ['HTTP-date in the future', 'Thu, 01 Jan 2026 00:00:07 GMT', 7000],
    ['HTTP-date in the past clamps to 0', 'Wed, 31 Dec 2025 23:59:00 GMT', 0],
  ])('parses %s', (_name, header, expected) => {
    expect(parseRetryAfter(header, now)).toBe(expected);
  });

  it.each([[null], [undefined], [''], ['soon'], ['-1'], ['1.5']])(
    'ignores an unusable header %j',
    (header) => {
      expect(parseRetryAfter(header, now)).toBeUndefined();
    },
  );
});

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const { promise, sleeps } = run(() => Promise.resolve('ok'));
    await expect(promise).resolves.toBe('ok');
    expect(sleeps).toEqual([]);
  });

  it('retries 5xx, timeouts and network errors, then succeeds', async () => {
    const failures = [
      new HttpStatusError('dep', 503, undefined, null),
      new TimeoutError('dep', 50),
      new NetworkError('dep', 'ECONNRESET'),
    ];
    const fn = vi.fn((attempt: number) => {
      const failure = failures[attempt];
      return failure ? Promise.reject(failure) : Promise.resolve('ok');
    });
    const { promise, sleeps } = run(fn);
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toEqual([50, 100, 200]);
  });

  it('gives up after maxRetries and rethrows the last error', async () => {
    const fn = vi.fn(() => Promise.reject(new HttpStatusError('dep', 500, undefined, null)));
    const { promise } = run(fn, { ...policy, maxRetries: 2 });
    await expect(promise).rejects.toMatchObject({ status: 500 });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each([400, 402, 404, 409, 422])('does not retry a %i', async (status) => {
    const fn = vi.fn(() => Promise.reject(new HttpStatusError('dep', status, undefined, null)));
    const { promise } = run(fn);
    await expect(promise).rejects.toMatchObject({ status });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry errors outside the dependency taxonomy', async () => {
    const fn = vi.fn(() => Promise.reject(new TypeError('bug')));
    await expect(run(fn).promise).rejects.toThrow(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits at least Retry-After on a 429', async () => {
    const fn = vi.fn((attempt: number) =>
      attempt === 0
        ? Promise.reject(new HttpStatusError('dep', 429, 2000, null))
        : Promise.resolve('ok'),
    );
    const { promise, sleeps } = run(fn);
    await expect(promise).resolves.toBe('ok');
    expect(sleeps).toEqual([2000]);
  });

  it('keeps the backoff when it is longer than Retry-After', async () => {
    const fn = vi.fn((attempt: number) =>
      attempt < 3
        ? Promise.reject(new HttpStatusError('dep', 503, 10, null))
        : Promise.resolve('ok'),
    );
    const { promise, sleeps } = run(fn, policy, () => 0.999_999);
    await expect(promise).resolves.toBe('ok');
    expect(sleeps).toEqual([99, 199, 399]);
  });

  it('fails fast when Retry-After exceeds retryAfterMaxMs', async () => {
    const fn = vi.fn(() => Promise.reject(new HttpStatusError('dep', 429, 60_000, null)));
    const { promise, sleeps } = run(fn);
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryAfterTooLongError);
    expect(error).toMatchObject({ retryAfterMs: 60_000 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});
