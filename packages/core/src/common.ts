// What both entry points export: everything but where credentials come
// from by default.
export { ClientBase, type ClientOptions, type PlatformDefaults, VERSION } from "./client.js";
export {
  type Credentials,
  type FetchLike,
  type GrantedToken,
  type TokenEndpointOptions,
  type TokenSource,
  ServiceAccountCredentials,
  TOKEN_URL,
  accessToken,
  serviceAccount,
} from "./credentials.js";
export { type FieldViolation, OriginCloudError, reasonOf } from "./errors.js";
export { type Any, type Empty, type LongrunningOperation, Operation, type Status } from "./operation.js";
export {
  type CallOptions,
  CONSISTENCY_TOKEN_HEADER,
  type HttpMethod,
  type Request,
  Service,
  newRequestId,
  pathValue,
  query,
} from "./transport.js";
