import type { z } from 'zod';
import { HttpStatusError, MalformedResponseError, NetworkError, TimeoutError } from './errors.js';
import { parseRetryAfter } from './retry.js';

export interface JsonRequest {
  dependency: string;
  method: 'GET' | 'POST';
  url: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/**
 * One HTTP attempt: fetch with a hard timeout, then map every way it can go wrong onto the
 * DependencyError taxonomy. A 2xx body is validated against `schema` so a contract drift shows
 * up as MalformedResponseError instead of an undefined field three layers later.
 */
export async function requestJson<S extends z.ZodType>(
  req: JsonRequest,
  schema: S,
): Promise<z.infer<S>> {
  let response: Response;
  let text: string;
  const signal = AbortSignal.timeout(req.timeoutMs);
  try {
    response = await fetch(req.url, {
      method: req.method,
      headers: {
        accept: 'application/json',
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { body: JSON.stringify(req.body) }),
      signal,
    });
    // The timeout covers the body too: a server that sends headers then stalls is still slow.
    text = await response.text();
  } catch (error) {
    if (signal.aborted) throw new TimeoutError(req.dependency, req.timeoutMs);
    throw new NetworkError(req.dependency, describeNetworkError(error), { cause: error });
  }

  const parsed = parseJson(text);
  if (!response.ok) {
    throw new HttpStatusError(
      req.dependency,
      response.status,
      parseRetryAfter(response.headers.get('retry-after')),
      parsed.ok ? parsed.value : text,
    );
  }
  if (!parsed.ok) {
    throw new MalformedResponseError(req.dependency, `response is not JSON (${text.length} bytes)`);
  }
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    throw new MalformedResponseError(
      req.dependency,
      `response does not match contract: ${result.error.issues.map((i) => i.path.join('.') || '(root)').join(', ')}`,
    );
  }
  return result.data;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { code?: string; message?: string } | undefined;
    return cause?.code ?? cause?.message ?? error.message;
  }
  return String(error);
}
