import assert from "node:assert/strict";
import { test } from "node:test";

import type { FieldDescriptor, FileDescriptor, FileDescriptorSet, MessageDescriptor } from "./descriptors.js";
import { ANY_SERVICE, Resources, generate } from "./main.js";

const httpBody: FileDescriptor = {
  name: "google/api/httpbody.proto",
  package: "google.api",
  messageType: [
    {
      name: "HttpBody",
      field: [
        { name: "content_type", jsonName: "contentType", type: "TYPE_STRING" },
        { name: "data", type: "TYPE_BYTES" },
      ],
    },
  ],
};

const date: FileDescriptor = {
  name: "google/type/date.proto",
  package: "google.type",
  messageType: [
    {
      name: "Date",
      field: [
        { name: "year", type: "TYPE_INT32" },
        { name: "month", type: "TYPE_INT32" },
        { name: "day", type: "TYPE_INT32" },
      ],
    },
  ],
};

/** A public service with a download, beside one that authenticates its callers, at one host. */
const legal: FileDescriptor = {
  name: "origincloud/billing/v1beta1/legal_document.proto",
  package: "origincloud.billing.v1beta1",
  dependency: ["google/api/httpbody.proto", "google/type/date.proto"],
  messageType: [
    {
      name: "LegalDocumentVersion",
      field: [
        { name: "name", type: "TYPE_STRING" },
        { name: "effective_date", jsonName: "effectiveDate", type: "TYPE_MESSAGE", typeName: ".google.type.Date" },
      ],
    },
    { name: "GetLegalDocumentVersionRequest", field: [{ name: "name", type: "TYPE_STRING" }] },
    { name: "DownloadLegalDocumentVersionRequest", field: [{ name: "name", type: "TYPE_STRING" }] },
  ],
  service: [
    {
      name: "LegalDocumentService",
      options: { "[google.api.default_host]": "billing.origincloudapis.eu" },
      method: [
        {
          name: "GetLegalDocumentVersion",
          inputType: ".origincloud.billing.v1beta1.GetLegalDocumentVersionRequest",
          outputType: ".origincloud.billing.v1beta1.LegalDocumentVersion",
          options: { "[google.api.http]": { get: "/v1beta1/{name=legalDocuments/*/versions/*}" } },
        },
        {
          name: "DownloadLegalDocumentVersion",
          inputType: ".origincloud.billing.v1beta1.DownloadLegalDocumentVersionRequest",
          outputType: ".google.api.HttpBody",
          options: { "[google.api.http]": { get: "/v1beta1/{name=legalDocuments/*/versions/*}:download" } },
        },
      ],
    },
    {
      name: "PriceListService",
      options: { "[google.api.default_host]": "billing.origincloudapis.eu" },
      method: [
        {
          name: "GetLegalDocumentVersion",
          inputType: ".origincloud.billing.v1beta1.GetLegalDocumentVersionRequest",
          outputType: ".origincloud.billing.v1beta1.LegalDocumentVersion",
          options: { "[google.api.http]": { get: "/v1beta1/{name=legalDocuments/*/versions/*}" } },
        },
      ],
    },
  ],
};

const set: FileDescriptorSet = { file: [httpBody, date, legal] };

/** The generated source of `method`'s body in the class `client`. */
function methodOf(source: string, client: string, method: string): string {
  const cls = source.slice(source.indexOf(`export class ${client} {`));
  const start = cls.indexOf(`  async ${method}(`);
  assert.ok(start >= 0, `${client}.${method} is generated`);
  return cls.slice(start, cls.indexOf("\n  }\n", start) + 4);
}

test("a method answering with a google.api.HttpBody downloads the file, and isn't read as JSON", () => {
  const source = generate(set).get("billing/src/v1beta1/legal_document.ts");
  assert.ok(source);
  const download = methodOf(source, "LegalDocumentClient", "downloadLegalDocumentVersion");
  assert.match(download, /Promise<HttpBody>/);
  assert.match(download, /return this\.service\.download\(/);
  assert.doesNotMatch(download, /service\.call/);
  assert.match(download, /path: `\/v1beta1\/\$\{p0\}:download`/);
  assert.match(download, /idempotent: true/);
  assert.match(source, /import \{[^}]*type HttpBody,[^}]*\} from "@origincloud\/core";/);
  // The SDK generates no google.api module: HttpBody is core's.
  assert.equal([...generate(set).keys()].filter((k) => k.includes("google")).length, 0);
});

test("a google.type.Date is core's CalendarDate", () => {
  const source = generate(set).get("billing/src/v1beta1/legal_document.ts")!;
  assert.match(source, /effectiveDate\?: CalendarDate;/);
  assert.match(source, /type CalendarDate,/);
});

test("a service named as unauthenticated sends its calls without credentials, and the host's other services with them", () => {
  const source = generate(set).get("billing/src/v1beta1/legal_document.ts")!;
  for (const method of ["getLegalDocumentVersion", "downloadLegalDocumentVersion"]) {
    assert.match(methodOf(source, "LegalDocumentClient", method), /unauthenticated: true/);
  }
  assert.doesNotMatch(methodOf(source, "PriceListClient", "getLegalDocumentVersion"), /unauthenticated/);
});

test("core's list of services is the domains of the resource types the API declares", () => {
  const set: FileDescriptorSet = {
    file: [
      {
        name: "origincloud/kms/v1beta1/key.proto",
        package: "origincloud.kms.v1beta1",
        options: { "[google.api.resource_definition]": [{ type: "kms.origincloudapis.eu/KeyVersion" }] },
        messageType: [
          {
            name: "Volume",
            options: { "[google.api.resource]": { type: "pvs.origincloudapis.eu/Volume" } },
            nestedType: [{ name: "Image", options: { "[google.api.resource]": { type: "compute.origincloudapis.eu/Image" } } }],
          },
          { name: "Snapshot", options: { "[google.api.resource]": { type: "pvs.origincloudapis.eu/Snapshot" } } },
          { name: "Plain" },
        ],
      },
      // Only the API's own files count.
      {
        name: "google/cloud/thing.proto",
        package: "google.cloud",
        messageType: [{ name: "Thing", options: { "[google.api.resource]": { type: "example.googleapis.com/Thing" } } }],
      },
    ],
  };
  assert.deepEqual(new Resources(set).services(), ["compute", "kms", "pvs"]);
  const module = generate(set).get("core/src/generated/resource-services.ts");
  assert.ok(module?.includes('Object.freeze([\n  "compute",\n  "kms",\n  "pvs",\n]);'), module);

  for (const bad of [
    "pvs.example.com/Volume",
    "origincloudapis.eu/Volume",
    "pvs.eu-central1.origincloudapis.eu/Volume",
    "pvs.origincloudapis.eu/volume",
    "pvs.origincloudapis.eu",
  ]) {
    const file: FileDescriptor = {
      name: "origincloud/pvs/v1beta1/volume.proto",
      package: "origincloud.pvs.v1beta1",
      messageType: [{ name: "Volume", options: { "[google.api.resource]": { type: bad } } }],
    };
    assert.throws(() => new Resources({ file: [file] }), /isn't \{service\}\.origincloudapis\.eu\/\{Kind\}/, bad);
  }
});

// A path field takes the full names of the service of the type it refers to.
test("a path field takes the names of the type it refers to", () => {
  const resource = (name: string, type: string, pattern: string, field: FieldDescriptor[] = []): MessageDescriptor => ({
    name,
    field,
    options: { "[google.api.resource]": { type, pattern: [pattern] } },
  });
  const ref = (name: string, reference?: { type?: string; childType?: string }): FieldDescriptor => ({
    name,
    type: "TYPE_STRING",
    ...(reference ? { options: { "[google.api.resource_reference]": reference } } : {}),
  });
  const nameField: FieldDescriptor = { name: "name", type: "TYPE_STRING" };
  const project = resource("Project", "resourcemanager.origincloudapis.eu/Project", "projects/{project}", [nameField]);
  const volume = resource("Volume", "pvs.origincloudapis.eu/Volume", "projects/{project}/zones/{zone}/volumes/{volume}", [nameField]);
  const request: MessageDescriptor = {
    name: "Request",
    field: [
      ref("own", { type: "pvs.origincloudapis.eu/Volume" }),
      ref("other", { type: "resourcemanager.origincloudapis.eu/Project" }),
      ref("any", { type: "*" }),
      ref("costs", { childType: "billing.origincloudapis.eu/Cost" }),
      ref("images", { childType: "compute.origincloudapis.eu/PublicImage" }),
      ref("volumes", { childType: "pvs.origincloudapis.eu/Volume" }),
      ref("plain"),
    ],
  };
  const resources = new Resources({
    file: [
      {
        name: "origincloud/scratch/v1/scratch.proto",
        package: "origincloud.scratch.v1",
        messageType: [
          project,
          resource("Zone", "location.origincloudapis.eu/Zone", "zones/{zone}"),
          volume,
          resource("Cost", "billing.origincloudapis.eu/Cost", "projects/{project}/costs/{cost}"),
          resource("PublicImage", "compute.origincloudapis.eu/PublicImage", "zones/{zone}/images/{image}"),
          request,
        ],
      },
    ],
  });
  const of = (name: string) => resources.pathServices(request, request.field!.find((f) => f.name === name)!);
  assert.deepEqual(of("own"), ["pvs"]);
  assert.deepEqual(of("other"), ["resourcemanager"]);
  assert.deepEqual(of("any"), [ANY_SERVICE]);
  // A child's parent is the declared type with its parent pattern.
  assert.deepEqual(of("costs"), ["resourcemanager"]);
  assert.deepEqual(of("images"), ["location"]);
  // projects/{project}/zones/{zone} is no declared type: the child's own service.
  assert.deepEqual(of("volumes"), ["pvs"]);
  // A resource's own name.
  assert.deepEqual(resources.pathServices(volume, nameField), ["pvs"]);
  assert.deepEqual(resources.pathServices(project, nameField), ["resourcemanager"]);
  // Nothing to go by: the client's own service.
  assert.deepEqual(of("plain"), []);
});
