import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { BillingAccountClient } from "@origincloud/billing/v1beta1";

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
