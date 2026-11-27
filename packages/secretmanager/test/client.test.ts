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

test("a secret is created, gets a version and is read at latest", async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const secret = "projects/p/regions/eu-central1/secrets/db-password";
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url: String(url), body });
      const u = String(url);
      const answer = u.endsWith(":addVersion")
        ? { name: `${secret}/versions/1` }
        : u.endsWith(":access")
          ? { secretVersion: `//secretmanager.origincloudapis.eu/${secret}/versions/1`, payload: { data: "aHVudGVyMg==" } }
          : { name: secret };
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    },
  });
  const sm = new SecretManagerClient(client);

  const created = await sm.createSecret({ parent: "projects/p/regions/eu-central1", secretId: "db-password" });
  assert.equal(created.name, secret);
  const version = await sm.addSecretVersion({ parent: secret, payload: { data: "aHVudGVyMg==" } });
  assert.equal(version.name, `${secret}/versions/1`);
  const read = await sm.accessSecretVersion({ name: `${secret}/versions/latest` });
  assert.equal(read.payload?.data, "aHVudGVyMg==");
  assert.ok(read.secretVersion?.endsWith("/versions/1"));

  const base = "https://secretmanager.origincloudapis.eu/v1beta1";
  assert.equal(calls[0]?.method, "POST");
  assert.ok(calls[0]?.url.startsWith(`${base}/projects/p/regions/eu-central1/secrets`), calls[0]?.url);
  assert.equal(calls[1]?.url, `${base}/${secret}:addVersion`);
  assert.deepEqual((calls[1]?.body as { payload: unknown }).payload, { data: "aHVudGVyMg==" });
  assert.equal(calls[2]?.method, "GET");
  assert.ok(calls[2]?.url.startsWith(`${base}/${secret}/versions/latest:access`), calls[2]?.url);
});
