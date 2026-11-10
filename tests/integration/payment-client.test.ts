import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentClient, type ChargeRequest } from '../../src/providers/payment-client.js';
import {
  CircuitOpenError,
  HttpStatusError,
  MalformedResponseError,
  NetworkError,
  RetryAfterTooLongError,
  TimeoutError,
} from '../../src/resilience/errors.js';
import {
  PAYMENTS,
  breakerPolicy,
  failThenSucceed,
  noJitter,
  paymentConfig,
  paymentFails,
  paymentSucceeds,
  retryPolicy,
} from '../support/fixtures.js';
import { header, startWireMock, type Fault, type StartedWireMock } from '../support/wiremock.js';

let wm: StartedWireMock;

beforeAll(async () => {
  wm = await startWireMock();
});
afterAll(async () => {
  await wm?.container.stop();
});
beforeEach(async () => {
  await wm.admin.reset();
});

const charge: ChargeRequest = {
  idempotencyKey: 'idem-key-0001',
  orderId: 'order-1',
  customerId: 'cust-42',
  amountCents: 8795,
  currency: 'AUD',
};

const client = (overrides: Parameters<typeof paymentConfig>[1] = {}) =>
  new PaymentClient(paymentConfig(wm.baseUrl, overrides), noJitter);

const elapsed = async (fn: () => Promise<unknown>) => {
  const start = performance.now();
  await fn().catch(() => undefined);
  return performance.now() - start;
};

describe('payment client: outgoing request contract', () => {
  it('sends auth, idempotency key and the agreed JSON body', async () => {
    // The stub only matches a correct request; anything else lands in the unmatched journal.
    await wm.admin.stub({
      request: {
        ...PAYMENTS,
        headers: {
          Authorization: { equalTo: 'Bearer sk_test_lab' },
          'Idempotency-Key': { equalTo: charge.idempotencyKey },
          'Content-Type': { matches: 'application/json.*' },
        },
        bodyPatterns: [
          {
            equalToJson: {
              reference: 'order-1',
              customerId: 'cust-42',
              amountCents: 8795,
              currency: 'AUD',
            },
          },
        ],
      },
      response: { status: 201, jsonBody: { id: 'pay_123', status: 'succeeded' } },
    });

    await expect(client().charge(charge)).resolves.toEqual({
      outcome: 'succeeded',
      paymentId: 'pay_123',
    });
    expect(await wm.admin.unmatched()).toEqual([]);
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });
});

describe('payment client: retries', () => {
  it('fails twice with 500, then succeeds on the third attempt with the same idempotency key', async () => {
    for (const stub of failThenSucceed('flaky', 2, { status: 500 }, paymentSucceeds('pay_ok'))) {
      await wm.admin.stub(stub);
    }

    await expect(client().charge(charge)).resolves.toMatchObject({ paymentId: 'pay_ok' });

    const requests = await wm.admin.find(PAYMENTS);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => header(r, 'idempotency-key')))).toEqual(
      new Set([charge.idempotencyKey]),
    );
  });

  it('stops after maxRetries and surfaces the last 5xx', async () => {
    await wm.admin.stub(paymentFails(503));

    const error = await client()
      .charge(charge)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ status: 503 });
    expect(await wm.admin.count(PAYMENTS)).toBe(3); // 1 attempt + 2 retries
  });

  it('honours Retry-After on 429 before retrying', async () => {
    for (const stub of failThenSucceed(
      'rate-limited',
      1,
      { status: 429, headers: { 'Retry-After': '1' } },
      paymentSucceeds(),
    )) {
      await wm.admin.stub(stub);
    }

    const ms = await elapsed(() => client().charge(charge));

    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(await wm.admin.count(PAYMENTS)).toBe(2);
  });

  it('fails fast when Retry-After asks for longer than the allowed wait', async () => {
    await wm.admin.stub(paymentFails(429, { 'Retry-After': '120' }));

    const error = await client()
      .charge(charge)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RetryAfterTooLongError);
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });

  it('treats 402 as a decline: a final answer, never retried', async () => {
    await wm.admin.stub({
      request: PAYMENTS,
      response: { status: 402, jsonBody: { status: 'declined', reason: 'insufficient_funds' } },
    });

    await expect(client().charge(charge)).resolves.toEqual({
      outcome: 'declined',
      reason: 'insufficient_funds',
    });
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });
});

describe('payment client: timeouts and faults', () => {
  it('times out a slow provider on every attempt, bounded by timeout x attempts', async () => {
    await wm.admin.stub({
      request: PAYMENTS,
      response: { ...paymentSucceeds().response, fixedDelayMilliseconds: 5000 },
    });

    // 500 ms, not less: on a loaded Docker Desktop the TCP connect through the port forward can
    // eat a very short budget, so the attempt times out before WireMock ever logs it.
    const retries: string[] = [];
    const payments = new PaymentClient(paymentConfig(wm.baseUrl, { timeoutMs: 500 }), {
      ...noJitter,
      onRetry: ({ error }) => retries.push(error.name),
    });

    let error: unknown;
    const ms = await elapsed(async () => {
      error = await payments.charge(charge).catch((e: unknown) => e);
    });

    expect(error).toBeInstanceOf(TimeoutError);
    expect(retries).toEqual(['TimeoutError', 'TimeoutError']);
    expect(await wm.admin.count(PAYMENTS)).toBe(3);
    // 3 x 500 ms of timeouts plus zero-jitter backoff; far less than one 5 s delayed response.
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThan(4000);
  });

  it.each<Fault>([
    'CONNECTION_RESET_BY_PEER',
    'EMPTY_RESPONSE',
    'MALFORMED_RESPONSE_CHUNK',
    'RANDOM_DATA_THEN_CLOSE',
  ])('maps WireMock fault %s to a retryable NetworkError', async (fault) => {
    await wm.admin.stub({ request: PAYMENTS, response: { fault } });

    const error = await client({ retry: retryPolicy({ maxRetries: 1 }) })
      .charge(charge)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NetworkError);
    expect(await wm.admin.count(PAYMENTS)).toBe(2);
  });

  it.each([
    ['a non-JSON body', { body: '<html>gateway</html>' }],
    ['JSON missing the payment id', { jsonBody: { status: 'succeeded' } }],
    ['an unexpected status value', { jsonBody: { id: 'pay_1', status: 'pending' } }],
  ])('rejects a 201 with %s as MalformedResponseError', async (_name, body) => {
    await wm.admin.stub({ request: PAYMENTS, response: { status: 201, ...body } });

    const error = await client({ retry: retryPolicy({ maxRetries: 0 }) })
      .charge(charge)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MalformedResponseError);
  });
});

describe('payment client: circuit breaker', () => {
  it('opens after the threshold and stops calling the provider', async () => {
    await wm.admin.stub(paymentFails(500));
    const payments = client({
      retry: retryPolicy({ maxRetries: 0 }),
      breaker: breakerPolicy({ failureThreshold: 3, resetTimeoutMs: 60_000 }),
    });

    for (let i = 0; i < 3; i++) await payments.charge(charge).catch(() => undefined);
    expect(payments.breaker.currentState).toBe('open');

    const error = await payments.charge(charge).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(await wm.admin.count(PAYMENTS)).toBe(3); // the 4th charge never left the process
  });

  it('cuts a retry loop short once the breaker opens mid-way', async () => {
    await wm.admin.stub(paymentFails(500));
    const payments = client({
      retry: retryPolicy({ maxRetries: 5 }),
      breaker: breakerPolicy({ failureThreshold: 2 }),
    });

    const error = await payments.charge(charge).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(await wm.admin.count(PAYMENTS)).toBe(2); // not 6
  });

  it('half-opens after the reset timeout and closes when the trial succeeds', async () => {
    await wm.admin.stub(paymentFails(500));
    const payments = client({
      retry: retryPolicy({ maxRetries: 0 }),
      breaker: breakerPolicy({ failureThreshold: 2, resetTimeoutMs: 300 }),
    });
    for (let i = 0; i < 2; i++) await payments.charge(charge).catch(() => undefined);
    expect(payments.breaker.currentState).toBe('open');

    await wm.admin.reset();
    await wm.admin.stub(paymentSucceeds('pay_recovered'));
    await new Promise((r) => setTimeout(r, 350));
    expect(payments.breaker.currentState).toBe('half-open');

    await expect(payments.charge(charge)).resolves.toMatchObject({ paymentId: 'pay_recovered' });
    expect(payments.breaker.currentState).toBe('closed');
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });

  it('does not open on 429s: rate limiting is not an outage', async () => {
    await wm.admin.stub(paymentFails(429, { 'Retry-After': '0' }));
    const payments = client({
      retry: retryPolicy({ maxRetries: 0 }),
      breaker: breakerPolicy({ failureThreshold: 2 }),
    });

    for (let i = 0; i < 5; i++) await payments.charge(charge).catch(() => undefined);

    expect(payments.breaker.currentState).toBe('closed');
    expect(await wm.admin.count(PAYMENTS)).toBe(5);
  });
});
