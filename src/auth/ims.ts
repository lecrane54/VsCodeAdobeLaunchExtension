/** Adobe IMS OAuth Server-to-Server token fetch + cache. */

import { DEFAULT_TIMEOUT_MS, RequestTimeoutError, deadline } from '../util/http';

const IMS_HOST = 'ims-na1.adobelogin.com';

/**
 * A rejected token request, with IMS's own structured fields kept separate so
 * callers can explain the failure instead of dumping a status code at the user.
 */
export class IMSError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly description?: string
  ) {
    super(
      `IMS token request failed (HTTP ${status})` +
        ([code, description].filter(Boolean).join(' ') ? `: ${[code, description].filter(Boolean).join(' ')}` : '')
    );
  }
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

export class IMSAuth {
  private cached?: { accessToken: string; expiresAt: number };
  readonly clientId: string;

  constructor(
    clientId: string,
    private readonly clientSecret: string,
    private readonly scopes: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS
  ) {
    this.clientId = clientId;
  }

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.accessToken;
    }
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      scope: this.scopes,
    });
    // Bounded, so a stalled token request fails the sign-in with a reason
    // instead of leaving the panel verifying forever.
    const dl = deadline(this.timeoutMs);
    let json: TokenResponse;
    try {
      const resp = await fetch(`https://${IMS_HOST}/ims/token/v3`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: dl.signal,
      });
      if (!resp.ok) {
        // Never echo the raw body — it can carry request context into logs.
        // Surface only IMS's structured error fields, which name the failure
        // without exposing the credential.
        const { code, description } = await imsErrorFields(resp);
        throw new IMSError(resp.status, code, description);
      }
      json = (await resp.json()) as TokenResponse;
    } catch (err) {
      if (dl.aborted()) throw new RequestTimeoutError(`Adobe sign-in (${IMS_HOST})`, this.timeoutMs);
      throw err;
    } finally {
      dl.done();
    }
    const expiresIn = (json.expires_in ?? 3600) * 1000;
    this.cached = { accessToken: json.access_token, expiresAt: now + expiresIn };
    return this.cached.accessToken;
  }
}

/** The safe subset of a failed token response — IMS error fields only, no raw body. */
async function imsErrorFields(resp: Response): Promise<{ code?: string; description?: string }> {
  try {
    const data = (await resp.json()) as { error?: unknown; error_description?: unknown };
    return {
      code: typeof data.error === 'string' && data.error ? data.error : undefined,
      description:
        typeof data.error_description === 'string' && data.error_description
          ? data.error_description
          : undefined,
    };
  } catch {
    return {};
  }
}
