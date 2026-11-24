/**
 * The Origin Cloud SDK's core for Node: what every service package shares
 * (credentials, endpoints, retries, errors, long-running operations and
 * read-your-writes), with credentials found in the environment, a service
 * account key's credentials file, a CI job's
 * OIDC token, the `origin` CLI's session or the instance's metadata service.
 *
 * @packageDocumentation
 */
import { ClientBase, type ClientOptions, VERSION } from "./client.js";
import { impersonating } from "./impersonation.js";
import { defaultCredentials } from "./node-credentials.js";
export {
  ImpersonatedCredentials,
  type ImpersonationOptions,
  impersonate,
} from "./impersonation.js";
export {
  ServiceAccountKeyCredentials,
  type ServiceAccountKeyOptions,
  credentialsFile,
} from "./service-account-key.js";

export * from "./common.js";
export {
  type CLISession,
  CLISessionCredentials,
  FederatedCredentials,
  type FederatedOptions,
  type GitHubActionsOptions,
  InstanceMetadataCredentials,
  type InstanceMetadataOptions,
  METADATA_ENDPOINT,
  NoCredentialsError,
  OIDC_AUDIENCE,
  STS_ENDPOINT,
  type SubjectTokenSource,
  cliSession,
  cliSessionPath,
  defaultCredentials,
  federated,
  githubActions,
  instanceMetadata,
  oidcToken,
  oidcTokenFile,
} from "./node-credentials.js";

/** How a {@link Client} is configured in Node. */
export interface NodeClientOptions extends ClientOptions {
  /**
   * The full name of a service account to act as,
   * `//iam.origincloudapis.eu/organizations/{organization}/serviceAccounts/{serviceAccount}`:
   * the credentials' tokens are exchanged at the STS for the account's
   * ({@link ImpersonatedCredentials}). It overrides
   * `ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT`; an empty name impersonates
   * no one. The caller needs `roles/iam.service-account-token-creator` on
   * the account.
   */
  impersonateServiceAccount?: string;
}

/**
 * What the clients of every service share. Unless `credentials` names
 * them, it takes the first of `ORIGINCLOUD_ACCESS_TOKEN`, the service
 * account key's credentials file `ORIGINCLOUD_CREDENTIALS_FILE` names, a CI job's OIDC
 * token exchanged at the STS, the `origin` CLI's session, and the
 * instance's metadata service
 * ({@link defaultCredentials}), and throws when there is none.
 * `ORIGINCLOUD_REGION` picks a region unless `region` does.
 *
 * With `impersonateServiceAccount`, or else
 * `ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT`, set, the credentials' tokens
 * are exchanged at the STS for that service account's
 * ({@link ImpersonatedCredentials}), and calls are sent as the account.
 */
export class Client extends ClientBase {
  constructor(options: NodeClientOptions = {}) {
    const { impersonateServiceAccount, ...rest } = options;
    super(rest, {
      credentials: defaultCredentials,
      wrapCredentials: (credentials) => impersonating(credentials, impersonateServiceAccount),
      region: () => process.env["ORIGINCLOUD_REGION"] ?? "",
      userAgent: (product) => (product ? product + " " : "") + `origincloud-sdk-typescript/${VERSION}`,
    });
  }
}
