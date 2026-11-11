import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
const ENV_OIDC_DISABLED = "ORIGINCLOUD_OIDC_DISABLED";
const ENV_OIDC_TOKEN_FILE = "ORIGINCLOUD_OIDC_TOKEN_FILE";
const ENV_OIDC_AUDIENCE = "ORIGINCLOUD_OIDC_AUDIENCE";
const ENV_STS_ENDPOINT = "ORIGINCLOUD_STS_ENDPOINT";
const ENV_GITHUB_REQUEST_URL = "ACTIONS_ID_TOKEN_REQUEST_URL";
const ENV_GITHUB_REQUEST_TOKEN = "ACTIONS_ID_TOKEN_REQUEST_TOKEN";

/** The OAuth client the CLI logs in as, which its refresh token belongs to. */
const CLI_CLIENT_ID = "origin-cli";

/**
 * Thrown by {@link defaultCredentials} when it finds no credentials, and by
 * {@link InstanceMetadataCredentials} when no metadata service of Origin
 * Cloud's answers.
 */
export class NoCredentialsError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "origincloud: no credentials: set ORIGINCLOUD_CLIENT_ID and ORIGINCLOUD_CLIENT_SECRET, " +
        "set ORIGINCLOUD_ACCESS_TOKEN, run in a CI job whose OIDC token the STS trusts " +
        "(GitHub Actions with `permissions: id-token: write`, or ORIGINCLOUD_OIDC_TOKEN_FILE), " +
        "log in with `origin id login`, " +
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
 * 3. A CI job's OIDC token, exchanged at the STS for a workload service
 *    account's access tokens ({@link federated}): the file
 *    `ORIGINCLOUD_OIDC_TOKEN_FILE` names, or else GitHub Actions' token when
 *    `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are
 *    set. `ORIGINCLOUD_STS_ENDPOINT` names another STS,
 *    `ORIGINCLOUD_OIDC_AUDIENCE` another audience for GitHub's token;
 *    `ORIGINCLOUD_OIDC_DISABLED=true` leaves this out. A job token found is
 *    the credential: its errors are the first call's, not a reason to look
 *    further.
 * 4. The session the `origin` CLI stored at its last login (`origin id login`).
 * 5. The instance's metadata service ({@link instanceMetadata}), asked at the
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
  const ciJob = ciJobCredentials();
  if (ciJob) return ciJob;
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
    if (answer.status === 403) throw proxyRefused();
    if (answer.status === 503) {
      throw new Error(`origincloud: the metadata service refused a session (HTTP ${answer.status})`);
    }
    // Only this platform's metadata service grants the session. Anything
    // else is no metadata service of ours: an address that is no instance
    // (404), or another cloud's metadata service at the same address,
    // which refuses a request it doesn't know (such as 400, 405 or 411).
    if (answer.status !== 200) throw new NoCredentialsError();
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

/** Where the security token service (STS) exchanges a CI job's OIDC token for an access token. */
export const STS_ENDPOINT = "https://sts.origincloudapis.eu";

/** The audience a CI job's OIDC token is requested for. */
export const OIDC_AUDIENCE = "https://sts.origincloudapis.eu";

/** How long before its expiry an exchanged access token is replaced. */
const FEDERATED_EXPIRY_MARGIN_MS = 60_000;

/** How long to wait before exchanging again after the STS answered 503: twice, so three attempts in all. */
const STS_RETRY_DELAYS_MS = [200, 400];

/**
 * A function returning a CI job's OIDC token. It is asked at every
 * exchange, so it returns a fresh token each time.
 */
export type SubjectTokenSource = () => string | Promise<string>;

/** How {@link FederatedCredentials} reach the STS. */
export interface FederatedOptions {
  /** The STS's base URL; {@link STS_ENDPOINT} by default. */
  endpoint?: string;
  /** The `fetch` its requests are sent with; the platform's by default. */
  fetch?: FetchLike;
}

/** How {@link githubActions} requests the job's token, and reaches the STS. */
export interface GitHubActionsOptions extends FederatedOptions {
  /** The audience the job's token is requested for; {@link OIDC_AUDIENCE} by default. */
  audience?: string;
}

/**
 * Credentials that exchange a CI job's OIDC token at the STS (RFC 8693) for
 * the access tokens of the workload service account a federated credential
 * trusts it for. Each exchange asks for a fresh job token.
 */
export class FederatedCredentials implements Credentials {
  /** The STS's base URL. */
  endpoint: string;
  /** The `fetch` its requests are sent with; the platform's when unset. */
  fetch: FetchLike | undefined;
  private readonly subjectToken: SubjectTokenSource;
  private readonly cache = new TokenCache("", 0, FEDERATED_EXPIRY_MARGIN_MS);

  constructor(subjectToken: SubjectTokenSource, options: FederatedOptions = {}) {
    this.subjectToken = subjectToken;
    this.endpoint = (options.endpoint ?? STS_ENDPOINT).replace(/\/+$/, "");
    this.fetch = options.fetch;
  }

  /** The current access token, exchanging a fresh job token when it is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.cache.get(async () => {
      const subjectToken = await this.subjectToken();
      if (!subjectToken) throw new Error("origincloud: the CI job's OIDC token is empty");
      return this.exchange(subjectToken);
    }, signal);
  }

  /** Exchanges `subjectToken`, again while the STS answers 503. */
  private async exchange(subjectToken: string): Promise<{ token: string; expiry: number }> {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: subjectToken,
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      }).toString(),
    };
    const url = this.endpoint + "/v1/token";
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const response = await (this.fetch ?? globalThis.fetch).call(globalThis, url, init);
        status = response.status;
        text = (await readLimited(response, MAX_TOKEN_RESPONSE_BYTES)).text;
      } catch (err) {
        throw new Error(`origincloud: exchanging the CI job's OIDC token at ${this.endpoint}: ${String(err)}`, {
          cause: err,
        });
      }
      const delay = STS_RETRY_DELAYS_MS[attempt];
      if (status === 503 && delay !== undefined) {
        await sleep(delay);
        continue;
      }
      return exchanged(status, text, subjectToken);
    }
  }
}

/** The credential in the STS's answer, or the error it means. */
function exchanged(status: number, text: string, subjectToken: string): { token: string; expiry: number } {
  let answer: Record<string, unknown>;
  try {
    answer = (JSON.parse(text) ?? {}) as Record<string, unknown>;
  } catch {
    answer = {};
  }
  if (status === 200) {
    const token = answer["access_token"];
    if (typeof token !== "string" || !token) {
      throw new Error("origincloud: the STS's answer is not a credential");
    }
    return { token, expiry: Date.now() + (Number(answer["expires_in"]) || 0) * 1000 };
  }
  const error = typeof answer["error"] === "string" ? answer["error"] : "";
  if (status === 503) {
    throw new Error("origincloud: the STS is temporarily unavailable (HTTP 503): try again later");
  }
  if (error === "invalid_grant") {
    throw new Error(
      "origincloud: the STS refused the CI job's OIDC token (invalid_grant): check the federated " +
        "credential's issuer, audience and conditions against the token's claims",
    );
  }
  // The description is the STS's; it is not expected to quote the token, but it must never show it.
  const description = String(answer["error_description"] ?? "").replaceAll(subjectToken, "[token]");
  const reason = [error, description].filter(Boolean).join(": ");
  throw new Error(`origincloud: the STS refused the token exchange (HTTP ${status})${reason ? ": " + reason : ""}`);
}

/**
 * Credentials that exchange the CI job's OIDC token `subjectToken` returns
 * at the STS. Creating them sends no request.
 */
export function federated(subjectToken: SubjectTokenSource, options?: FederatedOptions): FederatedCredentials {
  return new FederatedCredentials(subjectToken, options);
}

/**
 * Credentials that exchange the OIDC token in the file at `path`, such as
 * a Kubernetes projected token or another CI provider's. The file is read
 * at every exchange, so a rotated token is picked up.
 */
export function oidcTokenFile(path: string, options?: FederatedOptions): FederatedCredentials {
  return new FederatedCredentials(async () => {
    let data: string;
    try {
      data = await readFile(path, "utf8");
    } catch (err) {
      throw new Error(`origincloud: reading the OIDC token file: ${String(err)}`, { cause: err });
    }
    const token = data.trim();
    if (!token) throw new Error(`origincloud: the OIDC token file ${path} is empty`);
    return token;
  }, options);
}

/**
 * Credentials that exchange the GitHub Actions job's OIDC token, requested
 * from GitHub at every exchange. GitHub sets `ACTIONS_ID_TOKEN_REQUEST_URL`
 * and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` only when the workflow grants
 * `permissions: id-token: write`; without them this throws.
 */
export function githubActions(options: GitHubActionsOptions = {}): FederatedCredentials {
  const requestUrl = process.env[ENV_GITHUB_REQUEST_URL] ?? "";
  const requestToken = process.env[ENV_GITHUB_REQUEST_TOKEN] ?? "";
  if (!requestUrl || !requestToken) {
    throw new Error(
      `origincloud: ${ENV_GITHUB_REQUEST_URL} and ${ENV_GITHUB_REQUEST_TOKEN} aren't set: ` +
        "the workflow needs `permissions: id-token: write`",
    );
  }
  const { audience = OIDC_AUDIENCE, ...sts } = options;
  const url = requestUrl + (requestUrl.includes("?") ? "&" : "?") + "audience=" + encodeURIComponent(audience);
  return new FederatedCredentials(async () => {
    const failed = (reason: string, cause?: unknown) =>
      new Error(
        `origincloud: requesting the job's OIDC token from GitHub Actions: ${reason}: ` +
          "does the workflow grant `permissions: id-token: write`?",
        cause === undefined ? undefined : { cause },
      );
    let status: number;
    let text: string;
    let truncated: boolean;
    try {
      const response = await (sts.fetch ?? globalThis.fetch).call(globalThis, url, {
        method: "GET",
        headers: { Authorization: `bearer ${requestToken}`, Accept: "application/json" },
      });
      status = response.status;
      ({ text, truncated } = await readLimited(response, MAX_TOKEN_RESPONSE_BYTES));
    } catch (err) {
      throw failed(String(err), err);
    }
    if (status !== 200) throw failed(`HTTP ${status}`);
    let value: unknown;
    try {
      value = truncated ? undefined : (JSON.parse(text) as Record<string, unknown> | null)?.["value"];
    } catch {
      value = undefined;
    }
    if (typeof value !== "string" || !value) throw failed("the answer holds no token");
    return value;
  }, sts);
}

/**
 * The CI job's credentials the environment names, unless
 * `ORIGINCLOUD_OIDC_DISABLED=true`: a token file before GitHub Actions.
 */
function ciJobCredentials(): FederatedCredentials | undefined {
  if (process.env[ENV_OIDC_DISABLED]?.toLowerCase() === "true") return undefined;
  const endpoint = process.env[ENV_STS_ENDPOINT];
  const options: GitHubActionsOptions = endpoint ? { endpoint } : {};
  const file = process.env[ENV_OIDC_TOKEN_FILE];
  if (file) return oidcTokenFile(file, options);
  if (!process.env[ENV_GITHUB_REQUEST_URL] || !process.env[ENV_GITHUB_REQUEST_TOKEN]) return undefined;
  const audience = process.env[ENV_OIDC_AUDIENCE];
  if (audience) options.audience = audience;
  return githubActions(options);
}
