import { describe, expect, it } from 'vitest';
import { CheckoutRequest, hashRequest } from '../../src/orders/checkout-service.js';
import { loadConfig } from '../../src/config.js';
import { HttpStatusError } from '../../src/resilience/errors.js';

const request: CheckoutRequest = {
  customerId: 'cust-1',
  items: [{ sku: 'SKU-1', quantity: 2, unitPriceCents: 1250 }],
  shippingAddress: { country: 'AU', postcode: '2000' },
};

describe('hashRequest', () => {
  it('ignores JSON key order', () => {
    const reordered = {
      shippingAddress: { postcode: '2000', country: 'AU' },
      items: [{ unitPriceCents: 1250, quantity: 2, sku: 'SKU-1' }],
      customerId: 'cust-1',
    };
    expect(hashRequest(reordered)).toBe(hashRequest(request));
  });

  it('changes when any value changes', () => {
    const changed = { ...request, items: [{ sku: 'SKU-1', quantity: 3, unitPriceCents: 1250 }] };
    expect(hashRequest(changed)).not.toBe(hashRequest(request));
  });
});

describe('CheckoutRequest schema', () => {
  it('accepts a valid request', () => {
    expect(CheckoutRequest.safeParse(request).success).toBe(true);
  });

  it.each([
    ['no items', { ...request, items: [] }],
    ['zero quantity', { ...request, items: [{ sku: 'A', quantity: 0, unitPriceCents: 1 }] }],
    ['fractional price', { ...request, items: [{ sku: 'A', quantity: 1, unitPriceCents: 1.5 }] }],
    ['3-letter country', { ...request, shippingAddress: { country: 'AUS', postcode: '2000' } }],
  ])('rejects %s', (_name, body) => {
    expect(CheckoutRequest.safeParse(body).success).toBe(false);
  });
});

describe('HttpStatusError classification', () => {
  it.each([
    [500, true, true],
    [503, true, true],
    [429, true, false],
    [402, false, false],
    [404, false, false],
  ])('HTTP %i: retryable=%s, counts against breaker=%s', (status, retryable, counts) => {
    const error = new HttpStatusError('dep', status, undefined, null);
    expect(error.retryable).toBe(retryable);
    expect(error.countsAsFailure).toBe(counts);
  });
});

describe('loadConfig', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    PAYMENT_BASE_URL: 'http://localhost:8080/payment',
    SHIPPING_BASE_URL: 'http://localhost:8080/shipping',
  };

  it('applies defaults', () => {
    const config = loadConfig(base);
    expect(config.port).toBe(3000);
    expect(config.payment.retry.maxRetries).toBe(2);
    expect(config.shipping.timeoutMs).toBe(800);
  });

  it('coerces numeric env vars', () => {
    expect(loadConfig({ ...base, PAYMENT_TIMEOUT_MS: '250' }).payment.timeoutMs).toBe(250);
  });

  it('fails loudly on a missing required variable', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: undefined })).toThrow();
  });
});
