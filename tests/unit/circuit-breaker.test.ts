import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CircuitBreaker } from '../../src/resilience/circuit-breaker.js';
import { CircuitOpenError, HttpStatusError, TimeoutError } from '../../src/resilience/errors.js';

const fail500 = () => Promise.reject(new HttpStatusError('dep', 500, undefined, null));
const fail429 = () => Promise.reject(new HttpStatusError('dep', 429, undefined, null));
const fail404 = () => Promise.reject(new HttpStatusError('dep', 404, undefined, null));
const ok = () => Promise.resolve('ok');

describe('CircuitBreaker', () => {
  let now: number;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    now = 0;
    breaker = new CircuitBreaker('dep', { failureThreshold: 3, resetTimeoutMs: 1000 }, () => now);
  });

  async function failTimes(n: number, fn: () => Promise<unknown> = fail500) {
    for (let i = 0; i < n; i++) await breaker.execute(fn).catch(() => undefined);
  }

  it('stays closed below the threshold', async () => {
    await failTimes(2);
    expect(breaker.currentState).toBe('closed');
  });

  it('opens after the threshold of consecutive failures and stops calling the dependency', async () => {
    await failTimes(3);
    expect(breaker.currentState).toBe('open');

    const dependency = vi.fn(ok);
    const error = await breaker.execute(dependency).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error).toMatchObject({ retryInMs: 1000 });
    expect(dependency).not.toHaveBeenCalled();
  });

  it('counts timeouts as failures', async () => {
    await failTimes(3, () => Promise.reject(new TimeoutError('dep', 10)));
    expect(breaker.currentState).toBe('open');
  });

  it('a success resets the failure streak', async () => {
    await failTimes(2);
    await breaker.execute(ok);
    await failTimes(2);
    expect(breaker.currentState).toBe('closed');
  });

  it.each([
    ['429', fail429],
    ['404', fail404],
  ])('does not count a %s as a health failure', async (_name, fn) => {
    await failTimes(10, fn);
    expect(breaker.currentState).toBe('closed');
  });

  it('does not count errors outside the dependency taxonomy', async () => {
    await failTimes(10, () => Promise.reject(new Error('bug in caller')));
    expect(breaker.currentState).toBe('closed');
  });

  it('goes half-open after resetTimeoutMs and closes on a successful trial', async () => {
    await failTimes(3);
    now = 999;
    expect(breaker.currentState).toBe('open');
    now = 1000;
    expect(breaker.currentState).toBe('half-open');

    await expect(breaker.execute(ok)).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });

  it('re-opens when the half-open trial fails, with a fresh reset timeout', async () => {
    await failTimes(3);
    now = 1000;
    await failTimes(1);
    expect(breaker.currentState).toBe('open');
    now = 1999;
    expect(breaker.currentState).toBe('open');
    now = 2000;
    expect(breaker.currentState).toBe('half-open');
  });

  it('lets exactly one trial through while half-open', async () => {
    await failTimes(3);
    now = 1000;
    let release!: (v: string) => void;
    const slowTrial = breaker.execute(() => new Promise<string>((r) => (release = r)));

    const concurrent = vi.fn(ok);
    await expect(breaker.execute(concurrent)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(concurrent).not.toHaveBeenCalled();

    release('ok');
    await expect(slowTrial).resolves.toBe('ok');
    expect(breaker.currentState).toBe('closed');
  });
});
