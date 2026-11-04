import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { MetricClient } from "@origincloud/observability/v1beta1";

test("a MetricClient sends its calls to observability.origincloudapis.eu", () => {
  const client = new MetricClient(new Client({ credentials: accessToken("t") }));
  assert.equal(client.service.base, "https://observability.origincloudapis.eu");
});
