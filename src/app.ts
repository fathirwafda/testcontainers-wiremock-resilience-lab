import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import pg from 'pg';
import type { AppConfig } from './config.js';
import { OrderRepository, type Order } from './orders/order-repository.js';
import {
  CheckoutRequest,
  CheckoutService,
  IdempotencyConflictError,
  type CheckoutResult,
} from './orders/checkout-service.js';
import { PaymentClient } from './providers/payment-client.js';
import { ShippingClient } from './providers/shipping-client.js';
import { securityHeaders } from './http/security-headers.js';
import type { RetryDeps } from './resilience/retry.js';

export interface AppDeps {
  pool: pg.Pool;
  payments: PaymentClient;
  shipping: ShippingClient;
}

export function createDeps(config: AppConfig, retryDeps: RetryDeps = {}): AppDeps {
  return {
    pool: new pg.Pool({ connectionString: config.databaseUrl, max: 10 }),
    payments: new PaymentClient(config.payment, retryDeps),
    shipping: new ShippingClient(config.shipping, retryDeps),
  };
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createApp(deps: AppDeps): express.Express {
  const orders = new OrderRepository(deps.pool);
  const checkout = new CheckoutService(orders, deps.payments, deps.shipping);

  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));

  app.get('/', (_req, res) => {
    res.json({
      service: 'checkout-service',
      endpoints: ['GET /health', 'POST /orders', 'GET /orders/:id'],
    });
  });

  app.get('/health', async (_req, res) => {
    let db: 'up' | 'down' = 'up';
    try {
      await deps.pool.query('SELECT 1');
    } catch {
      db = 'down';
    }
    res.status(db === 'up' ? 200 : 503).json({
      status: db === 'up' ? 'ok' : 'degraded',
      db,
      breakers: {
        payment: deps.payments.breaker.currentState,
        shipping: deps.shipping.breaker.currentState,
      },
    });
  });

  app.post('/orders', async (req: Request, res: Response) => {
    const key = req.get('idempotency-key');
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      problem(res, 400, 'Idempotency-Key header is required (8-128 chars of [A-Za-z0-9_-])');
      return;
    }
    const parsed = CheckoutRequest.safeParse(req.body);
    if (!parsed.success) {
      problem(res, 400, 'Invalid request body', {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return;
    }
    let result: CheckoutResult;
    try {
      result = await checkout.checkout(key, parsed.data);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        problem(res, 422, error.message);
        return;
      }
      throw error;
    }
    sendCheckoutResult(res, result);
  });

  app.get('/orders/:id', async (req: Request<{ id: string }>, res: Response) => {
    const order = UUID.test(req.params.id) ? await orders.findById(req.params.id) : undefined;
    if (!order) {
      problem(res, 404, 'Order not found');
      return;
    }
    res.json(toResponse(order));
  });

  app.use((_req, res) => problem(res, 404, 'Not found'));
  app.use(errorHandler);
  return app;
}

function sendCheckoutResult(res: Response, { order, replayed, retryAfterSeconds }: CheckoutResult) {
  if (replayed) res.set('idempotent-replayed', 'true');
  switch (order.status) {
    case 'PAID':
      res.status(replayed ? 200 : 201).json(toResponse(order));
      return;
    case 'PAYMENT_DECLINED':
      res.status(402).json(toResponse(order));
      return;
    case 'PAYMENT_UNAVAILABLE':
    case 'PENDING_PAYMENT':
      res.set('retry-after', String(retryAfterSeconds ?? 1));
      res.status(503).json(toResponse(order));
      return;
  }
}

function toResponse(order: Order) {
  return {
    id: order.id,
    status: order.status,
    customerId: order.customerId,
    items: order.items,
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    shippingSource: order.shippingSource,
    totalCents: order.totalCents,
    currency: order.currency,
    paymentId: order.paymentId,
    failureReason: order.failureReason,
    createdAt: order.createdAt.toISOString(),
  };
}

function problem(res: Response, status: number, title: string, extra: object = {}) {
  res
    .status(status)
    .type('application/problem+json')
    .json({ status, title, ...extra });
}

const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
  // body-parser marks client errors (bad JSON, too large) with a 4xx status.
  const status =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : 500;
  if (status >= 500) console.error(JSON.stringify({ level: 'error', msg: String(error) }));
  problem(res, status, status >= 500 ? 'Internal server error' : 'Bad request');
};
