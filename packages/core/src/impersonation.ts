import { type Credentials, type FetchLike, TokenCache } from "./credentials.js";
import { FullName } from "./names.js";
import { STS_ENDPOINT, STS_EXPIRY_MARGIN_MS, grantedBySts, postToSts, stsRefused, stsUnavailable } from "./sts.js";

const ENV_IMPERSONATE_SERVICE_ACCOUNT = "ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT";
const ENV_STS_ENDPOINT = "ORIGINCLOUD_STS_ENDPOINT";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** How {@link ImpersonatedCredentials} reach the STS. */
export interface ImpersonationOptions {
  /**
   * The STS's base URL; {@link STS_ENDPOINT} by default. An https URL, or
   * http to the loopback interface: the caller's token must not travel in
   * the clear.
   */
  endpoint?: string;
  /** The `fetch` its requests are sent with; the platform's by default. */
  fetch?: FetchLike;
}

/**
 * Another credential's token exchanged at the security token service for a
 * service account's (impersonation, RFC 8693): the caller, typically a
 * person logged in with `origin id login`, acts as the account, with the
 * account's roles alone, and the audit log names both. The STS issues the
 * token only to a caller granted `roles/iam.service-account-token-creator`
 * on the account (or its project or organization), and only for an active
 * `EXTERNAL` or `WORKLOAD` account.
 *
 * The account's token lives five minutes at most and is reused until a
 * minute before it expires; then the underlying credential's current token
 * is exchanged again. Concurrent callers share one exchange. A refused
 * exchange is an error naming the account: the caller's own token is never
 * sent in its place. An exchange the STS can't answer right now (503) is
 * sent again twice.
 *
 * The client option `impersonateServiceAccount`, or
 * `ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT`, wraps a client's credentials
 * in it.
 */
export class ImpersonatedCredentials implements Credentials {
  /** The credentials whose tokens are exchanged. */
  readonly base: Credentials;
  /** The full name of the service account it acts as. */
  readonly serviceAccount: string;
  /** The STS's base URL. */
  readonly endpoint: string;
  /** The `fetch` its requests are sent with; the platform's when unset. */
  readonly fetch: FetchLike | undefined;
  private readonly cache = new TokenCache("", 0, STS_EXPIRY_MARGIN_MS);

  /**
   * Acts as the service account `serviceAccount`, its full name
   * (`//iam.origincloudapis.eu/organizations/{organization}/serviceAccounts/{serviceAccount}`),
   * with the tokens `base` supplies. A name that isn't a service account's
   * is refused.
   */
  constructor(base: Credentials, serviceAccount: string, options: ImpersonationOptions = {}) {
    let kind: string | undefined;
    try {
      kind = FullName.parse(serviceAccount).principal()?.kind;
    } catch {
      kind = undefined;
    }
    if (kind !== "serviceAccount") {
      throw new Error(
        "origincloud: the service account to impersonate must be its full name, " +
          "//iam.origincloudapis.eu/organizations/{organization}/serviceAccounts/{serviceAccount}, " +
          `got ${JSON.stringify(serviceAccount)}`,
      );
    }
    this.base = base;
    this.serviceAccount = serviceAccount;
    this.endpoint = (options.endpoint ?? STS_ENDPOINT).replace(/\/+$/, "");
    this.fetch = options.fetch;
  }

  /** The account's access token, exchanging the caller's current one when it is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.cache.get(async () => {
      if (!secureEndpoint(this.endpoint)) {
        throw this.failed(`the STS endpoint ${JSON.stringify(this.endpoint)} is not an https URL`);
      }
      // The shared exchange runs without any caller's signal (see TokenCache).
      const subjectToken = await this.base.token();
      return this.exchange(subjectToken);
    }, signal);
  }

  /** The caller's token `subjectToken` exchanged for the account's. */
  private async exchange(subjectToken: string): Promise<{ token: string; expiry: number }> {
    let answer;
    try {
      answer = await postToSts(
        this.fetch,
        this.endpoint,
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: subjectToken,
          subject_token_type: ACCESS_TOKEN_TYPE,
          service_account: this.serviceAccount,
        },
        "exchanging the token",
      );
    } catch (err) {
      throw this.failed((err as Error).message.replace(/^origincloud: /, ""), err);
    }
    if (answer.status === 200) {
      try {
        return grantedBySts(answer);
      } catch (err) {
        throw this.failed("the STS's answer is not a token response", err);
      }
    }
    if (answer.status === 503) throw this.failed(stsUnavailable().message.replace(/^origincloud: /, ""));
    if (answer.body["error"] === "invalid_grant") {
      throw new Error(
        `origincloud: the STS refused to impersonate the service account ${this.serviceAccount} (invalid_grant): ` +
          "the caller needs roles/iam.service-account-token-creator on it, and the account must exist and be active",
      );
    }
    throw this.failed(stsRefused(answer, "the token exchange", subjectToken).message.replace(/^origincloud: /, ""));
  }

  /** `message` about impersonating the account, as an error. */
  private failed(message: string, cause?: unknown): Error {
    return new Error(
      `origincloud: impersonating the service account ${this.serviceAccount}: ${message}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

/**
 * Credentials that act as the service account `serviceAccount` (its full
 * name) with the tokens `base` supplies. Creating them sends no request.
 */
export function impersonate(base: Credentials, serviceAccount: string, options?: ImpersonationOptions): ImpersonatedCredentials {
  return new ImpersonatedCredentials(base, serviceAccount, options);
}

/**
 * `credentials`, impersonating the service account `chosen` names (the
 * client option), or else `ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT` does, at
 * the STS `ORIGINCLOUD_STS_ENDPOINT` names, if any. An empty name
 * impersonates no one. @internal
 */
export function impersonating(
  credentials: Credentials,
  chosen: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Credentials {
  const name = (chosen ?? env[ENV_IMPERSONATE_SERVICE_ACCOUNT] ?? "").trim();
  if (!name) return credentials;
  const endpoint = env[ENV_STS_ENDPOINT];
  return new ImpersonatedCredentials(credentials, name, endpoint ? { endpoint } : {});
}

/** Whether the caller's token may be sent to `endpoint`: https, or http to the loopback interface. */
function secureEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
