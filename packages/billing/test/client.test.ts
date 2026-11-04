import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { BillingAccountClient, PriceListClient } from "@origincloud/billing/v1beta1";

test("getBillingAccount gets a resource by its name from billing.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "organizations/x/billingAccounts/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new BillingAccountClient(client).getBillingAccount({ name: "organizations/x/billingAccounts/x" });
  assert.deepEqual(urls, ["https://billing.origincloudapis.eu/v1beta1/organizations/x/billingAccounts/x"]);
  assert.equal(got.name, "organizations/x/billingAccounts/x");
});

// Billing is global: it has no regional host.
test("a client with a region still calls billing.origincloudapis.eu, for the price list too", () => {
  const client = new Client({ credentials: accessToken("t"), region: "eu-central1" });
  assert.equal(new BillingAccountClient(client).service.base, "https://billing.origincloudapis.eu");
  assert.equal(new PriceListClient(client).service.base, "https://billing.origincloudapis.eu");
});
