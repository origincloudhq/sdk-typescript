import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { HostedZoneClient } from "@origincloud/dns/v1beta1";

test("getHostedZone gets a resource by its name from dns.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "projects/x/hostedZones/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new HostedZoneClient(client).getHostedZone({ name: "projects/x/hostedZones/x" });
  assert.deepEqual(urls, ["https://dns.origincloudapis.eu/v1beta1/projects/x/hostedZones/x"]);
  assert.equal(got.name, "projects/x/hostedZones/x");
});
