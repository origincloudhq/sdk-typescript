import type { ClientBase as Client } from "./client.js";
import { OriginCloudError, errorFromResponse } from "./errors.js";

/** The header that carries the consistency token, in responses and in requests. */
export const CONSISTENCY_TOKEN_HEADER = "Origin-Consistency-Token";

const FIRST_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 10_000;

/** What every method takes besides its request. */
export interface CallOptions {
  /** Stops the call, and its retries, when aborted. */
  signal?: AbortSignal;
}

/** The HTTP methods the APIs' bindings use. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One call of a service's method, as its HTTP binding sends it. Generated clients build it. */
export interface Request {
  method: HttpMethod;
  /** The escaped path, from the root. */
  path: string;
  query?: URLSearchParams;
  /** Sent as JSON when not undefined. */
  body?: unknown;
  /**
   * Whether sending the call twice has the effect of sending it once: a
   * read, or a mutation with a request id. Only an idempotent call is
   * retried.
   */
  idempotent?: boolean;
}

/** A call that got no answer: the connection failed or broke off. */
class TransportError extends Error {
  constructor(cause: unknown) {
    super(`origincloud: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "TransportError";
  }
}

/** The endpoint of one service, which its generated client sends calls to. */
export class Service {
  /** The client the service's calls go through. */
  readonly client: Client;
  /** The base URL, without a trailing slash. */
  readonly base: string;

  constructor(client: Client, base: string) {
    this.client = client;
    this.base = base.replace(/\/+$/, "");
  }

  /**
   * Sends `request`, retrying it while that is safe and the answer allows
   * it, and returns the answer's JSON.
   */
  async call<T>(request: Request, options: CallOptions = {}): Promise<T> {
    const body = request.body === undefined ? undefined : JSON.stringify(request.body);
    const { signal } = options;
    for (let attempt = 1; ; attempt++) {
      try {
        return (await this.send(request, body, signal)) as T;
      } catch (err) {
        if (signal?.aborted) throw signal.reason;
        if (!request.idempotent || attempt >= this.client.maxAttempts) throw err;
        const delay = retryDelay(err, attempt);
        if (delay === undefined) throw err;
        try {
          await sleep(delay, signal);
        } catch {
          throw signal?.reason ?? err;
        }
      }
    }
  }

  /** One attempt, answering with the JSON of a 200. */
  private async send(request: Request, body: string | undefined, signal: AbortSignal | undefined): Promise<unknown> {
    let url = this.base + request.path;
    const query = request.query?.toString();
    if (query) url += "?" + query;

    const token = await this.client.credentials.token(signal);
    const headers: Record<string, string> = {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    };
    if (this.client.userAgent) headers["User-Agent"] = this.client.userAgent;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const held = this.client.consistencyToken;
    if (held) headers[CONSISTENCY_TOKEN_HEADER] = held;

    const init: RequestInit = { method: request.method, headers };
    if (body !== undefined) init.body = body;
    if (signal) init.signal = signal;

    let response: Response;
    let answer: string;
    try {
      const fetchImpl = this.client.fetch;
      // Called on globalThis, so that an unbound `window.fetch` works too.
      response = await (fetchImpl ?? globalThis.fetch).call(globalThis, url, init);
    } catch (err) {
      throw new TransportError(err);
    }
    // A failed mutation may still have applied a command: its token comes
    // back either way.
    const answered = response.headers.get(CONSISTENCY_TOKEN_HEADER);
    if (answered) this.client.consistencyToken = answered;
    try {
      answer = await response.text();
    } catch (err) {
      throw new TransportError(err);
    }
    if (response.status !== 200) {
      throw errorFromResponse(response.status, answer);
    }
    if (answer.trim() === "") return {};
    try {
      return JSON.parse(answer);
    } catch (err) {
      throw new Error(`origincloud: reading the response to ${request.method} ${request.path}: ${String(err)}`, {
        cause: err,
      });
    }
  }
}

/**
 * Whether `err` may go away if the call is sent again, and how long to
 * wait before attempt + 1: what the answer asks for, or a jittered delay
 * that doubles with each attempt. `undefined` when it won't go away.
 */
function retryDelay(err: unknown, attempt: number): number | undefined {
  let asked = 0;
  if (err instanceof OriginCloudError) {
    if (!err.retryable) return undefined;
    asked = err.retryDelayMs;
  } else if (!(err instanceof TransportError)) {
    return undefined;
  }
  let backoff = FIRST_RETRY_DELAY_MS * 2 ** (attempt - 1);
  if (!(backoff <= MAX_RETRY_DELAY_MS)) backoff = MAX_RETRY_DELAY_MS;
  backoff = backoff / 2 + Math.random() * (backoff / 2);
  return Math.max(asked, backoff);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The fields of `message` as query parameters, by their JSON paths,
 * leaving out the fields named by `skip` and fields at their default
 * value. A generated client sends the fields its method's path and body
 * don't carry this way.
 */
export function query(message: object, skip: readonly string[] = []): URLSearchParams {
  const params = new URLSearchParams();
  flatten(params, "", JSON.parse(JSON.stringify(message)) as Record<string, unknown>, skip);
  params.sort();
  return params;
}

function flatten(params: URLSearchParams, prefix: string, fields: Record<string, unknown>, skip: readonly string[]): void {
  for (const [name, value] of Object.entries(fields)) {
    const path = prefix + name;
    if (skip.includes(path)) continue;
    if (Array.isArray(value)) {
      for (const element of value) params.append(path, queryScalar(path, element));
    } else if (typeof value === "object" && value !== null) {
      flatten(params, path + ".", value as Record<string, unknown>, skip);
    } else if (value !== null && value !== "" && value !== 0 && value !== false) {
      params.set(path, queryScalar(path, value));
    }
  }
}

function queryScalar(path: string, value: unknown): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
      return String(value);
    default:
      throw new Error(`origincloud: ${path} can't be sent as a query parameter`);
  }
}

/**
 * `value` as the path segments of a request, checking it has the form
 * `pattern` gives it: the same segments, where a `*` in the pattern
 * stands for any one non-empty segment. `field` names it in the error.
 */
export function pathValue(field: string, value: string | undefined, pattern: string): string {
  const got = (value ?? "").split("/");
  const want = pattern.split("/");
  const valid =
    got.length === want.length && want.every((segment, i) => (segment === "*" ? got[i] !== "" : got[i] === segment));
  if (!valid) {
    throw new Error(`origincloud: ${field} must have the form ${pattern}, got ${JSON.stringify(value ?? "")}`);
  }
  return got.map(encodeURIComponent).join("/");
}

/** A new random request id, a UUID, for a mutation whose caller left its request id empty. */
export function newRequestId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID exists only in secure contexts; a page served over plain
  // HTTP still has getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
