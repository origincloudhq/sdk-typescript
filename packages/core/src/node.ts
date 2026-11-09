/**
 * The Origin Cloud SDK's core for Node: what every service package shares
 * (credentials, endpoints, retries, errors, long-running operations and
 * read-your-writes), with credentials found in the environment, the
 * `origin` CLI's session or the instance's metadata service.
 *
 * @packageDocumentation
 */
import { ClientBase, type ClientOptions, VERSION } from "./client.js";
import { defaultCredentials } from "./node-credentials.js";

export * from "./common.js";
export {
  type CLISession,
  CLISessionCredentials,
  InstanceMetadataCredentials,
  type InstanceMetadataOptions,
  METADATA_ENDPOINT,
  NoCredentialsError,
  cliSession,
  cliSessionPath,
  defaultCredentials,
  instanceMetadata,
} from "./node-credentials.js";

/**
 * What the clients of every service share. Unless `credentials` names
 * them, it takes the first of `ORIGINCLOUD_ACCESS_TOKEN`,
 * `ORIGINCLOUD_CLIENT_ID` with `ORIGINCLOUD_CLIENT_SECRET`, the `origin`
 * CLI's session, and the instance's metadata service
 * ({@link defaultCredentials}), and throws when there is none.
 * `ORIGINCLOUD_REGION` picks a region unless `region` does.
 */
export class Client extends ClientBase {
  constructor(options: ClientOptions = {}) {
    super(options, {
      credentials: defaultCredentials,
      region: () => process.env["ORIGINCLOUD_REGION"] ?? "",
      userAgent: (product) => (product ? product + " " : "") + `origincloud-sdk-typescript/${VERSION}`,
    });
  }
}
