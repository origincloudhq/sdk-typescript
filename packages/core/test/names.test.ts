import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANY_SERVICE,
  Client,
  FullName,
  FullNameError,
  type FullNameReason,
  type Principal,
  RESOURCE_SERVICES,
  accessToken,
} from "@origincloud/core";

const VOLUME = "//pvs.origincloudapis.eu/projects/shop-123456/zones/eu-central1-az1/volumes/vol-RAiXDqjUHLh";
const VOLUME_RELATIVE = "projects/shop-123456/zones/eu-central1-az1/volumes/vol-RAiXDqjUHLh";

/** Asserts that `f` throws a FullNameError for `reason`, and returns its message. */
function refused(f: () => unknown, reason: FullNameReason, label: string): string {
  try {
    f();
  } catch (err) {
    assert.ok(err instanceof FullNameError, `${label}: ${String(err)}`);
    assert.equal(err.reason, reason, `${label}: ${err.message}`);
    return err.message;
  }
  assert.fail(`${label}: not refused`);
}

test("the services are the APIs with resources", () => {
  assert.deepEqual(RESOURCE_SERVICES, [
    "billing",
    "compute",
    "dns",
    "iam",
    "kms",
    "location",
    "network",
    "pvs",
    "resourcemanager",
    "secretmanager",
    "support",
  ]);
  assert.ok(Object.isFrozen(RESOURCE_SERVICES));
});

test("a full name parses into its service and relative name", () => {
  const name = FullName.parse(VOLUME);
  assert.equal(name.service, "pvs");
  assert.equal(name.host, "pvs.origincloudapis.eu");
  assert.equal(name.relative, VOLUME_RELATIVE);
  assert.equal(name.toString(), VOLUME);
  assert.equal(`${name}`, VOLUME);
});

test("full and relative convert by concatenation", () => {
  const name = FullName.fromRelative("pvs", VOLUME_RELATIVE);
  assert.equal(name.toString(), VOLUME);
  assert.ok(name.equals(FullName.parse(VOLUME)));
  for (const service of RESOURCE_SERVICES) {
    const n = FullName.fromRelative(service, "projects/p");
    assert.equal(n.toString(), `//${service}.origincloudapis.eu/projects/p`);
    assert.equal(n.service, service);
    assert.equal(n.relative, "projects/p");
    assert.ok(FullName.parse(n.toString()).equals(n));
  }
  assert.ok(!FullName.fromRelative("pvs", "projects/p").equals(FullName.fromRelative("compute", "projects/p")));
});

test("the URL adds the scheme and the version", () => {
  const name = FullName.parse(VOLUME);
  assert.equal(name.url("v1beta1"), `https://pvs.origincloudapis.eu/v1beta1/${VOLUME_RELATIVE}`);
  assert.equal(name.url("v2"), `https://pvs.origincloudapis.eu/v2/${VOLUME_RELATIVE}`);
  for (const notAVersion of ["", "v", "1", "V1", "v0", "v01", "v1gamma1", "v1/", "volumes"]) {
    refused(() => name.url(notAVersion), "notAVersion", notAVersion);
  }
});

test("names the platform uses parse", () => {
  for (const name of [
    "//iam.origincloudapis.eu/users/2f0a6c0e-7d0e-4f4b-9b8a-0c6f4e1d2a3b",
    "//iam.origincloudapis.eu/users/me",
    "//iam.origincloudapis.eu/roles/iam.editor",
    "//iam.origincloudapis.eu/roles/pvs.volume_admin",
    "//iam.origincloudapis.eu/permissions/pvs.volume.create",
    "//iam.origincloudapis.eu/organizations/o-1/serviceAccounts/9a1b",
    "//iam.origincloudapis.eu/serviceAgents/compute",
    "//iam.origincloudapis.eu/services/admin",
    "//resourcemanager.origincloudapis.eu/projects/shop-123456",
    "//billing.origincloudapis.eu/organizations/o/billingAccounts/ba/spendLimit",
    "//kms.origincloudapis.eu/projects/p/regions/eu-central1/keys/key-RAiXDqjUHLh/versions/1",
    "//location.origincloudapis.eu/zones/eu-central1-az1",
    "//billing.origincloudapis.eu/legalDocuments/terms/versions/2026-12",
    "//compute.origincloudapis.eu/zones/eu-central1-az1/images/img~1_a.b",
    // A version is refused only as the first segment.
    "//kms.origincloudapis.eu/projects/v1/regions/r/keys/k",
    "//billing.origincloudapis.eu/legalDocuments/v1",
  ]) {
    assert.equal(FullName.parse(name).toString(), name);
  }
});

test("refusals name their reason", () => {
  const cases: [string, FullNameReason, string?][] = [
    // Not a full name at all.
    ["urn:origincloud:storage:o-1:p-1:volume:vol-1", "urn", "is a URN"],
    ["URN:origincloud:storage:volume:vol-1", "urn"],
    ["https://pvs.origincloudapis.eu/projects/p", "scheme", "is a URL"],
    ["https://pvs.origincloudapis.eu/v1beta1/projects/p", "scheme"],
    ["pvs://projects/p", "scheme"],
    [VOLUME_RELATIVE, "relative", "is a relative resource name"],
    ["/projects/p", "relative"],
    ["pvs.origincloudapis.eu/projects/p", "relative"],
    ["vol-RAiXDqjUHLh", "bareId", "is an id"],
    // The host.
    ["//example.com/projects/p", "unknownService", "example.com is not the host of one of the platform's APIs"],
    ["//pvs.origincloudapis.com/projects/p", "unknownService"],
    ["//PVS.origincloudapis.eu/projects/p", "unknownService"],
    ["//pvs.origincloudapis.eu:443/projects/p", "unknownService"],
    ["//sts.origincloudapis.eu/projects/p", "unknownService"],
    ["//observability.origincloudapis.eu/projects/p", "unknownService"],
    ["//graph.origincloudapis.eu/projects/p", "unknownService"],
    ["//origincloudapis.eu/projects/p", "unknownService"],
    ["///projects/p", "unknownService"],
    ["//pvs.eu-central1-az1.origincloudapis.eu/projects/p", "notGlobalHost", "the service's global host, pvs.origincloudapis.eu"],
    ["//network.eu-central1.origincloudapis.eu/projects/p", "notGlobalHost", "network.origincloudapis.eu"],
    // No relative name.
    ["//pvs.origincloudapis.eu", "noRelativeName"],
    ["//pvs.origincloudapis.eu/", "noRelativeName"],
    ["//", "unknownService"],
    // A version.
    ["//pvs.origincloudapis.eu/v1beta1/projects/p", "version", 'the API version "v1beta1"'],
    ["//pvs.origincloudapis.eu/v1/projects/p", "version", 'the API version "v1"'],
    // The segments.
    ["//pvs.origincloudapis.eu/projects/p/", "trailingSlash"],
    ["//pvs.origincloudapis.eu/projects//p", "emptySegment"],
    ["//pvs.origincloudapis.eu//projects/p", "emptySegment"],
    ["//pvs.origincloudapis.eu/projects/./volumes", "dotSegment", 'the segment "."'],
    ["//pvs.origincloudapis.eu/projects/p/../q", "dotSegment", 'the segment ".."'],
    ["//pvs.origincloudapis.eu/projects/p q", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/p%2Fq", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/p?view=full", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/p#x", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/p:q", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/pä", "invalidSegment"],
    ["//pvs.origincloudapis.eu/projects/p\n", "invalidSegment"],
  ];
  for (const [name, reason, says] of cases) {
    const message = refused(() => FullName.parse(name), reason, JSON.stringify(name));
    assert.ok(message.includes(JSON.stringify(name)), message);
    if (says) assert.ok(message.includes(says), message);
  }
  refused(() => FullName.parse(""), "empty", "empty");
});

test("fromRelative refuses what parse refuses in a relative name", () => {
  const cases: [string, FullNameReason][] = [
    ["", "noRelativeName"],
    ["/projects/p", "emptySegment"],
    ["projects/p/", "trailingSlash"],
    ["projects//p", "emptySegment"],
    ["projects/..", "dotSegment"],
    ["v1beta1/projects/p", "version"],
    ["projects/p q", "invalidSegment"],
    [VOLUME, "notRelative"],
  ];
  for (const [relative, reason] of cases) refused(() => FullName.fromRelative("pvs", relative), reason, relative);
  for (const service of ["sts", "observability", "graph", "", "PVS", "pvs.origincloudapis.eu"]) {
    refused(() => FullName.fromRelative(service, "projects/p"), "unknownService", service);
  }
});

test("JSON gives the full form", () => {
  assert.equal(JSON.stringify({ volume: FullName.parse(VOLUME) }), `{"volume":"${VOLUME}"}`);
});

test("each principal kind has its own form", () => {
  const cases: [string, Principal][] = [
    ["//iam.origincloudapis.eu/users/u-1", { kind: "user", user: "u-1" }],
    [
      "//iam.origincloudapis.eu/organizations/o-1/serviceAccounts/sa-1",
      { kind: "serviceAccount", organization: "o-1", serviceAccount: "sa-1" },
    ],
    ["//iam.origincloudapis.eu/serviceAgents/compute", { kind: "serviceAgent", serviceAgent: "compute" }],
    ["//iam.origincloudapis.eu/services/admin", { kind: "service", service: "admin" }],
  ];
  for (const [full, principal] of cases) {
    const name = FullName.parse(full);
    assert.deepEqual(name.principal(), principal, full);
    assert.ok(FullName.ofPrincipal(principal).equals(name), full);
    assert.equal(name.role(), undefined, full);
  }
  for (const full of [
    // The organisation principal is not decided.
    "//iam.origincloudapis.eu/organizations/o-1",
    "//resourcemanager.origincloudapis.eu/organizations/o-1",
    // A principal's spelling on another service.
    "//resourcemanager.origincloudapis.eu/users/u-1",
    // A child of a principal.
    "//iam.origincloudapis.eu/organizations/o/serviceAccounts/sa/federatedCredentials/f",
    "//iam.origincloudapis.eu/users/u-1/sessions/s",
    "//iam.origincloudapis.eu/roles/iam.editor",
  ]) {
    assert.equal(FullName.parse(full).principal(), undefined, full);
  }
  for (const principal of [
    { kind: "user", user: "u/1" },
    { kind: "serviceAccount", organization: "o", serviceAccount: "sa/keys/k" },
    { kind: "serviceAgent", serviceAgent: "a/b" },
    { kind: "service", service: "" },
  ] as Principal[]) {
    assert.throws(() => FullName.ofPrincipal(principal), FullNameError, JSON.stringify(principal));
  }
});

test("a role is named with dots and never slashes", () => {
  const role = FullName.parse("//iam.origincloudapis.eu/roles/iam.editor");
  assert.equal(role.role(), "iam.editor");
  assert.equal(role.principal(), undefined);
  assert.ok(FullName.ofRole("iam.editor").equals(role));
  assert.equal(FullName.parse("//iam.origincloudapis.eu/roles/iam/editor").role(), undefined);
  assert.equal(FullName.parse("//resourcemanager.origincloudapis.eu/roles/iam.editor").role(), undefined);
  refused(() => FullName.ofRole("iam/editor"), "invalidSegment", "iam/editor");
  refused(() => FullName.ofRole(""), "trailingSlash", "an empty role");
});

const client = new Client({ endpoint: "https://example.test", credentials: accessToken("t") });
const VOLUME_PATTERN = "projects/*/zones/*/volumes/*";

// A path field takes a relative name, or a full name of the client's own
// service, which is sent as its relative name.
test("a path field takes the relative name, or a full name of the client's own service", () => {
  const volumes = client.service("pvs");
  for (const [value, sent] of [
    [VOLUME, VOLUME_RELATIVE],
    [VOLUME_RELATIVE, VOLUME_RELATIVE],
    // A relative name is checked and escaped as before.
    ["projects/p 1/zones/z/volumes/v", "projects/p%201/zones/z/volumes/v"],
  ]) {
    assert.equal(volumes.pathValue("name", value, VOLUME_PATTERN), sent, value);
  }
  assert.throws(() => volumes.pathValue("name", "", VOLUME_PATTERN), /name must have the form/);
  assert.throws(() => volumes.pathValue("name", undefined, VOLUME_PATTERN), /name must have the form/);
});

test("a path field refuses another host's full name, or no valid full name", () => {
  const volumes = client.service("pvs");
  const cases: [string, FullNameReason, string][] = [
    [
      "//compute.origincloudapis.eu/projects/p/zones/z/volumes/v",
      "otherService",
      "name must be a name on pvs.origincloudapis.eu, got",
    ],
    ["//resourcemanager.origincloudapis.eu/projects/p", "otherService", "a name on resourcemanager.origincloudapis.eu"],
    [
      "//pvs.eu-central1-az1.origincloudapis.eu/projects/p/zones/z/volumes/v",
      "notGlobalHost",
      "the service's global host, pvs.origincloudapis.eu",
    ],
    ["//pvs.eu-central1.origincloudapis.eu/projects/p/zones/z/volumes/v", "notGlobalHost", "the service's global host"],
    ["//pvs.origincloudapis.eu/v1beta1/projects/p/zones/z/volumes/v", "version", "carries the API version"],
    ["urn:origincloud:storage:o:p:volume:v", "urn", "is a URN"],
    ["https://pvs.origincloudapis.eu/v1beta1/projects/p/zones/z/volumes/v", "scheme", "is a URL"],
    ["//pvs.origincloudapis.eu/projects/p/zones/z/volumes/", "trailingSlash", "ends with a '/'"],
    ["//pvs.origincloudapis.eu/projects/p q/zones/z/volumes/v", "invalidSegment", "has the segment"],
    ["//example.com/projects/p", "unknownService", "is not the host of one of the platform's APIs"],
  ];
  for (const [value, reason, says] of cases) {
    const message = refused(() => volumes.pathValue("name", value, VOLUME_PATTERN), reason, value);
    assert.ok(message.startsWith("origincloud: name"), message);
    assert.ok(message.includes(says), message);
  }
  // A service with no resources takes no full name at all.
  assert.throws(
    () => client.service("observability").pathValue("parent", "//observability.origincloudapis.eu/projects/p", "projects/*"),
    FullNameError,
  );
});

// A path field referring to another service's type takes that service's
// full names, and no other's.
test("a path field is checked against the type it refers to", () => {
  const project = "//resourcemanager.origincloudapis.eu/projects/p";
  for (const own of ["billing", "observability"]) {
    const service = client.service(own);
    for (const value of [project, "projects/p"]) {
      assert.equal(service.pathValue("parent", value, "projects/*", ["resourcemanager"]), "projects/p", `${own} ${value}`);
    }
    const message = refused(
      () => service.relativeName("parent", "//pvs.origincloudapis.eu/projects/p", ["resourcemanager"]),
      "otherService",
      own,
    );
    assert.ok(message.includes("parent must be a name on resourcemanager.origincloudapis.eu, got"), message);
    // The client's own host isn't one the field takes.
    assert.throws(
      () => service.relativeName("parent", `//${own}.origincloudapis.eu/projects/p`, ["resourcemanager"]),
      /^FullNameError: origincloud: parent must be a name on resourcemanager\.origincloudapis\.eu/,
    );
  }
  assert.throws(
    () => client.service("iam").relativeName("parent", "//pvs.origincloudapis.eu/zones/z", ["compute", "location"]),
    /must be a name on one of compute\.origincloudapis\.eu, location\.origincloudapis\.eu/,
  );
  for (const value of [VOLUME, project]) {
    assert.ok(client.service("iam").relativeName("resource", value, [ANY_SERVICE]), value);
  }
  refused(() => client.service("iam").relativeName("resource", "//sts.origincloudapis.eu/x/y", [ANY_SERVICE]), "unknownService", "sts");
});
