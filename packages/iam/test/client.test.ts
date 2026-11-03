import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { AuditLogClient } from "@origincloud/iam/v1beta1";

test("getAuditLogEntry gets a resource by its name from iam.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "organizations/x/auditLogEntries/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new AuditLogClient(client).getAuditLogEntry({ name: "organizations/x/auditLogEntries/x" });
  assert.deepEqual(urls, ["https://iam.origincloudapis.eu/v1beta1/organizations/x/auditLogEntries/x"]);
  assert.equal(got.name, "organizations/x/auditLogEntries/x");
});
