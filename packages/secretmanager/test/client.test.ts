import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { SecretManagerClient } from "@origincloud/secretmanager/v1beta1";

test("getSecret gets a resource by its name from secretmanager.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "projects/x/regions/x/secrets/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new SecretManagerClient(client).getSecret({ name: "projects/x/regions/x/secrets/x" });
  assert.deepEqual(urls, ["https://secretmanager.origincloudapis.eu/v1beta1/projects/x/regions/x/secrets/x"]);
  assert.equal(got.name, "projects/x/regions/x/secrets/x");
});
