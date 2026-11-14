import assert from "node:assert/strict";
import { test } from "node:test";

import type { FileDescriptor, FileDescriptorSet } from "./descriptors.js";
import { generate } from "./main.js";

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
