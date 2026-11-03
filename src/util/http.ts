/**
 * Deadlines for outbound HTTP.
 *
 * Node's `fetch` has no request timeout: a socket that connects and then goes
 * quiet — a VPN dropping mid-request, a proxy holding the connection open —
 * leaves the promise pending forever. In an extension that surfaces as a
 * command that never finishes: the sign-in button stays on "Verifying with
 * Adobe…", the pull notification spins, and there is nothing to click. A
 * deadline turns that silence into an error the user can read and act on.
 *
 * Pure module: no `vscode` import, so it can be unit-tested directly.
 */

/** Default ceiling for a single request, in ms. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** A request that never came back inside its deadline. */
export class RequestTimeoutError extends Error {
  /** Matches the transport codes `explainError` already recognizes. */
  readonly code = 'ETIMEDOUT';

  constructor(
    /** What was being called, for the message — e.g. `GET /properties/PR1`. */
    readonly target: string,
    readonly timeoutMs: number
  ) {
    super(`${target} timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'RequestTimeoutError';
  }
}

export interface Deadline {
  /** Pass to `fetch` — aborts the request, and its body read, when time runs out. */
  readonly signal: AbortSignal;
  /** True once the deadline fired, to tell a timeout from a real transport error. */
  aborted(): boolean;
  /** Always call in a `finally`; releases the timer. */
  done(): void;
}

/**
 * Start a deadline covering one request *and* the reading of its body — a
 * response whose headers arrive but whose body stalls hangs just as hard.
 */
export function deadline(timeoutMs: number = DEFAULT_TIMEOUT_MS): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never let a pending deadline hold the process open.
  timer.unref?.();
  return {
    signal: controller.signal,
    aborted: () => controller.signal.aborted,
    done: () => clearTimeout(timer),
  };
}
