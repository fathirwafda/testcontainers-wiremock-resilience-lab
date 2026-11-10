import type { Pool } from 'pg';
import type { RateSource } from '../providers/shipping-client.js';

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'PAYMENT_DECLINED' | 'PAYMENT_UNAVAILABLE';

export interface OrderItem {
  sku: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  idempotencyKey: string;
  requestHash: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotalCents: number;
  shippingCents: number;
  shippingSource: RateSource;
  totalCents: number;
  currency: string;
  paymentId: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewOrder {
  idempotencyKey: string;
  requestHash: string;
  customerId: string;
  items: OrderItem[];
  subtotalCents: number;
  shippingCents: number;
  shippingSource: RateSource;
  currency: string;
}

interface OrderRow {
  id: string;
  idempotency_key: string;
  request_hash: string;
  customer_id: string;
  status: OrderStatus;
  items: OrderItem[];
  subtotal_cents: number;
  shipping_cents: number;
  shipping_source: RateSource;
  total_cents: number;
  currency: string;
  payment_id: string | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const toOrder = (r: OrderRow): Order => ({
  id: r.id,
  idempotencyKey: r.idempotency_key,
  requestHash: r.request_hash,
  customerId: r.customer_id,
  status: r.status,
  items: r.items,
  subtotalCents: r.subtotal_cents,
  shippingCents: r.shipping_cents,
  shippingSource: r.shipping_source,
  totalCents: r.total_cents,
  currency: r.currency,
  paymentId: r.payment_id,
  failureReason: r.failure_reason,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class OrderRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Inserts the order unless one with the same idempotency key exists. The UNIQUE constraint,
   * not a read-then-write check, is what makes two concurrent requests produce one order.
   */
  async insertOrGet(order: NewOrder): Promise<{ order: Order; created: boolean }> {
    const inserted = await this.pool.query<OrderRow>(
      `INSERT INTO orders (idempotency_key, request_hash, customer_id, status, items,
                           subtotal_cents, shipping_cents, shipping_source, currency)
       VALUES ($1, $2, $3, 'PENDING_PAYMENT', $4, $5, $6, $7, $8)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        order.idempotencyKey,
        order.requestHash,
        order.customerId,
        JSON.stringify(order.items),
        order.subtotalCents,
        order.shippingCents,
        order.shippingSource,
        order.currency,
      ],
    );
    const row = inserted.rows[0];
    if (row) return { order: toOrder(row), created: true };
    const existing = await this.findByIdempotencyKey(order.idempotencyKey);
    if (!existing) throw new Error('order vanished between conflict and read');
    return { order: existing, created: false };
  }

  async findById(id: string): Promise<Order | undefined> {
    const { rows } = await this.pool.query<OrderRow>('SELECT * FROM orders WHERE id = $1', [id]);
    return rows[0] && toOrder(rows[0]);
  }

  async findByIdempotencyKey(key: string): Promise<Order | undefined> {
    const { rows } = await this.pool.query<OrderRow>(
      'SELECT * FROM orders WHERE idempotency_key = $1',
      [key],
    );
    return rows[0] && toOrder(rows[0]);
  }

  async updatePayment(
    id: string,
    update: { status: OrderStatus; paymentId?: string | null; failureReason?: string | null },
  ): Promise<Order> {
    const { rows } = await this.pool.query<OrderRow>(
      `UPDATE orders
          SET status = $2, payment_id = $3, failure_reason = $4, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [id, update.status, update.paymentId ?? null, update.failureReason ?? null],
    );
    if (!rows[0]) throw new Error(`order ${id} not found`);
    return toOrder(rows[0]);
  }
}
