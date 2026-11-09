import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  type Credentials,
  type FetchLike,
  type TokenEndpointOptions,
  MAX_TOKEN_RESPONSE_BYTES,
  TOKEN_URL,
  TokenCache,
  accessToken,
  expiryOf,
  readLimited,
  requestToken,
  serviceAccount,
} from "./credentials.js";

const ENV_ACCESS_TOKEN = "ORIGINCLOUD_ACCESS_TOKEN";
const ENV_CLIENT_ID = "ORIGINCLOUD_CLIENT_ID";
const ENV_CLIENT_SECRET = "ORIGINCLOUD_CLIENT_SECRET";
const ENV_METADATA_DISABLED = "ORIGINCLOUD_METADATA_DISABLED";
const ENV_METADATA_ENDPOINT = "ORIGINCLOUD_METADATA_ENDPOINT";

/** The OAuth client the CLI logs in as, which its refresh token belongs to. */
const CLI_CLIENT_ID = "origin-cli";

/**
 * Thrown by {@link defaultCredentials} when it finds no credentials, and by
 * {@link InstanceMetadataCredentials} when no metadata service answers.
 */
export class NoCredentialsError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "origincloud: no credentials: set ORIGINCLOUD_CLIENT_ID and ORIGINCLOUD_CLIENT_SECRET, " +
        "set ORIGINCLOUD_ACCESS_TOKEN, log in with `origin id login`, " +
        "or run on an instance that runs as a service account",
      options,
    );
    this.name = "NoCredentialsError";
  }
}

/**
 * The first credentials found, in this order:
 *
 * 1. `ORIGINCLOUD_ACCESS_TOKEN`: an access token, sent as it is.
 * 2. `ORIGINCLOUD_CLIENT_ID` and `ORIGINCLOUD_CLIENT_SECRET`: a service
 *    account's credential, exchanged for access tokens as they expire. Only
 *    one of the two set is an error.
 * 3. The session the `origin` CLI stored at its last login (`origin id login`).
 * 4. The instance's metadata service ({@link instanceMetadata}), asked at the
 *    first call: on an instance that runs as a service account, its tokens.
 *    `ORIGINCLOUD_METADATA_ENDPOINT` names another base URL;
 *    `ORIGINCLOUD_METADATA_DISABLED=true` leaves this out.
 *
 * It throws a {@link NoCredentialsError} when none is found; where there is
 * no metadata service, the first call rejects with one.
 */
export function defaultCredentials(): Credentials {
  const token = process.env[ENV_ACCESS_TOKEN];
  if (token) return accessToken(token);
  const id = process.env[ENV_CLIENT_ID] ?? "";
  const secret = process.env[ENV_CLIENT_SECRET] ?? "";
  if (id && secret) return serviceAccount(id, secret);
  if (id || secret) {
    throw new Error(`origincloud: ${ENV_CLIENT_ID} and ${ENV_CLIENT_SECRET} must be set together`);
  }
  const session = cliSession();
  if (session) return session;
  if (process.env[ENV_METADATA_DISABLED]?.toLowerCase() === "true") throw new NoCredentialsError();
  const endpoint = process.env[ENV_METADATA_ENDPOINT];
  return instanceMetadata(endpoint ? { endpoint } : {});
}

/** A CLI session, its times in milliseconds since the epoch. */
export interface CLISession {
  accessToken: string;
  expires: number;
  refreshToken: string;
  refreshExpires: number;
}

/** The file the CLI stores its session in. */
interface StoredSession {
  access_token?: string;
  expires?: unknown;
  refresh_token?: string;
  refresh_expires?: unknown;
}

/**
 * Where the CLI stores its session: under `XDG_DATA_HOME`, or
 * `~/.local/share`, on every platform.
 */
export function cliSessionPath(): string {
  const base = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share");
  return join(base, "origincloud", "session.json");
}

/**
 * The session the `origin` CLI stored at its last login, renewed from its
 * refresh token when its access token has expired; `undefined` when there
 * is none. The renewed session stays in memory: the CLI's file is never
 * written.
 */
export function cliSession(options: TokenEndpointOptions = {}): CLISessionCredentials | undefined {
  const path = cliSessionPath();
  let data: string;
  try {
    data = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`origincloud: reading the CLI session: ${String(err)}`, { cause: err });
  }
  let stored: StoredSession;
  try {
    stored = JSON.parse(data) as StoredSession;
  } catch (err) {
    throw new Error(`origincloud: reading the CLI session ${path}: ${String(err)}`, { cause: err });
  }
  return new CLISessionCredentials(
    {
      accessToken: stored.access_token ?? "",
      expires: time(path, "expires", stored.expires),
      refreshToken: stored.refresh_token ?? "",
      refreshExpires: time(path, "refresh_expires", stored.refresh_expires),
    },
    options,
  );
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * A time the session file holds, in milliseconds since the epoch; 0 when
 * it holds none. One that isn't an RFC 3339 time is an error.
 */
function time(path: string, field: string, value: unknown): number {
  if (value === undefined || value === null) return 0;
  const parsed = typeof value === "string" && RFC3339.test(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(parsed)) {
    throw new Error(`origincloud: reading the CLI session ${path}: ${field} isn't an RFC 3339 time: ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** The `origin` CLI's session. */
export class CLISessionCredentials implements Credentials {
  /** Where the session is renewed. */
  tokenUrl: string;
  /** The `fetch` the renewal is sent with; the platform's when unset. */
  fetch: FetchLike | undefined;
  private readonly cache: TokenCache;
  private refreshToken: string;
  private refreshExpiry: number;

  constructor(session: CLISession, options: TokenEndpointOptions = {}) {
    this.tokenUrl = options.tokenUrl ?? TOKEN_URL;
    this.fetch = options.fetch;
    this.cache = new TokenCache(session.accessToken, session.expires);
    this.refreshToken = session.refreshToken;
    this.refreshExpiry = session.refreshExpires;
  }

  /** The session's access token, renewing the session when the token is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.cache.get(async () => {
      if (Date.now() >= this.refreshExpiry) {
        throw new Error("origincloud: the CLI session has expired: log in again with `origin id login`");
      }
      let granted;
      try {
        granted = await requestToken(this.fetch, this.tokenUrl, {
          grant_type: "refresh_token",
          client_id: CLI_CLIENT_ID,
          refresh_token: this.refreshToken,
        });
      } catch (err) {
        throw new Error(`renewing the CLI session: ${(err as Error).message}`, { cause: err });
      }
      if (granted.refresh_token) {
        this.refreshToken = granted.refresh_token;
        this.refreshExpiry = Date.now() + (Number(granted.refresh_expires_in) || 0) * 1000;
      }
      return { token: granted.access_token, expiry: expiryOf(granted) };
    }, signal);
  }
}

/** Where an instance's metadata service answers. */
export const METADATA_ENDPOINT = "http://169.254.169.254";

const METADATA_TTL_HEADER = "X-Origincloud-Metadata-Token-TTL-Seconds";
const METADATA_TOKEN_HEADER = "X-Origincloud-Metadata-Token";

/** How long a metadata session lasts: six hours, the most the service grants. */
const METADATA_SESSION_TTL_SECONDS = 21600;

// fetch can't bound connecting apart from the whole request. The session
// request, which the service answers at once, gets a short bound, so that
// where no metadata service answers the chain gives up within two seconds;
// the token request, which the host signs, gets a longer one.
const METADATA_SESSION_TIMEOUT_MS = 2000;
const METADATA_TOKEN_TIMEOUT_MS = 5000;

/** How long before its expiry a metadata access token is replaced. */
const METADATA_EXPIRY_MARGIN_MS = 60_000;

/** How long to wait before sending a request again that was answered 503: twice, so three attempts in all. */
const METADATA_RETRY_DELAYS_MS = [100, 200];

/** How {@link InstanceMetadataCredentials} reach the metadata service. */
export interface InstanceMetadataOptions {
  /** The metadata service's base URL; {@link METADATA_ENDPOINT} by default. */
  endpoint?: string;
  /**
   * The `fetch` its requests are sent with; the platform's by default,
   * which goes through no proxy.
   */
  fetch?: FetchLike;
}

/**
 * Credentials an instance gets from its metadata service: the access
 * tokens of the service account it runs as, requested as they expire.
 */
export class InstanceMetadataCredentials implements Credentials {
  /** The metadata service's base URL. */
  endpoint: string;
  /** The `fetch` its requests are sent with; the platform's when unset. */
  fetch: FetchLike | undefined;
  private readonly cache = new TokenCache("", 0, METADATA_EXPIRY_MARGIN_MS);
  private session = new TokenCache();

  constructor(options: InstanceMetadataOptions = {}) {
    this.endpoint = (options.endpoint ?? METADATA_ENDPOINT).replace(/\/+$/, "");
    this.fetch = options.fetch;
  }

  /** The service account's access token, requesting a new one when it is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.cache.get(async () => {
      let answer = await this.requestToken();
      if (answer.status === 401) {
        // The session expired or the service forgot it: open another.
        this.session = new TokenCache();
        answer = await this.requestToken();
      }
      return credentialOf(answer);
    }, signal);
  }

  /** Asks for the service account's token with the current session. */
  private async requestToken(): Promise<{ status: number; text: string; truncated: boolean }> {
    const session = await this.session.get(() => this.openSession());
    return this.send(
      "GET",
      "/latest/meta-data/service-account/token",
      { [METADATA_TOKEN_HEADER]: session },
      METADATA_TOKEN_TIMEOUT_MS,
    );
  }

  /** Opens a session, which the token requests present. */
  private async openSession(): Promise<{ token: string; expiry: number }> {
    const answer = await this.send(
      "PUT",
      "/latest/api/token",
      { [METADATA_TTL_HEADER]: String(METADATA_SESSION_TTL_SECONDS) },
      METADATA_SESSION_TIMEOUT_MS,
    );
    // Not an instance's address: no metadata service is there for it.
    if (answer.status === 404) throw new NoCredentialsError();
    if (answer.status === 403) throw proxyRefused();
    if (answer.status !== 200) {
      throw new Error(`origincloud: the metadata service refused a session (HTTP ${answer.status})`);
    }
    const token = answer.text.trim();
    if (!token || answer.truncated) throw notACredential();
    return { token, expiry: Date.now() + METADATA_SESSION_TTL_SECONDS * 1000 };
  }

  /**
   * Sends a request, again while the service answers 503, and returns the
   * last answer. No answer at all means there is no metadata service.
   */
  private async send(
    method: string,
    path: string,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<{ status: number; text: string; truncated: boolean }> {
    for (let attempt = 0; ; attempt++) {
      let answer;
      try {
        const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
        const response = await (this.fetch ?? globalThis.fetch).call(globalThis, this.endpoint + path, init);
        answer = { status: response.status, ...(await readLimited(response, MAX_TOKEN_RESPONSE_BYTES)) };
      } catch (err) {
        throw new NoCredentialsError({ cause: err });
      }
      const delay = METADATA_RETRY_DELAYS_MS[attempt];
      if (answer.status !== 503 || delay === undefined) return answer;
      await sleep(delay);
    }
  }
}

/** The credential in the metadata service's answer to a token request. */
function credentialOf(answer: { status: number; text: string; truncated: boolean }): { token: string; expiry: number } {
  if (answer.status === 404) throw new Error("origincloud: the instance runs as no service account");
  if (answer.status === 403) throw proxyRefused();
  if (answer.status !== 200) throw new Error(`origincloud: the metadata service answered HTTP ${answer.status}`);
  let granted: unknown;
  try {
    granted = answer.truncated ? undefined : JSON.parse(answer.text);
  } catch {
    granted = undefined;
  }
  const { access_token: token, expires_at: expiresAt } = (granted ?? {}) as Record<string, unknown>;
  const expiry = typeof expiresAt === "string" && RFC3339.test(expiresAt) ? Date.parse(expiresAt) : NaN;
  if (typeof token !== "string" || !token || Number.isNaN(expiry)) throw notACredential();
  return { token, expiry };
}

function proxyRefused(): Error {
  return new Error("origincloud: the metadata service refused a request that came through a proxy");
}

function notACredential(): Error {
  return new Error("origincloud: the metadata service's answer is not a credential");
}

/**
 * Credentials from the instance's metadata service: the access tokens of
 * the service account the instance runs as. Creating them sends no request.
 */
export function instanceMetadata(options?: InstanceMetadataOptions): InstanceMetadataCredentials {
  return new InstanceMetadataCredentials(options);
}
