import { type Credentials, type FetchLike, type TokenSource, toCredentials } from "./credentials.js";
import { Service } from "./transport.js";

/** This SDK's version, sent in the User-Agent header from Node. */
export const VERSION = "0.24.0";

const DEFAULT_MAX_ATTEMPTS = 5;

/** The services that answer only at their regionless host. */
const GLOBAL_SERVICES = new Set(["iam", "resourcemanager", "location", "billing", "support"]);

/** How a {@link Client} is configured. */
export interface ClientOptions {
  /**
   * The credentials calls are sent with: {@link Credentials}, or a function
   * returning an access token, such as an OIDC session's token getter.
   * Required in a browser; in Node they are found in the environment, the
   * CLI's session or the instance's metadata service when left out.
   */
  credentials?: Credentials | TokenSource;
  /**
   * Sends calls to a region's front door,
   * `{service}.{region}.origincloudapis.eu`, for the services that have
   * one. In Node it overrides `ORIGINCLOUD_REGION`; an empty region uses
   * the regionless endpoint.
   */
  region?: string;
  /**
   * Sends the calls of every service to one base URL, such as a test
   * server's, instead of the service's own host. Empty means unset.
   */
  endpoint?: string;
  /** The `fetch` calls are sent with; the platform's by default. */
  fetch?: FetchLike;
  /**
   * Adds a product, such as `my-tool/1.2`, to the User-Agent header. Node
   * only: a browser sends its own.
   */
  userAgent?: string;
  /**
   * How often a retryable call is sent at most, the first attempt
   * included; 1 turns retries off. The default, and what 0 means, is 5.
   */
  maxAttempts?: number;
}

/** What a platform's entry point supplies when the options leave it out. @internal */
export interface PlatformDefaults {
  credentials(): Credentials;
  region(): string;
  /** The User-Agent header, or `undefined` where it can't be set. */
  userAgent(product: string | undefined): string | undefined;
}

/**
 * What the clients of every service share: credentials, endpoints, the
 * `fetch` calls are sent with and the consistency token. A program creates
 * one and hands it to the clients of the services it uses.
 */
export class ClientBase {
  /** The credentials calls are sent with. */
  readonly credentials: Credentials;
  /** The region whose front doors calls go to; empty for the regionless ones. */
  readonly region: string;
  /** How often a retryable call is sent at most. */
  readonly maxAttempts: number;
  /** The User-Agent header; `undefined` in a browser. @internal */
  readonly userAgent: string | undefined;
  /** The `fetch` calls are sent with; the platform's when undefined. @internal */
  readonly fetch: FetchLike | undefined;
  private readonly endpoint: string | undefined;

  /**
   * The consistency token the client holds: the one the last mutation or
   * finished operation answered with, or empty before any. Hand it to
   * another client, in this process or another, for its reads to show this
   * client's writes. The API merges a mutation's position into the token
   * the mutation presented, so a client keeps every write it made since.
   */
  consistencyToken = "";

  protected constructor(options: ClientOptions, defaults: PlatformDefaults) {
    this.maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error(`origincloud: the most attempts must be at least 1, got ${options.maxAttempts}`);
    }
    if (options.endpoint) {
      let parsed: URL | undefined;
      try {
        parsed = new URL(options.endpoint);
      } catch {
        parsed = undefined;
      }
      if (!parsed || !parsed.host) {
        throw new Error(`origincloud: the endpoint must be an absolute URL, got ${JSON.stringify(options.endpoint)}`);
      }
      this.endpoint = options.endpoint.replace(/\/+$/, "");
    }
    this.region = options.region ?? defaults.region();
    // The region becomes part of a host name the token is sent to: only a
    // plain region code, such as `eu-central1`, may get there.
    if (this.region && !/^[a-z0-9-]+$/.test(this.region)) {
      throw new Error(`origincloud: the region must be a region code such as eu-central1, got ${JSON.stringify(this.region)}`);
    }
    this.userAgent = defaults.userAgent(options.userAgent);
    this.fetch = options.fetch;
    this.credentials = options.credentials ? toCredentials(options.credentials) : defaults.credentials();
  }

  /**
   * The endpoint of the service whose host starts with `shortcode`, such as
   * `pvs`. A regional service answers at its region's front door when the
   * client has a region; a global one always at its regionless host.
   * Generated clients call it.
   */
  service(shortcode: string, regional = !GLOBAL_SERVICES.has(shortcode)): Service {
    if (this.endpoint) return new Service(this, this.endpoint);
    const host =
      regional && this.region ? `${shortcode}.${this.region}.origincloudapis.eu` : `${shortcode}.origincloudapis.eu`;
    return new Service(this, `https://${host}`);
  }
}
