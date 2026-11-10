import type { BreakerConfig } from '../config.js';
import { CircuitOpenError, DependencyError } from './errors.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * A small consecutive-failure circuit breaker.
 *
 * - closed: calls pass through; `failureThreshold` consecutive health failures open it.
 * - open: calls fail immediately with CircuitOpenError until `resetTimeoutMs` has passed.
 * - half-open: exactly one trial call is let through; success closes, failure re-opens.
 *
 * Only errors whose `countsAsFailure` is true move the counter. A 4xx or 429 is an answer
 * from a healthy dependency, so it neither trips the breaker nor resets the failure streak.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(
    readonly name: string,
    private readonly config: BreakerConfig,
    private readonly now: () => number = Date.now,
  ) {}

  get currentState(): CircuitState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.config.resetTimeoutMs) {
      return 'half-open';
    }
    return this.state;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'open') {
      throw new CircuitOpenError(
        this.name,
        this.config.resetTimeoutMs - (this.now() - this.openedAt),
      );
    }
    if (state === 'half-open') {
      if (this.trialInFlight) throw new CircuitOpenError(this.name, 0);
      this.state = 'half-open';
      this.trialInFlight = true;
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onError(error);
      throw error;
    } finally {
      this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
  }

  private onError(error: unknown): void {
    const isHealthFailure = error instanceof DependencyError && error.countsAsFailure;
    if (this.state === 'half-open') {
      // Any failure of the trial re-opens; a non-health error (e.g. 4xx) proves the dependency answers.
      if (isHealthFailure) this.open();
      else this.onSuccess();
      return;
    }
    if (!isHealthFailure) return;
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.config.failureThreshold) this.open();
  }

  private open(): void {
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
  }
}
