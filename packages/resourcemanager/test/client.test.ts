import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { OrganizationClient } from "@origincloud/resourcemanager/v1beta1";

test("getOrganization gets a resource by its name from resourcemanager.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "organizations/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new OrganizationClient(client).getOrganization({ name: "organizations/x" });
  assert.deepEqual(urls, ["https://resourcemanager.origincloudapis.eu/v1beta1/organizations/x"]);
  assert.equal(got.name, "organizations/x");
});
