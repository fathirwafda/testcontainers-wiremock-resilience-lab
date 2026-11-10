import { randomUUID } from 'node:crypto';
import type { AppConfig, BreakerConfig, RetryConfig } from '../../src/config.js';
import type { CheckoutRequest } from '../../src/orders/checkout-service.js';
import type { RetryDeps } from '../../src/resilience/retry.js';
import type { RequestPattern, StubMapping } from './wiremock.js';

/** Zero jitter keeps retry tests fast; Retry-After tests still wait for real. */
export const noJitter: RetryDeps = { random: () => 0 };

export const retryPolicy = (overrides: Partial<RetryConfig> = {}): RetryConfig => ({
  maxRetries: 2,
  baseDelayMs: 20,
  maxDelayMs: 200,
  retryAfterMaxMs: 3000,
  ...overrides,
});

export const breakerPolicy = (overrides: Partial<BreakerConfig> = {}): BreakerConfig => ({
  failureThreshold: 50,
  resetTimeoutMs: 60_000,
  ...overrides,
});

export function paymentConfig(
  wiremockUrl: string,
  overrides: Partial<AppConfig['payment']> = {},
): AppConfig['payment'] {
  return {
    baseUrl: `${wiremockUrl}/payment`,
    apiKey: 'sk_test_lab',
    timeoutMs: 3000, // generous on purpose: timeout tests set their own short value
    retry: retryPolicy(),
    breaker: breakerPolicy(),
    ...overrides,
  };
}

export function shippingConfig(
  wiremockUrl: string,
  overrides: Partial<AppConfig['shipping']> = {},
): AppConfig['shipping'] {
  return {
    baseUrl: `${wiremockUrl}/shipping`,
    timeoutMs: 3000,
    retry: retryPolicy({ maxRetries: 1 }),
    breaker: breakerPolicy(),
    cacheTtlMs: 60_000,
    defaultRateCents: 1500,
    ...overrides,
  };
}

export const idempotencyKey = () => `test-${randomUUID()}`;

export const checkoutRequest = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  customerId: 'cust-42',
  items: [
    { sku: 'BOOK-001', quantity: 2, unitPriceCents: 2500 },
    { sku: 'MUG-007', quantity: 1, unitPriceCents: 1800 },
  ],
  shippingAddress: { country: 'AU', postcode: '2000' },
  ...overrides,
});

// ---- WireMock request patterns and stubs for the two fake providers -------------------------

export const PAYMENTS: RequestPattern = { method: 'POST', urlPath: '/payment/v1/payments' };
export const RATES: RequestPattern = { method: 'GET', urlPath: '/shipping/v1/rates' };

export const paymentSucceeds = (id = 'pay_test_001'): StubMapping => ({
  request: PAYMENTS,
  response: { status: 201, jsonBody: { id, status: 'succeeded' } },
});

export const paymentFails = (
  status: number,
  headers: Record<string, string> = {},
): StubMapping => ({
  request: PAYMENTS,
  response: { status, headers, jsonBody: { error: 'provider_error' } },
});

export const rateSucceeds = (amountCents = 995): StubMapping => ({
  request: RATES,
  response: { status: 200, jsonBody: { amountCents, currency: 'AUD', service: 'express' } },
});

/**
 * A stateful WireMock scenario: the first `failures` calls get `failure`, then `success` forever.
 * Returned as an array of stubs because each scenario state is its own mapping.
 */
export function failThenSucceed(
  scenarioName: string,
  failures: number,
  failure: StubMapping['response'],
  success: StubMapping,
): StubMapping[] {
  const state = (n: number) => (n === 0 ? 'Started' : `failed-${n}`);
  const stubs: StubMapping[] = [];
  for (let n = 0; n < failures; n++) {
    stubs.push({
      request: success.request,
      response: failure,
      scenarioName,
      requiredScenarioState: state(n),
      newScenarioState: state(n + 1),
    });
  }
  stubs.push({ ...success, scenarioName, requiredScenarioState: state(failures) });
  return stubs;
}
