import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { CaseClient } from "@origincloud/support/v1beta1";

test("getCase gets a resource by its name from support.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "organizations/x/cases/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new CaseClient(client).getCase({ name: "organizations/x/cases/x" });
  assert.deepEqual(urls, ["https://support.origincloudapis.eu/v1beta1/organizations/x/cases/x"]);
  assert.equal(got.name, "organizations/x/cases/x");
});
