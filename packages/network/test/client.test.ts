import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { AclClient } from "@origincloud/network/v1beta1";

test("getAcl gets a resource by its name from network.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "projects/x/regions/x/acls/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new AclClient(client).getAcl({ name: "projects/x/regions/x/acls/x" });
  assert.deepEqual(urls, ["https://network.origincloudapis.eu/v1beta1/projects/x/regions/x/acls/x"]);
  assert.equal(got.name, "projects/x/regions/x/acls/x");
});
