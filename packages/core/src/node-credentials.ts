import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type Credentials,
  type FetchLike,
  type TokenEndpointOptions,
  TOKEN_URL,
  TokenCache,
  accessToken,
  expiryOf,
  requestToken,
  serviceAccount,
} from "./credentials.js";

const ENV_ACCESS_TOKEN = "ORIGINCLOUD_ACCESS_TOKEN";
const ENV_CLIENT_ID = "ORIGINCLOUD_CLIENT_ID";
const ENV_CLIENT_SECRET = "ORIGINCLOUD_CLIENT_SECRET";

/** The OAuth client the CLI logs in as, which its refresh token belongs to. */
const CLI_CLIENT_ID = "origin-cli";

/** Thrown by {@link defaultCredentials} when neither the environment nor a CLI session holds any. */
export class NoCredentialsError extends Error {
  constructor() {
    super(
      "origincloud: no credentials: set ORIGINCLOUD_CLIENT_ID and ORIGINCLOUD_CLIENT_SECRET, " +
        "set ORIGINCLOUD_ACCESS_TOKEN, or log in with `origin id login`",
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
 *
 * It throws a {@link NoCredentialsError} when none is found.
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
  if (!session) throw new NoCredentialsError();
  return session;
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
