/**
 * The Origin Cloud SDK's core for browsers: what every service package
 * shares (credentials, endpoints, retries, errors, long-running operations
 * and read-your-writes). The page supplies the credentials, such as its
 * OIDC session's access-token getter; nothing is read from an environment
 * or a file.
 *
 * @packageDocumentation
 */
import { ClientBase, type ClientOptions } from "./client.js";

export * from "./common.js";

/**
 * What the clients of every service share. In a browser `credentials` is
 * required: pass the function that returns the session's current access
 * token.
 */
export class Client extends ClientBase {
  constructor(options: ClientOptions = {}) {
    super(options, {
      credentials: () => {
        throw new Error(
          "origincloud: no credentials: in a browser, pass `credentials`, such as the OIDC session's access-token getter",
        );
      },
      region: () => "",
      userAgent: () => undefined,
    });
  }
}
