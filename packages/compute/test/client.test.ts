import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { InstanceTypeClient } from "@origincloud/compute/v1beta1";

test("getInstanceType gets a resource by its name from compute.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "instanceTypes/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new InstanceTypeClient(client).getInstanceType({ name: "instanceTypes/x" });
  assert.deepEqual(urls, ["https://compute.origincloudapis.eu/v1beta1/instanceTypes/x"]);
  assert.equal(got.name, "instanceTypes/x");
});
