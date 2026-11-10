import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export const WIREMOCK_IMAGE = 'wiremock/wiremock:3.13.2';

/** Subset of the WireMock request pattern JSON that these tests use. */
export interface RequestPattern {
  method?: 'GET' | 'POST' | 'ANY';
  url?: string;
  urlPath?: string;
  urlPathPattern?: string;
  headers?: Record<string, { equalTo?: string; matches?: string; absent?: boolean }>;
  queryParameters?: Record<string, { equalTo?: string }>;
  bodyPatterns?: Array<Record<string, unknown>>;
}

export type Fault =
  | 'CONNECTION_RESET_BY_PEER'
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_RESPONSE_CHUNK'
  | 'RANDOM_DATA_THEN_CLOSE';

export interface ResponseDefinition {
  status?: number;
  headers?: Record<string, string>;
  jsonBody?: unknown;
  body?: string;
  fixedDelayMilliseconds?: number;
  fault?: Fault;
  transformers?: string[];
}

export interface StubMapping {
  request: RequestPattern;
  response: ResponseDefinition;
  priority?: number;
  scenarioName?: string;
  requiredScenarioState?: string;
  newScenarioState?: string;
}

export interface LoggedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** Thin typed client for the WireMock admin API (https://wiremock.org/docs/standalone/admin-api-reference/). */
export class WireMockAdmin {
  constructor(readonly baseUrl: string) {}

  async stub(mapping: StubMapping): Promise<void> {
    await this.post('/__admin/mappings', mapping);
  }

  /** Removes all stubs, clears the request journal and resets every scenario to "Started". */
  async reset(): Promise<void> {
    await this.post('/__admin/reset', {});
  }

  async count(pattern: RequestPattern): Promise<number> {
    const res = (await this.post('/__admin/requests/count', pattern)) as { count: number };
    return res.count;
  }

  async find(pattern: RequestPattern): Promise<LoggedRequest[]> {
    const res = (await this.post('/__admin/requests/find', pattern)) as {
      requests: LoggedRequest[];
    };
    return res.requests;
  }

  /** Requests that matched no stub: a non-empty list means the client sent something unexpected. */
  async unmatched(): Promise<LoggedRequest[]> {
    const res = await fetch(`${this.baseUrl}/__admin/requests/unmatched`);
    const json = (await res.json()) as { requests: LoggedRequest[] };
    return json.requests;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`WireMock admin ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as unknown) : undefined;
  }
}

/** Case-insensitive header lookup on a journal entry. */
export function header(request: LoggedRequest, name: string): string | undefined {
  const entry = Object.entries(request.headers).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

export interface StartedWireMock {
  container: StartedTestContainer;
  baseUrl: string;
  admin: WireMockAdmin;
}

export async function startWireMock(): Promise<StartedWireMock> {
  const container = await new GenericContainer(WIREMOCK_IMAGE)
    .withExposedPorts(8080)
    .withCommand(['--disable-banner'])
    .withWaitStrategy(Wait.forHttp('/__admin/health', 8080).forStatusCode(200))
    .start();
  const baseUrl = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  const admin = new WireMockAdmin(baseUrl);
  await warmUp(admin);
  return { container, baseUrl, admin };
}

/**
 * A cold JVM can take over a second to serve its first stubbed request, which is enough to
 * trip a client timeout and add an unexpected retry to an exact-count assertion. Exercise the
 * matchers the tests use (headers, equalToJson, JSONPath, query) a few times, then wipe the
 * journal so tests start from zero.
 */
async function warmUp(admin: WireMockAdmin): Promise<void> {
  await admin.stub({
    request: {
      method: 'POST',
      urlPath: '/__warmup',
      headers: { 'X-Warmup': { equalTo: 'yes' } },
      queryParameters: { n: { equalTo: '1' } },
      bodyPatterns: [{ equalToJson: { a: 1 } }, { matchesJsonPath: '$[?(@.a == 1)]' }],
    },
    response: { status: 200, jsonBody: { ok: true } },
  });
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${admin.baseUrl}/__warmup?n=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-warmup': 'yes' },
      body: '{"a":1}',
    });
    await res.text();
  }
  await admin.reset();
}
