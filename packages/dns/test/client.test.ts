import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { HostedZoneClient, RecordSetClient, VpcAttachmentClient } from "@origincloud/dns/v1beta1";

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

// DNS is global: it has no regional host.
test("a client with a region still calls dns.origincloudapis.eu, for record sets and VPC attachments too", () => {
  const client = new Client({ credentials: accessToken("t"), region: "eu-central1" });
  assert.equal(new HostedZoneClient(client).service.base, "https://dns.origincloudapis.eu");
  assert.equal(new RecordSetClient(client).service.base, "https://dns.origincloudapis.eu");
  assert.equal(new VpcAttachmentClient(client).service.base, "https://dns.origincloudapis.eu");
});
