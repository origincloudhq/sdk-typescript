import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import {
  AuditLogClient,
  RoleBindingClient,
  ServiceAccountClient,
  ServiceAccountKeyClient,
  UserClient,
} from "@origincloud/iam/v1beta1";

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

test("getServiceAccount reads a service account", async () => {
  const [client, calls] = await recordingClient({
    name: "organizations/o/serviceAccounts/s",
    displayName: "CI",
    member: "serviceAccount:s",
    type: "EXTERNAL",
    state: "ACTIVE",
  });

  const account = await new ServiceAccountClient(client).getServiceAccount({ name: "organizations/o/serviceAccounts/s" });
  assert.equal(account.member, "serviceAccount:s");
  assert.equal(account.type, "EXTERNAL");
  assert.equal(account.state, "ACTIVE");

  const [get] = calls;
  assert.ok(get && calls.length === 1);
  assert.equal(get.method, "GET");
  assert.equal(get.path, "/v1beta1/organizations/o/serviceAccounts/s");
  assert.equal(get.body, "");
  assert.deepEqual([...get.query], []);
});

test("createServiceAccount sends the service account as the body", async () => {
  const [client, calls] = await recordingClient({
    name: "organizations/o/serviceAccounts/s",
    displayName: "CI",
    member: "serviceAccount:s",
    type: "EXTERNAL",
    state: "ACTIVE",
  });

  const account = await new ServiceAccountClient(client).createServiceAccount({
    parent: "organizations/o",
    serviceAccount: { displayName: "CI", type: "EXTERNAL" },
  });
  assert.equal(account.name, "organizations/o/serviceAccounts/s");

  // body: "service_account": the service account is the body, the request
  // id goes in the query, filled in as it was left empty.
  const [created] = calls;
  assert.ok(created && calls.length === 1);
  assert.equal(created.method, "POST");
  assert.equal(created.path, "/v1beta1/organizations/o/serviceAccounts");
  assert.deepEqual(JSON.parse(created.body), { displayName: "CI", type: "EXTERNAL" });
  assert.deepEqual([...created.query.keys()], ["requestId"]);
  assert.match(created.query.get("requestId") ?? "", uuid);
});

// A create whose answer was lost is sent again with the same request id,
// and the API answers the repeat with the account the first one created.
test("a repeated createServiceAccount answers with the account it created", async () => {
  const account = "organizations/o/serviceAccounts/s";
  const calls: Received[] = [];
  const server = await serve((req, res) => {
    calls.push(req);
    if (calls.length === 1) {
      res.socket?.destroy();
      return;
    }
    json(res, { name: account, state: "ACTIVE" });
  });
  closers.push(server.close);
  const client = new Client({ endpoint: server.url, credentials: accessToken("t") });

  const created = await new ServiceAccountClient(client).createServiceAccount({
    parent: "organizations/o",
    serviceAccount: { displayName: "CI" },
  });
  assert.equal(created.name, account);

  assert.equal(calls.length, 2);
  const [first, second] = calls;
  assert.ok(first && second);
  assert.match(first.query.get("requestId") ?? "", uuid);
  assert.equal(second.query.get("requestId"), first.query.get("requestId"));
});

// The private key is shown once, in the credentials file of the response
// that created the key.
test("createServiceAccountKey answers with its credentials file", async () => {
  const credentialsFile = JSON.stringify({
    type: "service_account_key",
    name: "//iam.origincloudapis.eu/organizations/o/serviceAccounts/s/keys/k",
    service_account: "//iam.origincloudapis.eu/organizations/o/serviceAccounts/s",
    algorithm: "ES256",
    private_key: "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
    sts_endpoint: "https://sts.origincloudapis.eu",
  });
  const [client, calls] = await recordingClient({
    name: "organizations/o/serviceAccounts/s/keys/k",
    algorithm: "ES256",
    state: "ACTIVE",
    credentialsFile,
  });

  const key = await new ServiceAccountKeyClient(client).createServiceAccountKey({
    parent: "organizations/o/serviceAccounts/s",
  });
  assert.equal(key.credentialsFile, credentialsFile);

  const [created] = calls;
  assert.ok(created && calls.length === 1);
  assert.equal(created.method, "POST");
  assert.equal(created.path, "/v1beta1/organizations/o/serviceAccounts/s/keys");
  assert.deepEqual([...created.query.keys()], ["requestId"]);
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
