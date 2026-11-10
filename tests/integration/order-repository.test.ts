import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { OrderRepository, type NewOrder } from '../../src/orders/order-repository.js';
import { idempotencyKey } from '../support/fixtures.js';
import { startPostgres, type StartedPostgres } from '../support/postgres.js';

let db: StartedPostgres;
let repo: OrderRepository;

beforeAll(async () => {
  db = await startPostgres();
  repo = new OrderRepository(db.pool);
});
afterAll(async () => {
  await db?.stop();
});
beforeEach(async () => {
  await db.pool.query('TRUNCATE orders');
});

const newOrder = (overrides: Partial<NewOrder> = {}): NewOrder => ({
  idempotencyKey: idempotencyKey(),
  requestHash: 'hash-1',
  customerId: 'cust-42',
  items: [{ sku: 'BOOK-001', quantity: 2, unitPriceCents: 2500 }],
  subtotalCents: 5000,
  shippingCents: 995,
  shippingSource: 'live',
  currency: 'AUD',
  ...overrides,
});

describe('migrations (real PostgreSQL)', () => {
  it('are recorded and not re-applied', async () => {
    await expect(migrate(db.pool)).resolves.toEqual([]);
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM schema_migrations');
    expect(rows.map((r) => r.id)).toEqual(['001_create_orders']);
  });

  it('are safe to run concurrently (advisory lock)', async () => {
    const results = await Promise.all([migrate(db.pool), migrate(db.pool), migrate(db.pool)]);
    expect(results).toEqual([[], [], []]);
  });
});

describe('order repository (real PostgreSQL)', () => {
  it('creates a PENDING_PAYMENT order with a generated total', async () => {
    const { order, created } = await repo.insertOrGet(newOrder());

    expect(created).toBe(true);
    expect(order).toMatchObject({ status: 'PENDING_PAYMENT', totalCents: 5995, paymentId: null });
    expect(order.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns the existing order for a repeated idempotency key', async () => {
    const input = newOrder();
    const first = await repo.insertOrGet(input);
    const second = await repo.insertOrGet({ ...input, subtotalCents: 1 });

    expect(second.created).toBe(false);
    expect(second.order.id).toBe(first.order.id);
    expect(second.order.subtotalCents).toBe(5000);
  });

  it('creates exactly one row when 20 requests race with the same key', async () => {
    const input = newOrder();
    const results = await Promise.all(Array.from({ length: 20 }, () => repo.insertOrGet(input)));

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.order.id)).size).toBe(1);
    const { rows } = await db.pool.query<{ n: string }>('SELECT count(*) AS n FROM orders');
    expect(rows[0]?.n).toBe('1');
  });

  it('records a payment outcome', async () => {
    const { order } = await repo.insertOrGet(newOrder());
    const paid = await repo.updatePayment(order.id, { status: 'PAID', paymentId: 'pay_1' });

    expect(paid).toMatchObject({ status: 'PAID', paymentId: 'pay_1', failureReason: null });
    expect(paid.updatedAt.getTime()).toBeGreaterThanOrEqual(order.updatedAt.getTime());
    await expect(repo.findById(order.id)).resolves.toMatchObject({ status: 'PAID' });
  });

  it('lets the schema reject states the code should never write', async () => {
    const { order } = await repo.insertOrGet(newOrder());
    await expect(
      db.pool.query(`UPDATE orders SET status = 'SHIPPED' WHERE id = $1`, [order.id]),
    ).rejects.toThrow(/orders_status_check/);
    await expect(repo.insertOrGet(newOrder({ shippingCents: -1 }))).rejects.toThrow(
      /orders_shipping_cents_check/,
    );
  });
});
