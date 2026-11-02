import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { FileDescriptor, FileDescriptorSet } from "./descriptors.js";
import { describe, firstSentence, humanize, parentPattern, scaffold, summary, withReference, withRows, withWorkspace } from "./scaffold.js";

const repository = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function resource(name: string, pattern: string, plural: string) {
  return { name, options: { "[google.api.resource]": { pattern: [pattern], plural } } };
}

/** A package of several services, its comments with spellings to find, one inside backticks only. */
const network: FileDescriptor = {
  name: "origincloud/example/v1beta1/network.proto",
  package: "origincloud.example.v1beta1",
  dependency: ["origincloud/longrunning/v1beta1/operations.proto"],
  messageType: [
    resource("Vpc", "projects/{project}/regions/{region}/vpcs/{vpc}", "vpcs"),
    resource("Acl", "projects/{project}/regions/{region}/acls/{acl}", "acls"),
    resource("AclRule", "projects/{project}/regions/{region}/acls/{acl}/rules/{rule}", "aclRules"),
    resource("FloatingIp", "projects/{project}/zones/{zone}/floatingIps/{floating_ip}", "floatingIps"),
    resource("Quota", "projects/{project}/quota", "quotas"),
    resource("Project", "projects/{project}", "projects"),
  ],
  service: [
    {
      name: "VpcService",
      options: { "[google.api.default_host]": "example.origincloudapis.eu" },
      method: [
        { name: "ListVpcs", inputType: ".x", outputType: ".x", options: { "[google.api.http]": { get: "/v1beta1/{parent=projects/*/regions/*}/vpcs" } } },
        { name: "GetVpc", inputType: ".x", outputType: ".x", options: { "[google.api.http]": { get: "/v1beta1/{name=projects/*/regions/*/vpcs/*}" } } },
      ],
    },
    { name: "AclService", options: { "[google.api.default_host]": "example.origincloudapis.eu" } },
  ],
  sourceCodeInfo: {
    location: [
      { path: [6, 0], leadingComments: " VPCs: private networks, `projects/{project}/regions/{region}/vpcs/{vpc}`; vpcs.\n" },
      { path: [6, 1], leadingComments: " ACLs: filters. Floating IPs are elsewhere.\n" },
    ],
  },
};

test("several services are described by their resources, but those within another, spelled as their comments' prose", () => {
  const d = describe({ file: [network] }, "example");
  assert.equal(d.what, "VPCs, ACLs, floating IPs and projects");
  assert.deepEqual(d.versions, ["v1beta1"]);
  assert.equal(summary(d), "Origin Cloud's example service: VPCs, ACLs, floating IPs and projects.");
});

test("one service is described by its comment's first sentence, and a package comment comes first", () => {
  const one: FileDescriptor = {
    name: "origincloud/location/v1/location.proto",
    package: "origincloud.location.v1",
    service: [{ name: "LocationService" }],
    sourceCodeInfo: {
      location: [{ path: [6, 0], leadingComments: " The platform's regions and zones, and which\n services each zone offers. More.\n\n Even more.\n" }],
    },
  };
  assert.equal(summary(describe({ file: [one] }, "location")), "Origin Cloud's location service: the platform's regions and zones, and which services each zone offers.");

  const packaged: FileDescriptor = {
    ...one,
    package: "origincloud.iam.v1",
    sourceCodeInfo: { location: [...one.sourceCodeInfo!.location!, { path: [2], leadingComments: " Who may do what (-- api-linter: x --) in `organizations`.\n" }] },
  };
  assert.equal(summary(describe({ file: [packaged] }, "iam")), "Origin Cloud's IAM service: who may do what in organizations.");
});

test("a package that says nothing names only itself", () => {
  const empty: FileDescriptor = { name: "origincloud/empty/v1/a.proto", package: "origincloud.empty.v1", service: [{ name: "A" }, { name: "B" }] };
  assert.equal(summary(describe({ file: [empty] }, "empty")), "Origin Cloud's empty service.");
});

test("helpers", () => {
  assert.equal(humanize("keyPairs"), "key pairs");
  assert.equal(parentPattern("projects/{project}/keyPairs/{key_pair}"), "projects/{project}");
  assert.equal(parentPattern("projects/{project}/quota"), "projects/{project}");
  assert.equal(parentPattern("roles/{role}"), "");
  assert.equal(firstSentence("A. B.\n\nC."), "A");
  assert.equal(firstSentence("Ends here."), "Ends here");
  const one = (comment: string): FileDescriptor => ({
    name: "origincloud/one/v1/one.proto",
    package: "origincloud.one.v1",
    service: [{ name: "OneService" }],
    sourceCodeInfo: { location: [{ path: [6, 0], leadingComments: comment }] },
  });
  assert.equal(describe({ file: [one(" A service of its own.\n")] }, "one").what, "a service of its own");
  assert.equal(describe({ file: [one(" VPCs and more.\n")] }, "one").what, "VPCs and more");
});

test("a new package is scaffolded as packages/location is, and added to the workspace, the references and the README", () => {
  const set: FileDescriptorSet = { file: [network] };
  const files = scaffold(set, repository, ["example"]);
  assert.deepEqual([...files.keys()].sort(), [
    "README.md",
    "package.json",
    "packages/example/LICENSE",
    "packages/example/README.md",
    "packages/example/package.json",
    "packages/example/test/client.test.ts",
    "packages/example/tsconfig.json",
    "tsconfig.json",
    "tsconfig.test.json",
  ]);

  const pkg = JSON.parse(files.get("packages/example/package.json")!) as Record<string, unknown>;
  assert.equal(pkg["name"], "@origincloud/example");
  assert.equal(pkg["description"], "Origin Cloud's example service: VPCs, ACLs, floating IPs and projects.");
  assert.deepEqual(pkg["keywords"], ["origincloud", "origin-cloud", "sdk", "example"]);

  const clientTest = files.get("packages/example/test/client.test.ts")!;
  assert.match(clientTest, /import \{ VpcClient \} from "@origincloud\/example\/v1beta1";/);
  assert.match(clientTest, /await new VpcClient\(client\)\.getVpc\(\{ name: "projects\/x\/regions\/x\/vpcs\/x" \}\);/);
  assert.match(clientTest, /\["https:\/\/example\.origincloudapis\.eu\/v1beta1\/projects\/x\/regions\/x\/vpcs\/x"\]/);

  assert.match(files.get("packages/example/README.md")!, /const vpcs = new VpcClient\(new Client\(\)\);/);
  assert.match(files.get("packages/example/README.md")!, /\| `@origincloud\/example\/longrunning\/v1beta1` \| Example operations, for resuming one by name \|/);
  assert.match(
    files.get("README.md")!,
    /\| `@origincloud\/example` \| `@origincloud\/example\/v1beta1` \| VPCs, ACLs, floating IPs and projects \|\n\| \| `@origincloud\/example\/longrunning\/v1beta1` \|/,
  );
  assert.match(files.get("tsconfig.test.json")!, /\{ "path": "packages\/example" \}\n/);
  assert.ok((JSON.parse(files.get("package.json")!) as { workspaces: string[] }).workspaces.includes("packages/example"));
});

test("a reference is added after the last package's, with its commas", () => {
  assert.equal(
    withReference('{\n  "references": [\n    { "path": "packages/core" },\n    { "path": "generator" }\n  ]\n}\n', "packages/x"),
    '{\n  "references": [\n    { "path": "packages/core" },\n    { "path": "packages/x" },\n    { "path": "generator" }\n  ]\n}\n',
  );
  assert.equal(
    withReference('{\n  "references": [\n    { "path": "packages/core" }\n  ]\n}\n', "packages/x"),
    '{\n  "references": [\n    { "path": "packages/core" },\n    { "path": "packages/x" }\n  ]\n}\n',
  );
  assert.throws(() => withReference("{}\n", "packages/x"));
});

test("a row ends its table, once", () => {
  const readme = "# SDK\n\n| Package | Import | API |\n|---|---|---|\n| a | b | c |\n\nMore.\n";
  assert.equal(
    withRows(readme, "| Package | Import | API |", ["| a | b | c |", "| d | e | f |"]),
    "# SDK\n\n| Package | Import | API |\n|---|---|---|\n| a | b | c |\n| d | e | f |\n\nMore.\n",
  );
  assert.throws(() => withRows("# SDK\n", "| Package | Import | API |", []));
  assert.equal(withWorkspace('{\n  "workspaces": [\n    "packages/core"\n  ]\n}\n', "packages/x"), '{\n  "workspaces": [\n    "packages/core",\n    "packages/x"\n  ]\n}\n');
});
