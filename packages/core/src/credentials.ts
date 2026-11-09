/**
 * The identity provider's token endpoint, where service account
 * credentials and the CLI's session are exchanged for access tokens.
 */
export const TOKEN_URL = "https://auth.origincloud.eu/realms/origincloud/protocol/openid-connect/token";

/** How long before its expiry a token is replaced, so that it doesn't expire on the way. */
const EXPIRY_MARGIN_MS = 30_000;

/** How much of a token response is read: one is small, and more than this isn't one. */
export const MAX_TOKEN_RESPONSE_BYTES = 1 << 20;

/** The `fetch` the SDK sends its requests with. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Credentials supply the access token each call is sent with. */
export interface Credentials {
  /** Returns a valid access token. */
  token(signal?: AbortSignal): Promise<string>;
}

/**
 * A function returning an access token, such as an OIDC session's
 * access-token getter: what a web application passes as its credentials.
 */
export type TokenSource = (signal?: AbortSignal) => string | Promise<string>;

/** Credentials as {@link Credentials}, or as a function returning a token. */
export function toCredentials(credentials: Credentials | TokenSource): Credentials {
  if (typeof credentials === "function") {
    return { token: async (signal) => credentials(signal) };
  }
  return credentials;
}

/**
 * Credentials that always send `token`. It is not renewed: a service
 * account's lives five minutes.
 */
export function accessToken(token: string): Credentials {
  return { token: async () => token };
}

/** One access token, replaced once it is about to expire. */
export class TokenCache {
  private token = "";
  private expiry = 0;
  private renewal: Promise<string> | undefined;

  constructor(token = "", expiry = 0) {
    this.token = token;
    this.expiry = expiry;
  }

  /**
   * The cached token, or the one `renew` returns when the cached one is
   * about to expire. Concurrent callers share one renewal, which runs
   * without any caller's signal: a caller whose `signal` aborts stops
   * waiting for it, with the signal's reason, while the others still get
   * the token.
   */
  get(renew: () => Promise<{ token: string; expiry: number }>, signal?: AbortSignal): Promise<string> {
    if (this.token && Date.now() + EXPIRY_MARGIN_MS < this.expiry) {
      return Promise.resolve(this.token);
    }
    this.renewal ??= renew()
      .then((granted) => {
        this.token = granted.token;
        this.expiry = granted.expiry;
        return granted.token;
      })
      .finally(() => {
        this.renewal = undefined;
      });
    return abortable(this.renewal, signal);
  }
}

/** `promise`, or a rejection with the signal's reason once `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * The text of `response`'s body, read up to `limit` bytes, and whether it
 * was longer.
 */
export async function readLimited(response: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** A token endpoint's answer. */
export interface GrantedToken {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
}

/** Requests a token at `tokenUrl` with the form `form`. */
export async function requestToken(
  fetchImpl: FetchLike | undefined,
  tokenUrl: string,
  form: Record<string, string>,
  signal?: AbortSignal,
): Promise<GrantedToken> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  };
  if (signal) init.signal = signal;
  let response: Response;
  let body: string;
  try {
    response = await (fetchImpl ?? globalThis.fetch).call(globalThis, tokenUrl, init);
    body = (await readLimited(response, MAX_TOKEN_RESPONSE_BYTES)).text;
  } catch (err) {
    throw new Error(`origincloud: requesting a token: ${String(err)}`, { cause: err });
  }
  let granted: Record<string, unknown>;
  try {
    granted = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new Error(`origincloud: requesting a token: HTTP ${response.status}, not a token response`);
  }
  if (response.status !== 200 || typeof granted["access_token"] !== "string" || !granted["access_token"]) {
    const reason = String(granted["error_description"] || granted["error"] || "");
    throw new Error(`origincloud: the token request was refused (HTTP ${response.status}): ${reason}`);
  }
  return granted as unknown as GrantedToken;
}

/** Where a token from `granted` expires, in milliseconds since the epoch. */
export function expiryOf(granted: GrantedToken): number {
  return Date.now() + (Number(granted.expires_in) || 0) * 1000;
}

/** How {@link ServiceAccountCredentials} reach the identity provider. */
export interface TokenEndpointOptions {
  /** Where tokens are requested; {@link TOKEN_URL} by default. */
  tokenUrl?: string;
  /** The `fetch` token requests are sent with; the platform's by default. */
  fetch?: FetchLike;
}

/**
 * Credentials that exchange a service account's client ID and secret for
 * access tokens, with the client credentials grant, as they expire.
 */
export class ServiceAccountCredentials implements Credentials {
  readonly clientId: string;
  private readonly clientSecret: string;
  /** Where tokens are requested. */
  tokenUrl: string;
  /** The `fetch` token requests are sent with; the platform's when unset. */
  fetch: FetchLike | undefined;
  private readonly cache = new TokenCache();

  constructor(clientId: string, clientSecret: string, options: TokenEndpointOptions = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.fetch = options.fetch;
  }

  /** The current access token, requesting a new one when it is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.cache.get(async () => {
      const granted = await requestToken(this.fetch, this.tokenUrl, {
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });
      return { token: granted.access_token, expiry: expiryOf(granted) };
    }, signal);
  }
}

/**
 * Credentials that exchange a service account's client ID and secret for
 * access tokens as they expire.
 */
export function serviceAccount(clientId: string, clientSecret: string, options?: TokenEndpointOptions): Credentials {
  return new ServiceAccountCredentials(clientId, clientSecret, options);
}
