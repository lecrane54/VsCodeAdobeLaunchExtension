/** Thin async client for the Adobe Reactor (Launch) API. */

import { DEFAULT_TIMEOUT_MS, RequestTimeoutError, deadline } from '../util/http';

const REACTOR_HOST = 'reactor.adobe.io';
const ACCEPT = 'application/vnd.api+json;revision=1';
// Reactor 415s POST when Content-Type includes ;revision=1 (Accept-only quirk).
const CONTENT_TYPE = 'application/vnd.api+json';

/** Retry budget for throttled / transient failures. */
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 10_000;
/** Transient server-side statuses worth a second try. */
const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504]);

/** Anything that can mint a bearer token for a client id. */
export interface TokenSource {
  readonly clientId: string;
  accessToken(): Promise<string>;
}

export interface ReactorClientOptions {
  /** Ceiling for one request, including reading its body. */
  timeoutMs?: number;
  /** Where retry notices go (the output channel, usually). */
  log?: (message: string) => void;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export class ReactorError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown
  ) {
    super(`Reactor API error ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
}

export class ReactorClient {
  constructor(
    private readonly auth: TokenSource,
    private readonly opts: ReactorClientOptions = {}
  ) {}

  async request<T = unknown>(
    method: Method,
    path: string,
    opts: { query?: Record<string, string | number>; body?: unknown } = {}
  ): Promise<T | null> {
    const url = new URL(`https://${REACTOR_HOST}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));
    }
    let bodyStr: string | undefined;
    if (opts.body !== undefined) bodyStr = JSON.stringify(opts.body);

    for (let attempt = 1; ; attempt++) {
      const token = await this.auth.accessToken();
      const headers: Record<string, string> = {
        Accept: ACCEPT,
        Authorization: `Bearer ${token}`,
        'X-Api-Key': this.auth.clientId,
      };
      if (bodyStr !== undefined) headers['Content-Type'] = CONTENT_TYPE;

      // One deadline covers the request and the reading of its body: headers
      // that arrive over a stalled connection are not yet a response.
      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const dl = deadline(timeoutMs);
      let resp: Response;
      let text: string;
      try {
        resp = await fetch(url, { method, headers, body: bodyStr, signal: dl.signal });
        if (!resp.ok && attempt < MAX_ATTEMPTS && isReplayable(method, resp.status)) {
          await this.backoff(method, path, attempt, resp, `HTTP ${resp.status}`);
          continue;
        }
        text = await resp.text();
      } catch (err) {
        // A timeout and a dropped connection carry the same risk: the request
        // may or may not have reached Reactor, so only replay when replaying is
        // harmless. A POST that timed out fails here rather than duplicating.
        const failure = dl.aborted()
          ? new RequestTimeoutError(`Reactor ${method} ${path}`, timeoutMs)
          : (err as Error);
        if (attempt < MAX_ATTEMPTS && isReplayable(method, 0)) {
          await this.backoff(method, path, attempt, undefined, failure.message);
          continue;
        }
        throw failure;
      } finally {
        dl.done();
      }
      const parsed = text ? safeJson(text) : null;
      if (!resp.ok) {
        throw new ReactorError(resp.status, parsed ?? text ?? resp.statusText);
      }
      return parsed as T | null;
    }
  }

  private async backoff(
    method: string,
    path: string,
    attempt: number,
    resp: Response | undefined,
    why: string
  ): Promise<void> {
    const delay = retryDelayMs(resp, attempt);
    this.opts.log?.(
      `Reactor ${method} ${path}: ${why} — retrying in ${Math.round(delay / 100) / 10}s ` +
        `(attempt ${attempt + 1}/${MAX_ATTEMPTS})`
    );
    await sleep(delay);
  }

  get<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T | null> {
    return this.request<T>('GET', path, { query });
  }

  post<T = unknown>(path: string, body?: unknown): Promise<T | null> {
    return this.request<T>('POST', path, { body });
  }

  patch<T = unknown>(path: string, body?: unknown): Promise<T | null> {
    return this.request<T>('PATCH', path, { body });
  }

  delete<T = unknown>(path: string, body?: unknown): Promise<T | null> {
    return this.request<T>('DELETE', path, { body });
  }

  /** Fetch every page of a JSON:API collection. */
  async paged<T = any>(path: string): Promise<T[]> {
    const out: T[] = [];
    let page = 1;
    while (true) {
      const resp = (await this.get(path, {
        'page[number]': page,
        'page[size]': 100,
      })) as { data?: T[]; meta?: { pagination?: { total_pages?: number } } };
      out.push(...(resp.data ?? []));
      const total = resp.meta?.pagination?.total_pages ?? 1;
      if (page >= total) break;
      page++;
    }
    return out;
  }
}

/**
 * Whether this failure can be retried without risking a duplicate write.
 *
 * A 429 is safe for every method — Reactor rejected the call before applying it.
 * Anything else (a 5xx, a dropped connection, a timeout) may or may not have
 * landed, so we only replay reads. Replaying a POST could create a second rule;
 * replaying the `revise` PATCH could mint a second revision.
 */
export function isReplayable(method: string, status: number): boolean {
  if (status === 429) return true;
  const idempotent = method === 'GET';
  return idempotent && (status === 0 || TRANSIENT_STATUS.has(status));
}

/** Honor Retry-After when Reactor sends one; otherwise exponential backoff with jitter. */
export function retryDelayMs(resp: Response | undefined, attempt: number): number {
  const header = resp?.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now(); // Retry-After may be an HTTP date
    // Take the server at its word, including "0" (go now) and dates already past.
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), MAX_DELAY_MS);
  }
  const expo = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return expo * (0.5 + Math.random() / 2); // jitter, so parallel pulls don't sync up
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
