import { z } from 'zod';

const int = (fallback: number) => z.coerce.number().int().nonnegative().default(fallback);

const EnvSchema = z.object({
  PORT: int(3000),
  DATABASE_URL: z.string().min(1),
  PAYMENT_BASE_URL: z.url(),
  PAYMENT_API_KEY: z.string().min(1).default('test-key'),
  PAYMENT_TIMEOUT_MS: int(2000),
  PAYMENT_MAX_RETRIES: int(2),
  SHIPPING_BASE_URL: z.url(),
  SHIPPING_TIMEOUT_MS: int(800),
  SHIPPING_MAX_RETRIES: int(1),
  RETRY_BASE_DELAY_MS: int(100),
  RETRY_MAX_DELAY_MS: int(2000),
  RETRY_AFTER_MAX_MS: int(5000),
  BREAKER_FAILURE_THRESHOLD: int(5),
  BREAKER_RESET_TIMEOUT_MS: int(10_000),
  SHIPPING_CACHE_TTL_MS: int(15 * 60_000),
  SHIPPING_DEFAULT_RATE_CENTS: int(1500),
});

export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryAfterMaxMs: number;
}

export interface BreakerConfig {
  failureThreshold: number;
  resetTimeoutMs: number;
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  payment: {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    retry: RetryConfig;
    breaker: BreakerConfig;
  };
  shipping: {
    baseUrl: string;
    timeoutMs: number;
    retry: RetryConfig;
    breaker: BreakerConfig;
    cacheTtlMs: number;
    defaultRateCents: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = EnvSchema.parse(env);
  const retry = (maxRetries: number): RetryConfig => ({
    maxRetries,
    baseDelayMs: e.RETRY_BASE_DELAY_MS,
    maxDelayMs: e.RETRY_MAX_DELAY_MS,
    retryAfterMaxMs: e.RETRY_AFTER_MAX_MS,
  });
  const breaker: BreakerConfig = {
    failureThreshold: e.BREAKER_FAILURE_THRESHOLD,
    resetTimeoutMs: e.BREAKER_RESET_TIMEOUT_MS,
  };
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    payment: {
      baseUrl: e.PAYMENT_BASE_URL,
      apiKey: e.PAYMENT_API_KEY,
      timeoutMs: e.PAYMENT_TIMEOUT_MS,
      retry: retry(e.PAYMENT_MAX_RETRIES),
      breaker,
    },
    shipping: {
      baseUrl: e.SHIPPING_BASE_URL,
      timeoutMs: e.SHIPPING_TIMEOUT_MS,
      retry: retry(e.SHIPPING_MAX_RETRIES),
      breaker,
      cacheTtlMs: e.SHIPPING_CACHE_TTL_MS,
      defaultRateCents: e.SHIPPING_DEFAULT_RATE_CENTS,
    },
  };
}
