import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ShippingClient } from '../../src/providers/shipping-client.js';
import {
  RATES,
  breakerPolicy,
  noJitter,
  rateSucceeds,
  retryPolicy,
  shippingConfig,
} from '../support/fixtures.js';
import { startWireMock, type StartedWireMock } from '../support/wiremock.js';

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

const sydney = { country: 'AU', postcode: '2000', itemCount: 3 };

describe('shipping client: fallback', () => {
  it('returns a live quote and sends the destination as query parameters', async () => {
    await wm.admin.stub({
      request: {
        ...RATES,
        queryParameters: {
          country: { equalTo: 'AU' },
          postcode: { equalTo: '2000' },
          items: { equalTo: '3' },
        },
      },
      response: rateSucceeds(995).response,
    });

    const quote = await new ShippingClient(shippingConfig(wm.baseUrl), noJitter).quote(sydney);

    expect(quote).toEqual({
      amountCents: 995,
      currency: 'AUD',
      service: 'express',
      source: 'live',
    });
    expect(await wm.admin.unmatched()).toEqual([]);
  });

  it('falls back to the default rate when the provider returns 503', async () => {
    await wm.admin.stub({ request: RATES, response: { status: 503 } });

    const quote = await new ShippingClient(shippingConfig(wm.baseUrl), noJitter).quote(sydney);

    expect(quote).toMatchObject({
      amountCents: 1500,
      source: 'default',
      degradedReason: 'HttpStatusError',
    });
    expect(await wm.admin.count(RATES)).toBe(2); // 1 attempt + 1 retry, then give up
  });

  it('serves the last good quote for the same destination when the provider goes down', async () => {
    const shipping = new ShippingClient(shippingConfig(wm.baseUrl), noJitter);
    await wm.admin.stub(rateSucceeds(1234));
    await shipping.quote(sydney);

    await wm.admin.reset();
    await wm.admin.stub({ request: RATES, response: { fault: 'CONNECTION_RESET_BY_PEER' } });

    await expect(shipping.quote(sydney)).resolves.toMatchObject({
      amountCents: 1234,
      source: 'cache',
      degradedReason: 'NetworkError',
    });
    // A different destination has no cached quote.
    await expect(shipping.quote({ ...sydney, postcode: '3000' })).resolves.toMatchObject({
      source: 'default',
    });
  });

  it('ignores a cached quote older than the TTL', async () => {
    let now = 0;
    const shipping = new ShippingClient(
      shippingConfig(wm.baseUrl, { cacheTtlMs: 1000 }),
      noJitter,
      () => now,
    );
    await wm.admin.stub(rateSucceeds(1234));
    await shipping.quote(sydney);

    await wm.admin.reset();
    await wm.admin.stub({ request: RATES, response: { status: 500 } });
    now = 1001;

    await expect(shipping.quote(sydney)).resolves.toMatchObject({ source: 'default' });
  });

  it('degrades quickly on a slow provider instead of holding the checkout', async () => {
    await wm.admin.stub({
      request: RATES,
      response: { ...rateSucceeds().response, fixedDelayMilliseconds: 3000 },
    });
    const shipping = new ShippingClient(
      shippingConfig(wm.baseUrl, { timeoutMs: 200, retry: retryPolicy({ maxRetries: 1 }) }),
      noJitter,
    );

    const start = performance.now();
    const quote = await shipping.quote(sydney);
    const ms = performance.now() - start;

    expect(quote).toMatchObject({ source: 'default', degradedReason: 'TimeoutError' });
    expect(ms).toBeLessThan(1000);
  });

  it('rejects a contract-breaking 200 (missing amount) and falls back', async () => {
    await wm.admin.stub({
      request: RATES,
      response: { status: 200, jsonBody: { currency: 'AUD', service: 'express' } },
    });

    const quote = await new ShippingClient(
      shippingConfig(wm.baseUrl, { retry: retryPolicy({ maxRetries: 0 }) }),
      noJitter,
    ).quote(sydney);

    expect(quote).toMatchObject({ source: 'default', degradedReason: 'MalformedResponseError' });
  });

  it('with the breaker open, falls back without calling the provider', async () => {
    await wm.admin.stub({ request: RATES, response: { status: 500 } });
    const shipping = new ShippingClient(
      shippingConfig(wm.baseUrl, {
        retry: retryPolicy({ maxRetries: 0 }),
        breaker: breakerPolicy({ failureThreshold: 2 }),
      }),
      noJitter,
    );
    await shipping.quote(sydney);
    await shipping.quote(sydney);
    expect(shipping.breaker.currentState).toBe('open');

    await expect(shipping.quote(sydney)).resolves.toMatchObject({
      source: 'default',
      degradedReason: 'CircuitOpenError',
    });
    expect(await wm.admin.count(RATES)).toBe(2);
  });
});
