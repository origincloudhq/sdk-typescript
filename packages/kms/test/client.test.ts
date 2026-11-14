import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { GrantClient } from "@origincloud/kms/v1beta1";

test("getGrant gets a resource by its name from kms.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "projects/x/regions/x/keys/x/grants/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new GrantClient(client).getGrant({ name: "projects/x/regions/x/keys/x/grants/x" });
  assert.deepEqual(urls, ["https://kms.origincloudapis.eu/v1beta1/projects/x/regions/x/keys/x/grants/x"]);
  assert.equal(got.name, "projects/x/regions/x/keys/x/grants/x");
});
