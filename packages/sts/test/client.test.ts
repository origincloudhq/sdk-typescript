import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { SecurityTokenClient } from "@origincloud/sts/v1beta1";

test("a SecurityTokenClient sends its calls to sts.origincloudapis.eu", () => {
  const client = new SecurityTokenClient(new Client({ credentials: accessToken("t") }));
  assert.equal(client.service.base, "https://sts.origincloudapis.eu");
});

test("the STS is global: a client with a region still calls sts.origincloudapis.eu", () => {
  const client = new SecurityTokenClient(
    new Client({ credentials: accessToken("t"), region: "eu-central1" }),
  );
  assert.equal(client.service.base, "https://sts.origincloudapis.eu");
});
