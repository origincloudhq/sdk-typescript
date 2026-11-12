import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { SecurityTokenClient } from "@origincloud/sts/v1beta1";

import { json, serve } from "../../../test-support/fake-server.js";

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

test("AssumeServiceAccount is sent without the client's credentials, which a machine with a token alone has none of", async () => {
  let seen: Record<string, string | string[] | undefined> = {};
  let body = "";
  const server = await serve((req, res) => {
    seen = req.headers;
    body = req.body;
    json(res, { accessToken: "issued", serviceAccount: "organizations/o/serviceAccounts/s" });
  });
  try {
    const none = () => {
      throw new Error("no credentials");
    };
    const client = new SecurityTokenClient(new Client({ endpoint: server.url, credentials: none }));
    const answer = await client.assumeServiceAccount({ oidcToken: "job-token", serviceAccount: "organizations/o/serviceAccounts/s" });
    assert.equal(answer.accessToken, "issued");
    assert.equal(seen["authorization"], undefined);
    assert.deepEqual(JSON.parse(body), { oidcToken: "job-token", serviceAccount: "organizations/o/serviceAccounts/s" });
  } finally {
    await server.close();
  }
});
