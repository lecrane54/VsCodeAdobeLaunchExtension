/**
 * Turn API failures into something a person can act on.
 *
 * Reactor and IMS both answer with accurate, unreadable machinery: a JSON:API
 * error array, or an OAuth error code. Left alone they reach the user as a wall
 * of JSON in a modal. Almost every failure a new user hits is one of a handful
 * of setup mistakes, so name the mistake and point at the fix — and keep the
 * raw text for the output channel, where it belongs.
 *
 * Pure module: no `vscode` import, so it can be unit-tested directly.
 */

import { ReactorError } from './client';
import { IMSError } from '../auth/ims';
import { RequestTimeoutError } from '../util/http';
import { PlatformApiError } from '../platform/client';

/** A button the notification can offer. */
export type ErrorAction = 'signIn' | 'guide' | 'settings' | 'details';

export interface ErrorExplanation {
  /** One sentence: what went wrong. */
  message: string;
  /** What to do about it. */
  hint?: string;
  /** Buttons, most useful first. */
  actions: ErrorAction[];
  /** The raw text, for the output channel. */
  detail: string;
}

const CONSOLE = 'Adobe Developer Console';

export function explainError(err: unknown): ErrorExplanation {
  if (err instanceof IMSError) return explainIMS(err);
  if (err instanceof ReactorError) return explainReactor(err);
  if (err instanceof PlatformApiError) return explainPlatform(err);
  return explainTransport(err);
}

/** Credential-time failures: wrong secret, missing API, ungranted scopes. */
function explainIMS(err: IMSError): ErrorExplanation {
  const detail = err.message;
  const code = (err.code ?? '').toLowerCase();
  if (code === 'invalid_client' || err.status === 401) {
    return {
      message: 'Adobe rejected these credentials.',
      hint:
        `Check the Client ID and Client Secret in ${CONSOLE} → your project → ` +
        'OAuth Server-to-Server. Secrets can be rotated, so an old one stops working.',
      actions: ['signIn', 'guide', 'details'],
      detail,
    };
  }
  if (code === 'invalid_scope') {
    return {
      message: "The credential isn't granted the scopes this extension asks for.",
      hint:
        `In ${CONSOLE}, confirm the project has the Adobe Launch / Data Collection API ` +
        'added. If you customized `adobeLaunch.scopes`, reset it to the default.',
      actions: ['settings', 'guide', 'details'],
      detail,
    };
  }
  if (code === 'access_denied' || err.status === 403) {
    return {
      message: 'Adobe accepted the credentials but denied the token.',
      hint:
        `In ${CONSOLE}, add this project's credential to a product profile that ` +
        'includes Launch / Tags access.',
      actions: ['guide', 'details'],
      detail,
    };
  }
  return {
    message: `Could not get an Adobe token (HTTP ${err.status}).`,
    hint: err.description ?? undefined,
    actions: ['signIn', 'guide', 'details'],
    detail,
  };
}

/** Request-time failures against the Reactor API. */
function explainReactor(err: ReactorError): ErrorExplanation {
  const detail = formatJsonApiErrors(err.body) ?? err.message;
  switch (err.status) {
    case 401:
      return {
        message: 'Adobe rejected the access token.',
        hint: 'Sign in again — the credential may have been rotated or revoked.',
        actions: ['signIn', 'details'],
        detail,
      };
    case 403:
      return {
        message: "Signed in, but this credential can't access that resource.",
        hint:
          `In ${CONSOLE}, add the credential to a product profile with Launch / Tags ` +
          'access — read-only profiles can list properties but not write to them.',
        actions: ['guide', 'details'],
        detail,
      };
    case 404:
      return {
        message: 'Reactor has no such resource.',
        hint:
          'It may have been deleted in the Launch UI, or the active property id may ' +
          'be wrong. Re-pick the property and pull fresh.',
        actions: ['settings', 'details'],
        detail,
      };
    case 400:
    case 422:
      return {
        message: 'Reactor rejected the change as invalid.',
        hint: detail,
        actions: ['details'],
        detail,
      };
    case 429:
      return {
        message: 'Reactor is throttling this credential.',
        hint:
          'Retries were already exhausted. Wait a moment and try again, or lower ' +
          '`adobeLaunch.pullConcurrency`.',
        actions: ['settings', 'details'],
        detail,
      };
    default:
      if (err.status >= 500) {
        return {
          message: `Reactor returned a server error (HTTP ${err.status}).`,
          hint: "Adobe's side, not yours — retries were already exhausted. Try again shortly.",
          actions: ['details'],
          detail,
        };
      }
      return {
        message: `Reactor API error ${err.status}.`,
        hint: detail,
        actions: ['details'],
        detail,
      };
  }
}

/** Request-time failures against Experience Platform or CJA. */
function explainPlatform(err: PlatformApiError): ErrorExplanation {
  const detail = err.message;
  const product = err.service === 'cja' ? 'Customer Journey Analytics' : 'Experience Platform';
  switch (err.status) {
    case 401:
      return {
        message: `${product} rejected the access token.`,
        hint: 'Sign in again — the credential may have been rotated or revoked.',
        actions: ['signIn', 'details'],
        detail,
      };
    case 403:
      return {
        message: `This credential isn't allowed to read ${product}.`,
        hint:
          `In ${CONSOLE}, add the ${product} API to the project, then add the ` +
          `credential to a ${product} product profile.`,
        actions: ['guide', 'details'],
        detail,
      };
    case 429:
      return {
        message: `${product} is throttling this credential.`,
        hint:
          'Retries were already exhausted. Wait a moment and try again, or lower ' +
          '`adobeLaunch.pullConcurrency`.',
        actions: ['settings', 'details'],
        detail,
      };
    default:
      if (err.status >= 500) {
        return {
          message: `${product} returned a server error (HTTP ${err.status}).`,
          hint: "Adobe's side, not yours — retries were already exhausted. Try again shortly.",
          actions: ['details'],
          detail,
        };
      }
      return {
        message: `${product} API error ${err.status}.`,
        hint: detail,
        actions: ['details'],
        detail,
      };
  }
}

/** Never reached Adobe: offline, DNS, TLS, corporate proxy. */
function explainTransport(err: unknown): ErrorExplanation {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const text = err instanceof Error ? err.message : String(err);
  const code: string = (err as { code?: string } | undefined)?.code ?? '';

  // A connection that opened and then went quiet. Distinct from "unreachable":
  // the host answered, so DNS and TLS are fine and the advice is different.
  if (err instanceof RequestTimeoutError) {
    return {
      message: `Adobe didn't answer within ${Math.round(err.timeoutMs / 1000)}s.`,
      hint:
        'The request was cancelled rather than left hanging. A VPN or corporate ' +
        'proxy is the usual cause; if Adobe is merely slow, raise ' +
        '`adobeLaunch.requestTimeoutSeconds`.',
      actions: ['settings', 'details'],
      detail,
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed/i.test(code + text)) {
    return {
      message: "Couldn't reach Adobe.",
      hint:
        'Check your network. On a corporate network this is usually a proxy or VPN ' +
        'blocking the Adobe API hosts (reactor.adobe.io, platform.adobe.io, cja.adobe.io) or ims-na1.adobelogin.com.',
      actions: ['details'],
      detail,
    };
  }
  return { message: text || 'Unexpected error.', actions: ['details'], detail };
}

/**
 * Flatten a JSON:API error document into readable lines.
 * `{errors:[{title,detail,source:{pointer}}]}` → `title: detail (pointer)`.
 */
export function formatJsonApiErrors(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;
  const lines = errors
    .map((e) => {
      const item = e as { title?: unknown; detail?: unknown; source?: { pointer?: unknown } };
      const head = [item.title, item.detail]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .join(': ');
      const pointer = typeof item.source?.pointer === 'string' ? ` (${item.source.pointer})` : '';
      return head ? head + pointer : '';
    })
    .filter(Boolean);
  return lines.length ? lines.join('\n') : undefined;
}

/** The notification text: summary plus hint. */
export function errorText(explanation: ErrorExplanation): string {
  return explanation.hint ? `${explanation.message} ${explanation.hint}` : explanation.message;
}
