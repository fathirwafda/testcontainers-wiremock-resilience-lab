import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PaymentClient } from '../providers/payment-client.js';
import type { ShippingClient } from '../providers/shipping-client.js';
import { CircuitOpenError, DependencyError } from '../resilience/errors.js';
import type { Order, OrderRepository } from './order-repository.js';

export const CURRENCY = 'AUD';

export const CheckoutRequest = z.object({
  customerId: z.string().min(1).max(64),
  items: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        quantity: z.number().int().positive().max(100),
        unitPriceCents: z.number().int().nonnegative().max(10_000_000),
      }),
    )
    .min(1)
    .max(50),
  shippingAddress: z.object({
    country: z.string().length(2),
    postcode: z.string().min(3).max(10),
  }),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency-Key was already used with a different request body');
    this.name = 'IdempotencyConflictError';
  }
}

export interface CheckoutResult {
  order: Order;
  /** True when this response replays an earlier request with the same Idempotency-Key. */
  replayed: boolean;
  /** Set when payment is unavailable: how long the client should wait before retrying. */
  retryAfterSeconds?: number;
}

const FINAL_STATUSES = new Set<Order['status']>(['PAID', 'PAYMENT_DECLINED']);

export class CheckoutService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly payments: PaymentClient,
    private readonly shipping: ShippingClient,
  ) {}

  async checkout(idempotencyKey: string, request: CheckoutRequest): Promise<CheckoutResult> {
    const requestHash = hashRequest(request);

    const existing = await this.orders.findByIdempotencyKey(idempotencyKey);
    if (existing) return this.resume(existing, requestHash);

    const quote = await this.shipping.quote({
      country: request.shippingAddress.country,
      postcode: request.shippingAddress.postcode,
      itemCount: request.items.reduce((n, i) => n + i.quantity, 0),
    });
    const { order, created } = await this.orders.insertOrGet({
      idempotencyKey,
      requestHash,
      customerId: request.customerId,
      items: request.items,
      subtotalCents: request.items.reduce((sum, i) => sum + i.quantity * i.unitPriceCents, 0),
      shippingCents: quote.amountCents,
      shippingSource: quote.source,
      currency: CURRENCY,
    });
    // Lost a race with a concurrent request that used the same key.
    if (!created) return this.resume(order, requestHash);

    return this.pay(order, false);
  }

  /** Same key again: replay a final outcome, or retry payment for an order that never got one. */
  private async resume(order: Order, requestHash: string): Promise<CheckoutResult> {
    if (order.requestHash !== requestHash) throw new IdempotencyConflictError();
    if (FINAL_STATUSES.has(order.status)) return { order, replayed: true };
    return this.pay(order, true);
  }

  private async pay(order: Order, replayed: boolean): Promise<CheckoutResult> {
    try {
      const result = await this.payments.charge({
        // The order's key is reused for the provider, so a retried checkout cannot double-charge.
        idempotencyKey: order.idempotencyKey,
        orderId: order.id,
        customerId: order.customerId,
        amountCents: order.totalCents,
        currency: order.currency,
      });
      const updated =
        result.outcome === 'succeeded'
          ? await this.orders.updatePayment(order.id, {
              status: 'PAID',
              paymentId: result.paymentId,
            })
          : await this.orders.updatePayment(order.id, {
              status: 'PAYMENT_DECLINED',
              failureReason: result.reason,
            });
      return { order: updated, replayed };
    } catch (error) {
      if (!(error instanceof DependencyError)) throw error;
      const updated = await this.orders.updatePayment(order.id, {
        status: 'PAYMENT_UNAVAILABLE',
        failureReason: error.name,
      });
      const retryAfterSeconds =
        error instanceof CircuitOpenError ? Math.max(1, Math.ceil(error.retryInMs / 1000)) : 1;
      return { order: updated, replayed, retryAfterSeconds };
    }
  }
}

/** Stable hash of the request body: key order in the JSON must not matter. */
export function hashRequest(request: CheckoutRequest): string {
  return createHash('sha256').update(stableStringify(request)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
