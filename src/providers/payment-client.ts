import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { HttpStatusError } from '../resilience/errors.js';
import { requestJson } from '../resilience/http-json.js';
import { withRetry, type RetryDeps } from '../resilience/retry.js';

const DEPENDENCY = 'payment';

const ChargeResponse = z.object({
  id: z.string().min(1),
  status: z.literal('succeeded'),
});

const DeclineBody = z.object({
  status: z.literal('declined'),
  reason: z.string().optional(),
});

export interface ChargeRequest {
  idempotencyKey: string;
  orderId: string;
  customerId: string;
  amountCents: number;
  currency: string;
}

export type ChargeResult =
  { outcome: 'succeeded'; paymentId: string } | { outcome: 'declined'; reason: string };

/**
 * Client for the payment provider. Every attempt of one charge carries the same
 * Idempotency-Key, which is what makes retrying a POST that may have succeeded safe.
 */
export class PaymentClient {
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly config: AppConfig['payment'],
    private readonly retryDeps: RetryDeps = {},
    breaker?: CircuitBreaker,
  ) {
    this.breaker = breaker ?? new CircuitBreaker(DEPENDENCY, config.breaker);
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    try {
      const body = await withRetry(
        () =>
          this.breaker.execute(() =>
            requestJson(
              {
                dependency: DEPENDENCY,
                method: 'POST',
                url: `${this.config.baseUrl}/v1/payments`,
                timeoutMs: this.config.timeoutMs,
                headers: {
                  authorization: `Bearer ${this.config.apiKey}`,
                  'idempotency-key': req.idempotencyKey,
                },
                body: {
                  reference: req.orderId,
                  customerId: req.customerId,
                  amountCents: req.amountCents,
                  currency: req.currency,
                },
              },
              ChargeResponse,
            ),
          ),
        this.config.retry,
        this.retryDeps,
      );
      return { outcome: 'succeeded', paymentId: body.id };
    } catch (error) {
      if (error instanceof HttpStatusError && error.status === 402) {
        const decline = DeclineBody.safeParse(error.body);
        return { outcome: 'declined', reason: decline.data?.reason ?? 'declined' };
      }
      throw error;
    }
  }
}
