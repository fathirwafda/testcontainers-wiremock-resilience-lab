import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { CircuitBreaker } from '../resilience/circuit-breaker.js';
import { DependencyError } from '../resilience/errors.js';
import { requestJson } from '../resilience/http-json.js';
import { withRetry, type RetryDeps } from '../resilience/retry.js';

const DEPENDENCY = 'shipping';

const RateResponse = z.object({
  amountCents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  service: z.string().min(1),
});

export interface RateRequest {
  country: string;
  postcode: string;
  itemCount: number;
}

export type RateSource = 'live' | 'cache' | 'default';

export interface ShippingQuote {
  amountCents: number;
  currency: string;
  service: string;
  source: RateSource;
  /** Set when the quote is a fallback: the error that made us fall back. */
  degradedReason?: string;
}

interface CacheEntry {
  quote: Omit<ShippingQuote, 'source'>;
  storedAt: number;
}

/**
 * Shipping rates are not worth failing a checkout over. On any dependency failure the client
 * serves the last good quote for the same destination (within the TTL), else a configured
 * default. A short timeout and few retries keep the degraded path fast.
 */
export class ShippingClient {
  readonly breaker: CircuitBreaker;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly config: AppConfig['shipping'],
    private readonly retryDeps: RetryDeps = {},
    private readonly now: () => number = Date.now,
    breaker?: CircuitBreaker,
  ) {
    this.breaker = breaker ?? new CircuitBreaker(DEPENDENCY, config.breaker, now);
  }

  async quote(req: RateRequest): Promise<ShippingQuote> {
    const key = `${req.country}:${req.postcode}`;
    try {
      const url = new URL(`${this.config.baseUrl}/v1/rates`);
      url.searchParams.set('country', req.country);
      url.searchParams.set('postcode', req.postcode);
      url.searchParams.set('items', String(req.itemCount));
      const body = await withRetry(
        () =>
          this.breaker.execute(() =>
            requestJson(
              {
                dependency: DEPENDENCY,
                method: 'GET',
                url: url.toString(),
                timeoutMs: this.config.timeoutMs,
              },
              RateResponse,
            ),
          ),
        this.config.retry,
        this.retryDeps,
      );
      this.cache.set(key, { quote: body, storedAt: this.now() });
      return { ...body, source: 'live' };
    } catch (error) {
      if (!(error instanceof DependencyError)) throw error;
      return this.fallback(key, error);
    }
  }

  private fallback(key: string, error: DependencyError): ShippingQuote {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.storedAt <= this.config.cacheTtlMs) {
      return { ...cached.quote, source: 'cache', degradedReason: error.name };
    }
    return {
      amountCents: this.config.defaultRateCents,
      currency: 'AUD',
      service: 'standard',
      source: 'default',
      degradedReason: error.name,
    };
  }
}
