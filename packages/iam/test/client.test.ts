import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { AuditLogClient, RoleBindingClient, ServiceAccountClient, UserClient } from "@origincloud/iam/v1beta1";

import { type Received, json, serve } from "../../../test-support/fake-server.js";

const uuid = /^[0-9a-f-]{36}$/;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

/** A client whose calls are recorded and answered with `answer`. */
async function recordingClient(answer: unknown): Promise<[Client, Received[]]> {
  const calls: Received[] = [];
  const server = await serve((req, res) => {
    calls.push(req);
    json(res, answer);
  });
  closers.push(server.close);
  return [new Client({ endpoint: server.url, credentials: accessToken("t") }), calls];
}

test("getAuditLogEntry gets a resource by its name from iam.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "organizations/x/auditLogEntries/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new AuditLogClient(client).getAuditLogEntry({ name: "organizations/x/auditLogEntries/x" });
  assert.deepEqual(urls, ["https://iam.origincloudapis.eu/v1beta1/organizations/x/auditLogEntries/x"]);
  assert.equal(got.name, "organizations/x/auditLogEntries/x");
});

test("a regional client still calls the regionless host", async () => {
  const urls: string[] = [];
  const client = new Client({
    region: "eu-central1",
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });

  await new ServiceAccountClient(client).getServiceAccount({ name: "organizations/o/serviceAccounts/s" });
  await new UserClient(client).getUser({ name: "users/me" });
  assert.deepEqual(urls, [
    "https://iam.origincloudapis.eu/v1beta1/organizations/o/serviceAccounts/s",
    "https://iam.origincloudapis.eu/v1beta1/users/me",
  ]);
});

test("getServiceAccount reads a service account without its secret", async () => {
  const [client, calls] = await recordingClient({
    name: "organizations/o/serviceAccounts/s",
    displayName: "CI",
    member: "serviceAccount:s",
    clientId: "sa-s",
    state: "ACTIVE",
  });

  const account = await new ServiceAccountClient(client).getServiceAccount({ name: "organizations/o/serviceAccounts/s" });
  assert.equal(account.member, "serviceAccount:s");
  assert.equal(account.clientId, "sa-s");
  assert.equal(account.clientSecret, undefined);
  assert.equal(account.state, "ACTIVE");

  const [get] = calls;
  assert.ok(get && calls.length === 1);
  assert.equal(get.method, "GET");
  assert.equal(get.path, "/v1beta1/organizations/o/serviceAccounts/s");
  assert.equal(get.body, "");
  assert.deepEqual([...get.query], []);
});

// The client secret is shown once, in the response that created the
// service account.
test("createServiceAccount answers with its client secret", async () => {
  const [client, calls] = await recordingClient({
    name: "organizations/o/serviceAccounts/s",
    displayName: "CI",
    member: "serviceAccount:s",
    clientId: "sa-s",
    clientSecret: "shown-once",
    state: "ACTIVE",
  });

  const account = await new ServiceAccountClient(client).createServiceAccount({
    parent: "organizations/o",
    serviceAccount: { displayName: "CI" },
  });
  assert.equal(account.clientSecret, "shown-once");
  assert.equal(account.clientId, "sa-s");

  // body: "service_account": the service account is the body, the request
  // id goes in the query, filled in as it was left empty.
  const [created] = calls;
  assert.ok(created && calls.length === 1);
  assert.equal(created.method, "POST");
  assert.equal(created.path, "/v1beta1/organizations/o/serviceAccounts");
  assert.deepEqual(JSON.parse(created.body), { displayName: "CI" });
  assert.deepEqual([...created.query.keys()], ["requestId"]);
  assert.match(created.query.get("requestId") ?? "", uuid);
});

test("createRoleBinding keeps a given request id", async () => {
  const [client, calls] = await recordingClient({});

  await new RoleBindingClient(client).createRoleBinding({
    parent: "organizations/o",
    roleBinding: { member: "user:ada@example.com", role: "roles/viewer", project: "projects/p" },
    requestId: "given",
  });

  const [created] = calls;
  assert.ok(created && calls.length === 1);
  assert.equal(created.method, "POST");
  assert.equal(created.path, "/v1beta1/organizations/o/roleBindings");
  assert.deepEqual(JSON.parse(created.body), {
    member: "user:ada@example.com",
    role: "roles/viewer",
    project: "projects/p",
  });
  assert.deepEqual([...created.query], [["requestId", "given"]]);
});
