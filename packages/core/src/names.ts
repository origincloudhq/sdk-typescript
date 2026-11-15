// Full resource names (AIP-122), the platform's identifiers:
// `//{service}.origincloudapis.eu/{relative name}`.
import { RESOURCE_SERVICES } from "./generated/resource-services.js";

export { RESOURCE_SERVICES };

/** The domain every service's host is under. */
export const DOMAIN = "origincloudapis.eu";

/**
 * Why a string is not a full resource name, or not one that can be used
 * where it was given: the `reason` of a {@link FullNameError}.
 */
export type FullNameReason =
  | "empty"
  | "urn"
  | "scheme"
  | "relative"
  | "bareId"
  | "unknownService"
  | "notGlobalHost"
  | "version"
  | "noRelativeName"
  | "notRelative"
  | "trailingSlash"
  | "emptySegment"
  | "dotSegment"
  | "invalidSegment"
  | "notAVersion"
  | "otherService";

/** A string refused as a full resource name, with the reason. */
export class FullNameError extends Error {
  /** Why it was refused. */
  readonly reason: FullNameReason;
  /** What was given. */
  readonly value: string;

  constructor(reason: FullNameReason, value: string, message: string) {
    super(`origincloud: ${message}`);
    this.name = "FullNameError";
    this.reason = reason;
    this.value = value;
  }
}

/**
 * Who acts: a member of a role binding, or the actor of an audit entry.
 * Each is an iam full name. An organisation acting on its own has no full
 * name yet, and so no kind.
 */
export type Principal =
  /** `//iam.origincloudapis.eu/users/{user}`. */
  | { kind: "user"; user: string }
  /** `//iam.origincloudapis.eu/organizations/{organization}/serviceAccounts/{serviceAccount}`. */
  | { kind: "serviceAccount"; organization: string; serviceAccount: string }
  /** A platform service acting in a customer's project: `//iam.origincloudapis.eu/serviceAgents/{serviceAgent}`. */
  | { kind: "serviceAgent"; serviceAgent: string }
  /** An internal platform service: `//iam.origincloudapis.eu/services/{service}`. */
  | { kind: "service"; service: string };

const json = JSON.stringify;

/**
 * A full resource name: `//`, the global host of the service that owns the
 * resource, `/` and its relative name, such as
 * `//pvs.origincloudapis.eu/projects/p/zones/eu-central1-az1/volumes/vol-1`,
 * with no scheme and no API version.
 *
 * A resource's `name` is its relative name; references in request bodies
 * are full names. A request's path fields (`name`, `parent`) take either: a
 * client given a full name of its own service sends its relative name, and
 * refuses one of another service before sending anything.
 *
 * Made only by {@link FullName.parse} or {@link FullName.fromRelative},
 * which refuse anything but the one canonical spelling, so two names are
 * {@link FullName.equals} exactly when they name the same resource.
 * `toString` and `toJSON` give the full form.
 */
export class FullName {
  /** The short code of the service that owns the resource, such as `pvs`. */
  readonly service: string;
  /** The service's host, such as `pvs.origincloudapis.eu`. */
  readonly host: string;
  /** The relative name, the resource's `name`: the full name without `//{host}/`. */
  readonly relative: string;

  private constructor(service: string, relative: string) {
    this.service = service;
    this.host = `${service}.${DOMAIN}`;
    this.relative = relative;
  }

  /**
   * Parses the full form, `//{host}/{relative}`, and nothing else.
   *
   * Refused: a URN, a URL (any scheme), a relative name, a bare id, a host
   * that isn't the global host of one of {@link RESOURCE_SERVICES} (a
   * regional or zonal one included), an API version as the first segment,
   * a trailing `/`, and an empty, `.`, `..` or otherwise invalid segment.
   */
  static parse(name: string): FullName {
    if (!name.startsWith("//")) throw notFull(name);
    const rest = name.slice(2);
    const slash = rest.indexOf("/");
    if (slash < 0) {
      serviceOfHost(name, rest);
      throw new FullNameError("noRelativeName", name, `${json(name)} has no relative name after its service`);
    }
    const service = serviceOfHost(name, rest.slice(0, slash));
    const relative = rest.slice(slash + 1);
    if (relative === "") {
      throw new FullNameError("noRelativeName", name, `${json(name)} has no relative name after its service`);
    }
    checkRelative(name, relative);
    return new FullName(service, relative);
  }

  /**
   * The full name of the resource `relative` (its `name`) of `service`, a
   * short code such as `pvs`: `//{service}.origincloudapis.eu/` +
   * `relative`.
   *
   * Refused: a service that isn't one of {@link RESOURCE_SERVICES}, a full
   * name given as the relative one, an API version as the first segment, a
   * trailing `/`, and an empty, `.`, `..` or otherwise invalid segment.
   */
  static fromRelative(service: string, relative: string): FullName {
    if (relative.startsWith("//")) {
      throw new FullNameError("notRelative", relative, `${json(relative)} is a full resource name; a relative one is expected here`);
    }
    if (!RESOURCE_SERVICES.includes(service)) {
      throw new FullNameError(
        "unknownService",
        relative,
        `${json(relative)} names no resource: ${service}.${DOMAIN} is not the host of one of the platform's APIs`,
      );
    }
    if (relative === "") {
      throw new FullNameError("noRelativeName", relative, `${json(relative)} has no relative name after its service`);
    }
    checkRelative(relative, relative);
    return new FullName(service, relative);
  }

  /** The full name of the principal `principal`. */
  static ofPrincipal(principal: Principal): FullName {
    let relative: string;
    let parts: string[];
    switch (principal.kind) {
      case "user":
        relative = `users/${principal.user}`;
        parts = [principal.user];
        break;
      case "serviceAccount":
        relative = `organizations/${principal.organization}/serviceAccounts/${principal.serviceAccount}`;
        parts = [principal.organization, principal.serviceAccount];
        break;
      case "serviceAgent":
        relative = `serviceAgents/${principal.serviceAgent}`;
        parts = [principal.serviceAgent];
        break;
      case "service":
        relative = `services/${principal.service}`;
        parts = [principal.service];
        break;
      default:
        throw new Error(`origincloud: ${json(principal)} is no principal`);
    }
    // A part with a "/" would make another name, of no principal.
    const slashed = parts.find((p) => p.includes("/"));
    if (slashed !== undefined) {
      throw new FullNameError("invalidSegment", relative, `${json(relative)} has the segment ${json(slashed)}, which a principal's id can't`);
    }
    return FullName.fromRelative("iam", relative);
  }

  /** The full name of the role `role`, such as `iam.editor`: `//iam.origincloudapis.eu/roles/iam.editor`. */
  static ofRole(role: string): FullName {
    if (role.includes("/")) {
      throw new FullNameError("invalidSegment", role, `${json(role)} has a '/': a role's id writes its parts with dots, such as iam.editor`);
    }
    return FullName.fromRelative("iam", `roles/${role}`);
  }

  /** The URL that calls the resource, `https://{host}/{version}/{relative}`, for an API version such as `v1beta1`. */
  url(version: string): string {
    if (!isVersion(version)) {
      throw new FullNameError("notAVersion", version, `${json(version)} is not an API version, such as v1 or v1beta1`);
    }
    return `https://${this.host}/${version}/${this.relative}`;
  }

  /** The principal the name is, if it is one. */
  principal(): Principal | undefined {
    if (this.service !== "iam") return undefined;
    const s = this.relative.split("/");
    if (s.length === 2 && s[0] === "users") return { kind: "user", user: s[1]! };
    if (s.length === 4 && s[0] === "organizations" && s[2] === "serviceAccounts") {
      return { kind: "serviceAccount", organization: s[1]!, serviceAccount: s[3]! };
    }
    if (s.length === 2 && s[0] === "serviceAgents") return { kind: "serviceAgent", serviceAgent: s[1]! };
    if (s.length === 2 && s[0] === "services") return { kind: "service", service: s[1]! };
    return undefined;
  }

  /**
   * The role's id if the name is a role, `//iam.origincloudapis.eu/roles/{role}`:
   * `iam.editor`. A role's id writes its parts with dots; `roles/iam/editor`
   * is no role.
   */
  role(): string | undefined {
    if (this.service !== "iam" || !this.relative.startsWith("roles/")) return undefined;
    const role = this.relative.slice("roles/".length);
    return role.includes("/") ? undefined : role;
  }

  /** Whether `other` names the same resource. */
  equals(other: FullName): boolean {
    return this.toString() === other.toString();
  }

  /** The full form. */
  toString(): string {
    return `//${this.host}/${this.relative}`;
  }

  /** The full form, as JSON writes a name. */
  toJSON(): string {
    return this.toString();
  }
}

/** The short code of the service whose global host is `host`; throws why there is none. */
function serviceOfHost(name: string, host: string): string {
  const suffix = "." + DOMAIN;
  const code = host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined;
  if (code !== undefined && RESOURCE_SERVICES.includes(code)) return code;
  // `{service}.{region or zone}.origincloudapis.eu`: a front door, not the
  // service's name.
  const dot = code?.indexOf(".") ?? -1;
  if (code !== undefined && dot > 0 && dot < code.length - 1 && RESOURCE_SERVICES.includes(code.slice(0, dot))) {
    throw new FullNameError(
      "notGlobalHost",
      name,
      `${json(name)} names ${host}; a full resource name has the service's global host, ${code.slice(0, dot)}.${DOMAIN}`,
    );
  }
  throw new FullNameError("unknownService", name, `${json(name)} names no resource: ${host} is not the host of one of the platform's APIs`);
}

/** Why `name`, which doesn't start with `//`, is not a full name. */
function notFull(name: string): FullNameError {
  if (name === "") return new FullNameError("empty", name, "an empty string names no resource");
  if (name.slice(0, 4).toLowerCase() === "urn:") {
    return new FullNameError("urn", name, `${json(name)} is a URN; a resource is named by its full resource name, //{service}.${DOMAIN}/{name}`);
  }
  if (name.includes("://")) {
    return new FullNameError("scheme", name, `${json(name)} is a URL; a full resource name has no scheme, //{service}.${DOMAIN}/{name}`);
  }
  if (name.includes("/")) {
    return new FullNameError("relative", name, `${json(name)} is a relative resource name; a full one starts with //{service}.${DOMAIN}/`);
  }
  return new FullNameError("bareId", name, `${json(name)} is an id; a resource is named by its full resource name, //{service}.${DOMAIN}/{name}`);
}

/** Checks a non-empty relative name; `name` is what an error reports. */
function checkRelative(name: string, relative: string): void {
  if (relative.endsWith("/")) throw new FullNameError("trailingSlash", name, `${json(name)} ends with a '/'`);
  const segments = relative.split("/");
  if (isVersion(segments[0]!)) {
    throw new FullNameError("version", name, `${json(name)} carries the API version ${json(segments[0])}; a full resource name has none`);
  }
  for (const segment of segments) {
    if (segment === "") throw new FullNameError("emptySegment", name, `${json(name)} has an empty segment`);
    if (segment === "." || segment === "..") {
      throw new FullNameError("dotSegment", name, `${json(name)} has the segment ${json(segment)}, which a resource name can't`);
    }
    // RFC 3986's unreserved characters, so that a name is a URL path as it is.
    if (!/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new FullNameError(
        "invalidSegment",
        name,
        `${json(name)} has the segment ${json(segment)}: a segment is letters, digits and '-', '.', '_' or '~'`,
      );
    }
  }
}

/** Whether `segment` reads as an API version (AIP-185): `v{major}`, optionally followed by `alpha` or `beta` and a number. */
function isVersion(segment: string): boolean {
  return /^v[1-9][0-9]*((alpha|beta)[0-9]*)?$/.test(segment);
}

/** Among the services a path field takes, every resource service: a field referring to any type. */
export const ANY_SERVICE = "*";

/** The hosts of `services`, for an error. */
function hostsOf(services: readonly string[]): string {
  if (services.includes(ANY_SERVICE)) return "the host of one of the platform's APIs";
  const hosts = services.map((s) => `${s}.${DOMAIN}`);
  return hosts.length === 1 ? hosts[0]! : `one of ${hosts.join(", ")}`;
}

/**
 * The relative name to send in a request's path for `value`, the path
 * field `field` of a call to the service `own` (a short code), which takes
 * full names of `services`: the services of the type it refers to,
 * {@link ANY_SERVICE} for any, or none for `own`. `value` is sent as it is
 * when it isn't a full name, and as its relative name when it is one of
 * those services'; throws, naming the hosts the field takes, when it is
 * another service's, a URN, a URL or no valid full name.
 */
export function pathName(own: string, services: readonly string[], field: string, value: string): string {
  const accepted = services.length === 0 ? [own] : services;
  const refused = (err: FullNameError) =>
    new FullNameError(err.reason, err.value, `${field} must be a name on ${hostsOf(accepted)}: ${err.message.replace(/^origincloud: /, "")}`);
  if (!value.startsWith("//")) {
    const err = notFull(value);
    if (err.reason === "urn" || err.reason === "scheme") throw refused(err);
    return value;
  }
  let name: FullName;
  try {
    name = FullName.parse(value);
  } catch (err) {
    throw err instanceof FullNameError ? refused(err) : err;
  }
  if (!accepted.includes(ANY_SERVICE) && !accepted.includes(name.service)) {
    throw new FullNameError(
      "otherService",
      value,
      `${field} must be a name on ${hostsOf(accepted)}, got ${json(value)}, a name on ${name.host}`,
    );
  }
  return name.relative;
}
