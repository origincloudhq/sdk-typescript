import { type KeyObject, createPrivateKey, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

import { type Credentials, type FetchLike, TokenCache } from "./credentials.js";
import { FullName } from "./names.js";
import { STS_EXPIRY_MARGIN_MS, grantedBySts, postToSts, stsRefused, stsUnavailable } from "./sts.js";

/** The `type` of a service account key's credentials file. */
const CREDENTIALS_FILE_TYPE = "service_account_key";

/** The OAuth 2.0 grant an assertion is exchanged with (RFC 7523). */
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/**
 * How long an assertion is valid, in seconds. It is exchanged at once; the
 * STS refuses one that lives longer than an hour.
 */
const ASSERTION_LIFETIME_SECONDS = 300;

/** How {@link ServiceAccountKeyCredentials} reach the STS. */
export interface ServiceAccountKeyOptions {
  /** The `fetch` the exchanges are sent with; the platform's by default. */
  fetch?: FetchLike;
}

/**
 * Credentials of an `EXTERNAL` service account from a key's credentials
 * file: an ES256 assertion signed with the key (RFC 7523), exchanged at
 * the STS the file names for the account's access token, again a minute
 * before that token expires. Concurrent callers share one exchange.
 *
 * Neither the credentials nor their errors ever show the private key:
 * `util.inspect`, `JSON.stringify` and `String` name the key only.
 */
export class ServiceAccountKeyCredentials implements Credentials {
  /** The key's full name, the assertion's `kid`. */
  readonly keyName: string;
  /** The service account's full name, the assertion's `iss` and `sub`. */
  readonly serviceAccount: string;
  /** Where the assertion is exchanged, and its `aud`. */
  readonly stsEndpoint: string;
  /** The `fetch` the exchanges are sent with; the platform's when unset. */
  fetch: FetchLike | undefined;
  readonly #key: KeyObject;
  readonly #cache = new TokenCache("", 0, STS_EXPIRY_MARGIN_MS);

  private constructor(file: CheckedFile, options: ServiceAccountKeyOptions) {
    this.keyName = file.name;
    this.serviceAccount = file.serviceAccount;
    this.stsEndpoint = file.stsEndpoint;
    this.#key = file.key;
    this.fetch = options.fetch;
  }

  /**
   * The credentials in the credentials file `json`, as creating the key
   * returned it. A file that isn't an ES256 key's, or whose key can't sign,
   * is refused; the error never quotes it.
   */
  static fromJSON(json: string, options: ServiceAccountKeyOptions = {}): ServiceAccountKeyCredentials {
    return new ServiceAccountKeyCredentials(checkFile(json, "the credentials file"), options);
  }

  /** The credentials in the credentials file at `path`, read now. */
  static fromFile(path: string, options: ServiceAccountKeyOptions = {}): ServiceAccountKeyCredentials {
    let json: string;
    try {
      json = readFileSync(path, "utf8");
    } catch (err) {
      throw new Error(`origincloud: reading the credentials file ${path}: ${String(err)}`, { cause: err });
    }
    return new ServiceAccountKeyCredentials(checkFile(json, `the credentials file ${path}`), options);
  }

  /** The service account's access token, exchanging a new assertion when it is about to expire. */
  token(signal?: AbortSignal): Promise<string> {
    return this.#cache.get(() => this.exchange(), signal);
  }

  /**
   * An assertion signed with the key, issued at `now` (milliseconds since
   * the epoch): `kid` the key, `iss` and `sub` the service account, `aud`
   * the STS, a five-minute lifetime and a fresh `jti`.
   */
  assertion(now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const input =
      part({ alg: "ES256", typ: "JWT", kid: this.keyName }) +
      "." +
      part({
        iss: this.serviceAccount,
        sub: this.serviceAccount,
        aud: this.stsEndpoint,
        iat,
        exp: iat + ASSERTION_LIFETIME_SECONDS,
        jti: randomUUID(),
      });
    const signature = sign("sha256", Buffer.from(input), { key: this.#key, dsaEncoding: "ieee-p1363" });
    return `${input}.${signature.toString("base64url")}`;
  }

  /** Exchanges a fresh assertion at the STS, again while it answers 503. */
  private async exchange(): Promise<{ token: string; expiry: number }> {
    const assertion = this.assertion();
    const answer = await postToSts(
      this.fetch,
      this.stsEndpoint,
      { grant_type: JWT_BEARER_GRANT, assertion },
      `exchanging the assertion of the service account key ${this.keyName}`,
    );
    if (answer.status === 200) return grantedBySts(answer);
    if (answer.status === 503) throw stsUnavailable();
    if (answer.body["error"] === "invalid_grant") {
      throw new Error(
        `origincloud: the STS refused the assertion of the service account key ${this.keyName} ` +
          "(invalid_grant): the key or its service account may be deleted, or the account isn't an " +
          "EXTERNAL one; the organization's audit log records why",
      );
    }
    throw stsRefused(answer, "the service account key's assertion", assertion);
  }

  toString(): string {
    return `ServiceAccountKeyCredentials(${this.keyName})`;
  }

  toJSON(): unknown {
    return { keyName: this.keyName, serviceAccount: this.serviceAccount, stsEndpoint: this.stsEndpoint };
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/**
 * Credentials from the service account key's credentials file at `path`,
 * read now. Creating them sends no request.
 */
export function credentialsFile(path: string, options?: ServiceAccountKeyOptions): ServiceAccountKeyCredentials {
  return ServiceAccountKeyCredentials.fromFile(path, options);
}

/** A credentials file whose fields were checked. */
interface CheckedFile {
  name: string;
  serviceAccount: string;
  stsEndpoint: string;
  key: KeyObject;
}

/**
 * The fields of the credentials file `json`, checked. `what` names the file
 * in errors, which never quote its content: a parse error may.
 */
function checkFile(json: string, what: string): CheckedFile {
  const refused = (reason: string) => new Error(`origincloud: ${what} ${reason}`);
  let file: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    file = parsed as Record<string, unknown>;
  } catch {
    throw refused("is not JSON: save the credentialsFile the key's creation returned as it is");
  }
  const field = (name: string): string => {
    const value = file[name];
    if (typeof value !== "string" || !value) throw refused(`has no ${name}`);
    return value;
  };
  const type = field("type");
  if (type !== CREDENTIALS_FILE_TYPE) {
    throw refused(`is of the type ${JSON.stringify(type)}, not ${CREDENTIALS_FILE_TYPE}`);
  }
  const algorithm = field("algorithm");
  if (algorithm !== "ES256") throw refused(`names the algorithm ${JSON.stringify(algorithm)}, not ES256`);

  const serviceAccount = field("service_account");
  if (parsedOrUndefined(serviceAccount)?.principal()?.kind !== "serviceAccount") {
    throw refused(`names ${JSON.stringify(serviceAccount)} as its service_account, not a service account's full name`);
  }
  const name = field("name");
  const prefix = serviceAccount + "/keys/";
  const keyId = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  if (!keyId || keyId.includes("/") || !parsedOrUndefined(name)) {
    throw refused(`names ${JSON.stringify(name)} as its key, not the full name of a key of ${serviceAccount}`);
  }

  const stsEndpoint = field("sts_endpoint").replace(/\/+$/, "");
  if (!isStsEndpoint(stsEndpoint)) {
    throw refused(`names ${JSON.stringify(stsEndpoint)} as its sts_endpoint, not an https URL`);
  }

  const pem = field("private_key");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw refused("holds no private key in PEM");
  }
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw refused("holds a private key that isn't a P-256 key");
  }
  return { name, serviceAccount, stsEndpoint, key: privateKey };
}

function parsedOrUndefined(name: string): FullName | undefined {
  try {
    return FullName.parse(name);
  } catch {
    return undefined;
  }
}

/**
 * Whether `url` is an STS base URL an assertion may be sent to: https, or
 * http on the loopback interface, as a local test server answers.
 */
function isStsEndpoint(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
}
