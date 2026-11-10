/**
 * Failure taxonomy for outgoing calls. Retry and circuit-breaker decisions are made
 * on these types only, never on raw fetch errors, so the policy is testable in one place.
 */
export abstract class DependencyError extends Error {
  abstract readonly retryable: boolean;
  /** Whether this failure says something about the dependency's health (feeds the breaker). */
  abstract readonly countsAsFailure: boolean;

  constructor(
    readonly dependency: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${dependency}: ${message}`, options);
    this.name = new.target.name;
  }
}

/** Non-2xx response. 5xx and 429 are retryable; 4xx (other than 429) is a final answer. */
export class HttpStatusError extends DependencyError {
  readonly retryable: boolean;
  readonly countsAsFailure: boolean;

  constructor(
    dependency: string,
    readonly status: number,
    readonly retryAfterMs: number | undefined,
    readonly body: unknown,
  ) {
    super(dependency, `HTTP ${status}`);
    this.retryable = status >= 500 || status === 429;
    // 429 means "you are calling too fast", not "I am broken": it must not open the breaker.
    this.countsAsFailure = status >= 500;
  }
}

/** The dependency did not answer within the timeout. */
export class TimeoutError extends DependencyError {
  readonly retryable = true;
  readonly countsAsFailure = true;

  constructor(
    dependency: string,
    readonly timeoutMs: number,
  ) {
    super(dependency, `timed out after ${timeoutMs} ms`);
  }
}

/** Connection reset, empty reply, garbage on the wire. */
export class NetworkError extends DependencyError {
  readonly retryable = true;
  readonly countsAsFailure = true;
}

/** 2xx with a body that does not match the contract we rely on. */
export class MalformedResponseError extends DependencyError {
  readonly retryable = true;
  readonly countsAsFailure = true;
}

/** Thrown without calling the dependency because the breaker is open. */
export class CircuitOpenError extends DependencyError {
  readonly retryable = false;
  readonly countsAsFailure = false;

  constructor(
    dependency: string,
    readonly retryInMs: number,
  ) {
    super(dependency, `circuit open, next trial in ${retryInMs} ms`);
  }
}

/** Retry-After asked for a longer wait than we are willing to block a request for. */
export class RetryAfterTooLongError extends DependencyError {
  readonly retryable = false;
  readonly countsAsFailure = false;

  constructor(
    dependency: string,
    readonly retryAfterMs: number,
    options?: ErrorOptions,
  ) {
    super(dependency, `Retry-After ${retryAfterMs} ms exceeds the allowed wait`, options);
  }
}
