import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { LocationClient } from "@origincloud/location/v1beta1";

test("the location service is global: a regional client still calls the regionless host", async () => {
  const urls: string[] = [];
  const client = new Client({
    region: "eu-central1",
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({ zones: [{ name: "zones/eu-central1-az1", services: ["pvs"] }] }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  const { zones = [] } = await new LocationClient(client).listZones({});
  assert.deepEqual(urls, ["https://location.origincloudapis.eu/v1beta1/zones"]);
  assert.deepEqual(zones[0]?.services, ["pvs"]);
});
