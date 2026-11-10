import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PaymentClient } from '../../src/providers/payment-client.js';
import { ShippingClient } from '../../src/providers/shipping-client.js';
import {
  PAYMENTS,
  RATES,
  breakerPolicy,
  checkoutRequest,
  failThenSucceed,
  idempotencyKey,
  noJitter,
  paymentConfig,
  paymentFails,
  paymentSucceeds,
  rateSucceeds,
  retryPolicy,
  shippingConfig,
} from '../support/fixtures.js';
import { startPostgres, type StartedPostgres } from '../support/postgres.js';
import { header, startWireMock, type StartedWireMock } from '../support/wiremock.js';

/**
 * The whole service over HTTP: Express + real PostgreSQL + WireMock standing in for both
 * providers. Each test builds a fresh app so breaker state never leaks between tests.
 */
let db: StartedPostgres;
let wm: StartedWireMock;

beforeAll(async () => {
  [db, wm] = await Promise.all([startPostgres(), startWireMock()]);
});
afterAll(async () => {
  await Promise.all([db?.stop(), wm?.container.stop()]);
});
beforeEach(async () => {
  await Promise.all([wm.admin.reset(), db.pool.query('TRUNCATE orders')]);
});

function buildApp(payment: Parameters<typeof paymentConfig>[1] = {}): Express {
  return createApp({
    pool: db.pool,
    payments: new PaymentClient(paymentConfig(wm.baseUrl, payment), noJitter),
    shipping: new ShippingClient(shippingConfig(wm.baseUrl), noJitter),
  });
}

const SUBTOTAL = 2 * 2500 + 1800;

interface OrderBody {
  id: string;
  status: string;
  failureReason: string | null;
}
interface HealthBody {
  breakers: Record<string, string>;
}
/** supertest types bodies as `any`; narrow them once, here. */
const body = <T = OrderBody>(res: request.Response) => res.body as T;

describe('POST /orders', () => {
  it('happy path: quotes shipping, charges the total, persists a PAID order', async () => {
    await wm.admin.stub(rateSucceeds(995));
    await wm.admin.stub(paymentSucceeds('pay_e2e_1'));
    const key = idempotencyKey();

    const res = await request(buildApp())
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest())
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'PAID',
      paymentId: 'pay_e2e_1',
      subtotalCents: SUBTOTAL,
      shippingCents: 995,
      shippingSource: 'live',
      totalCents: SUBTOTAL + 995,
      currency: 'AUD',
    });

    const [charge] = await wm.admin.find(PAYMENTS);
    expect(header(charge!, 'idempotency-key')).toBe(key);
    expect(JSON.parse(charge!.body)).toMatchObject({ amountCents: SUBTOTAL + 995 });

    const stored = await db.pool.query<{ status: string }>('SELECT status FROM orders');
    expect(stored.rows).toEqual([{ status: 'PAID' }]);
  });

  it('replays a completed order for the same Idempotency-Key without charging again', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentSucceeds());
    const app = buildApp();
    const key = idempotencyKey();

    const first = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest());
    const second = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest());

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(body(second).id).toBe(body(first).id);
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
    expect(await wm.admin.count(RATES)).toBe(1);
  });

  it('rejects reuse of an Idempotency-Key with a different body (422)', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentSucceeds());
    const app = buildApp();
    const key = idempotencyKey();
    await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest())
      .expect(201);

    const res = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest({ customerId: 'someone-else' }))
      .expect(422);

    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });

  it.each([
    ['missing Idempotency-Key', undefined, checkoutRequest()],
    ['too-short Idempotency-Key', 'abc', checkoutRequest()],
    ['empty items', idempotencyKey(), checkoutRequest({ items: [] })],
  ])('returns 400 for %s and calls no provider', async (_name, key, body) => {
    const req = request(buildApp()).post('/orders');
    if (key) void req.set('Idempotency-Key', key);
    await req.send(body).expect(400);

    expect(await wm.admin.count({ method: 'ANY', urlPathPattern: '/.*' })).toBe(0);
  });

  it('returns 400, not 500, for malformed JSON', async () => {
    await request(buildApp())
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey())
      .set('content-type', 'application/json')
      .send('{"customerId":')
      .expect(400);
  });

  it('still takes the order when shipping is down, using the default rate', async () => {
    await wm.admin.stub({ request: RATES, response: { fault: 'CONNECTION_RESET_BY_PEER' } });
    await wm.admin.stub(paymentSucceeds());

    const res = await request(buildApp())
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey())
      .send(checkoutRequest())
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'PAID',
      shippingSource: 'default',
      shippingCents: 1500,
      totalCents: SUBTOTAL + 1500,
    });
  });

  it('rides out a flaky payment provider (500, 500, 201) inside one request', async () => {
    await wm.admin.stub(rateSucceeds());
    for (const stub of failThenSucceed('flaky-e2e', 2, { status: 500 }, paymentSucceeds())) {
      await wm.admin.stub(stub);
    }

    await request(buildApp())
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey())
      .send(checkoutRequest())
      .expect(201);

    expect(await wm.admin.count(PAYMENTS)).toBe(3);
  });

  it('returns 503 + Retry-After when payment is down, then completes on a client retry', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentFails(503));
    const app = buildApp();
    const key = idempotencyKey();

    const down = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest())
      .expect(503);
    expect(down.headers['retry-after']).toBe('1');
    expect(down.body).toMatchObject({
      status: 'PAYMENT_UNAVAILABLE',
      failureReason: 'HttpStatusError',
    });

    await wm.admin.reset();
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentSucceeds('pay_after_outage'));

    const up = await request(app)
      .post('/orders')
      .set('Idempotency-Key', key)
      .send(checkoutRequest())
      .expect(200);

    expect(up.body).toMatchObject({
      id: body(down).id,
      status: 'PAID',
      paymentId: 'pay_after_outage',
    });
    // The resumed order keeps its original shipping quote: no new rate lookup.
    expect(await wm.admin.count(RATES)).toBe(0);
    const [charge] = await wm.admin.find(PAYMENTS);
    expect(header(charge!, 'idempotency-key')).toBe(key);
  });

  it('returns 402 for a declined card and does not retry', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub({
      request: PAYMENTS,
      response: { status: 402, jsonBody: { status: 'declined', reason: 'card_declined' } },
    });

    const res = await request(buildApp())
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey())
      .send(checkoutRequest())
      .expect(402);

    expect(res.body).toMatchObject({ status: 'PAYMENT_DECLINED', failureReason: 'card_declined' });
    expect(await wm.admin.count(PAYMENTS)).toBe(1);
  });

  it('opens the payment breaker after repeated outages and then fails fast without calling', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentFails(500));
    const app = buildApp({
      retry: retryPolicy({ maxRetries: 0 }),
      breaker: breakerPolicy({ failureThreshold: 2, resetTimeoutMs: 30_000 }),
    });
    const order = () =>
      request(app).post('/orders').set('Idempotency-Key', idempotencyKey()).send(checkoutRequest());

    await order().expect(503);
    await order().expect(503);
    const health = await request(app).get('/health').expect(200);
    expect(body<HealthBody>(health).breakers).toEqual({ payment: 'open', shipping: 'closed' });

    const fastFail = await order().expect(503);
    expect(body(fastFail).failureReason).toBe('CircuitOpenError');
    expect(Number(fastFail.headers['retry-after'])).toBeGreaterThan(1);
    expect(await wm.admin.count(PAYMENTS)).toBe(2);
  });
});

describe('GET /orders/:id and /health', () => {
  it('reads an order back from PostgreSQL', async () => {
    await wm.admin.stub(rateSucceeds());
    await wm.admin.stub(paymentSucceeds());
    const app = buildApp();
    const created = await request(app)
      .post('/orders')
      .set('Idempotency-Key', idempotencyKey())
      .send(checkoutRequest())
      .expect(201);

    const res = await request(app)
      .get(`/orders/${body(created).id}`)
      .expect(200);
    expect(res.body).toEqual(created.body);
  });

  it.each(['00000000-0000-0000-0000-000000000000', 'not-a-uuid'])('404s for %s', async (id) => {
    await request(buildApp()).get(`/orders/${id}`).expect(404);
  });

  it('reports db and breaker state', async () => {
    const res = await request(buildApp()).get('/health').expect(200);
    expect(res.body).toEqual({
      status: 'ok',
      db: 'up',
      breakers: { payment: 'closed', shipping: 'closed' },
    });
  });

  it('sets the security headers the ZAP baseline checks for', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
    });
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
