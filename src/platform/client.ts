/**
 * Read-only client for the Experience Platform and Customer Journey Analytics
 * APIs. Same IMS credential as Reactor; these hosts additionally want the IMS
 * org in `x-gw-ims-org-id`, and Platform wants a sandbox in `x-sandbox-name`.
 *
 * GET only — the platform mirror is a snapshot, never pushed — so every
 * failure worth retrying is safe to retry.
 */

import { IMSAuth } from '../auth/ims';
import { isReplayable, retryDelayMs, safeJson, sleep } from '../reactor/client';
import { DEFAULT_TIMEOUT_MS, RequestTimeoutError, deadline } from '../util/http';

export const PLATFORM_HOST = 'platform.adobe.io';
export const CJA_HOST = 'cja.adobe.io';

const MAX_ATTEMPTS = 4;

/** Which product answered — the fix for a 403 differs between them. */
export type PlatformService = 'aep' | 'cja';

export class PlatformApiError extends Error {
  constructor(
    readonly service: PlatformService,
    readonly status: number,
    readonly path: string,
    readonly body: unknown
  ) {
    super(
      `${service === 'cja' ? 'CJA' : 'Platform'} API error ${status} on ${path}: ` +
        (typeof body === 'string' ? body : JSON.stringify(body))
    );
  }
}

export interface PlatformClientOptions {
  /** Optional sink for retry/backoff notices — wired to the extension's output channel. */
  log?: (message: string) => void;
  /** Ceiling for a single request, in ms. */
  timeoutMs?: number;
}

export class PlatformClient {
  constructor(
    private readonly auth: IMSAuth,
    readonly orgId: string,
    private readonly opts: PlatformClientOptions = {}
  ) {}

  /** A Platform (AEP) GET, scoped to one sandbox — `null` for org-level endpoints. */
  aep<T = unknown>(
    sandbox: string | null,
    path: string,
    opts: { query?: Record<string, string | number>; accept?: string } = {}
  ): Promise<T> {
    return this.get<T>('aep', PLATFORM_HOST, path, {
      ...opts,
      headers: sandbox ? { 'x-sandbox-name': sandbox } : {},
    });
  }

  /** A Customer Journey Analytics GET. */
  cja<T = unknown>(path: string, query?: Record<string, string | number>): Promise<T> {
    return this.get<T>('cja', CJA_HOST, path, { query });
  }

  private async get<T>(
    service: PlatformService,
    host: string,
    path: string,
    opts: {
      query?: Record<string, string | number>;
      accept?: string;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    const url = new URL(`https://${host}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, String(v));
    }
    const label = `${service === 'cja' ? 'CJA' : 'Platform'} GET ${path}`;

    for (let attempt = 1; ; attempt++) {
      const token = await this.auth.accessToken();
      const headers: Record<string, string> = {
        Accept: opts.accept ?? 'application/json',
        Authorization: `Bearer ${token}`,
        'x-api-key': this.auth.clientId,
        'x-gw-ims-org-id': this.orgId,
        ...opts.headers,
      };

      const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const dl = deadline(timeoutMs);
      let resp: Response;
      let text: string;
      try {
        resp = await fetch(url, { method: 'GET', headers, signal: dl.signal });
        if (!resp.ok && attempt < MAX_ATTEMPTS && isReplayable('GET', resp.status)) {
          await this.backoff(label, attempt, resp, `HTTP ${resp.status}`);
          continue;
        }
        text = await resp.text();
      } catch (err) {
        const failure = dl.aborted()
          ? new RequestTimeoutError(label, timeoutMs)
          : (err as Error);
        if (attempt < MAX_ATTEMPTS) {
          await this.backoff(label, attempt, undefined, failure.message);
          continue;
        }
        throw failure;
      } finally {
        dl.done();
      }

      const parsed = text ? safeJson(text) : null;
      if (!resp.ok) {
        throw new PlatformApiError(service, resp.status, path, parsed ?? text ?? resp.statusText);
      }
      return parsed as T;
    }
  }

  private async backoff(
    label: string,
    attempt: number,
    resp: Response | undefined,
    why: string
  ): Promise<void> {
    const delay = retryDelayMs(resp, attempt);
    this.opts.log?.(
      `${label}: ${why} — retrying in ${Math.round(delay / 100) / 10}s ` +
        `(attempt ${attempt + 1}/${MAX_ATTEMPTS})`
    );
    await sleep(delay);
  }
}
