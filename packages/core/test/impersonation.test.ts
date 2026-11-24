import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  CLISessionCredentials,
  Client,
  FederatedCredentials,
  ImpersonatedCredentials,
  InstanceMetadataCredentials,
  STS_ENDPOINT,
  ServiceAccountKeyCredentials,
  accessToken,
  impersonate,
} from "@origincloud/core";

import { newCredentialsFile } from "../../../test-support/credentials-file.js";
import { type Received, json, serve } from "../../../test-support/fake-server.js";

const ENV = [
  "ORIGINCLOUD_ACCESS_TOKEN",
  "ORIGINCLOUD_CREDENTIALS_FILE",
  "ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT",
  "ORIGINCLOUD_REGION",
  "ORIGINCLOUD_METADATA_DISABLED",
  "ORIGINCLOUD_METADATA_ENDPOINT",
  "ORIGINCLOUD_OIDC_DISABLED",
  "ORIGINCLOUD_OIDC_TOKEN_FILE",
  "ORIGINCLOUD_OIDC_TOKEN",
  "ORIGINCLOUD_STS_ENDPOINT",
  "TFC_WORKLOAD_IDENTITY_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
];
const saved = Object.fromEntries(["XDG_DATA_HOME", ...ENV].map((name) => [name, process.env[name]]));
const dirs: string[] = [];
const closers: (() => Promise<void>)[] = [];

after(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const close of closers) await close();
});

let dataHome = "";

// Each test starts with no credentials in the environment and a data
// directory of its own, which holds no CLI session.
beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  dataHome = mkdtempSync(join(tmpdir(), "origincloud-sdk-impersonation-test-"));
  dirs.push(dataHome);
  process.env["XDG_DATA_HOME"] = dataHome;
});

const ACCOUNT = "//iam.origincloudapis.eu/organizations/o/serviceAccounts/deployer";
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/**
 * One server that is both the STS (`POST /v1/token`) and the API (anything
 * else). The STS answers with the account's tokens numbered from 1,
 * expiring after `expiresIn` seconds, unless `answer` answers otherwise; the
 * API records the Authorization header of each call.
 */
async function fakeSts(expiresIn = 300, answer?: (attempt: number) => { status: number; body: unknown } | undefined) {
  const exchanges: Received[] = [];
  const calls: string[] = [];
  let issued = 0;
  const server = await serve((req, res) => {
    if (req.path !== "/v1/token") {
      calls.push(String(req.headers["authorization"]));
      json(res, {});
      return;
    }
    exchanges.push(req);
    const answered = answer?.(exchanges.length);
    if (answered) {
      json(res, answered.body, answered.status);
      return;
    }
    issued++;
    json(res, { access_token: `account-token-${issued}`, issued_token_type: ACCESS_TOKEN_TYPE, token_type: "Bearer", expires_in: expiresIn });
  });
  closers.push(server.close);
  return { url: server.url, exchanges, calls, forms: () => exchanges.map((r) => new URLSearchParams(r.body)) };
}

/** A person's credentials, whose tokens are numbered from 1 as they are asked for. */
function person() {
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    credentials: { token: async () => `person-token-${++asked}` },
  };
}

test("the exchange is the one the STS specifies, and its token is what calls are sent with", async () => {
  const sts = await fakeSts();
  const caller = person();
  const client = new Client({
    endpoint: sts.url,
    credentials: caller.credentials,
    impersonateServiceAccount: ACCOUNT,
  });
  // The STS is named apart from the API's endpoint.
  assert.ok(client.credentials instanceof ImpersonatedCredentials);
  assert.equal(client.credentials.endpoint, STS_ENDPOINT);
  assert.equal(STS_ENDPOINT, "https://sts.origincloudapis.eu");

  const credentials = impersonate(caller.credentials, ACCOUNT, { endpoint: sts.url + "/" });
  assert.equal(credentials.serviceAccount, ACCOUNT);
  assert.equal(credentials.endpoint, sts.url);
  const viaSts = new Client({ endpoint: sts.url, credentials });
  await viaSts.service("pvs").call({ method: "GET", path: "/x" });

  assert.equal(sts.exchanges.length, 1);
  const [exchange] = sts.exchanges;
  assert.equal(exchange!.method, "POST");
  assert.equal(exchange!.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange!.body)), {
    grant_type: TOKEN_EXCHANGE,
    subject_token: "person-token-1",
    subject_token_type: ACCESS_TOKEN_TYPE,
    service_account: ACCOUNT,
  });
  assert.deepEqual(sts.calls, ["Bearer account-token-1"]);
});

test("the account's token is reused, and renewed from the caller's current token before it expires", async () => {
  const lasting = await fakeSts(300);
  const caller = person();
  const credentials = impersonate(caller.credentials, ACCOUNT, { endpoint: lasting.url });
  assert.equal(await credentials.token(), "account-token-1");
  assert.equal(await credentials.token(), "account-token-1");
  assert.equal(lasting.exchanges.length, 1);
  assert.equal(caller.asked, 1);

  // A token that expires within the minute's margin is replaced at once,
  // before it expires, from the caller's next token.
  const short = await fakeSts(30);
  const renewing = impersonate(caller.credentials, ACCOUNT, { endpoint: short.url });
  assert.equal(await renewing.token(), "account-token-1");
  assert.equal(await renewing.token(), "account-token-2");
  assert.deepEqual(
    short.forms().map((f) => f.get("subject_token")),
    ["person-token-2", "person-token-3"],
  );
});

test("concurrent callers share one exchange", async () => {
  const sts = await fakeSts();
  const caller = person();
  const credentials = impersonate(caller.credentials, ACCOUNT, { endpoint: sts.url });
  const tokens = await Promise.all([credentials.token(), credentials.token(), credentials.token()]);
  assert.deepEqual(tokens, ["account-token-1", "account-token-1", "account-token-1"]);
  assert.equal(sts.exchanges.length, 1);
  assert.equal(caller.asked, 1);
});

test("a refusal is an error naming the account, and no call is sent with the caller's token", async () => {
  const sts = await fakeSts(300, () => ({ status: 400, body: { error: "invalid_grant", error_description: "refused" } }));
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  const client = new Client({ endpoint: sts.url, credentials: accessToken("person-token"), impersonateServiceAccount: ACCOUNT });
  const refused = new RegExp(
    `the STS refused to impersonate the service account ${ACCOUNT} \\(invalid_grant\\): ` +
      "the caller must be a person .* holding roles/iam.service-account-token-creator on it",
  );
  await assert.rejects(client.service("pvs").call({ method: "GET", path: "/x" }), refused);
  // Refusals aren't cached: the next call asks again.
  await assert.rejects(client.credentials.token(), refused);
  assert.equal(sts.exchanges.length, 2);
  assert.deepEqual(sts.calls, [], "the API got no call");
});

test("a redirect is refused, and the caller's token goes nowhere else", async () => {
  const elsewhere: Received[] = [];
  const other = await serve((req, res) => {
    elsewhere.push(req);
    json(res, { access_token: "stolen", token_type: "Bearer", expires_in: 300 });
  });
  closers.push(other.close);
  const sts = await serve((_req, res) => json(res, {}, 307, { Location: `${other.url}/v1/token` }));
  closers.push(sts.close);
  const credentials = impersonate(accessToken("person-token"), ACCOUNT, { endpoint: sts.url });
  await assert.rejects(credentials.token(), new RegExp(`impersonating the service account ${ACCOUNT}`));
  assert.deepEqual(elsewhere, [], "the redirect target got nothing");
});

test("another refusal names the account and the STS's reason, never the caller's token", async () => {
  const sts = await fakeSts(300, () => ({
    status: 400,
    body: { error: "invalid_request", error_description: "bad subject_token person-token" },
  }));
  const credentials = impersonate(accessToken("person-token"), ACCOUNT, { endpoint: sts.url });
  await assert.rejects(credentials.token(), (err: Error) => {
    assert.match(err.message, new RegExp(`^origincloud: impersonating the service account ${ACCOUNT}: `));
    assert.match(err.message, /HTTP 400\): invalid_request: bad subject_token \[token\]$/);
    assert.doesNotMatch(err.message, /person-token/);
    return true;
  });
});

test("an answer that isn't a token is an error naming the account", async () => {
  const sts = await fakeSts(300, () => ({ status: 200, body: { token_type: "Bearer" } }));
  const credentials = impersonate(accessToken("person-token"), ACCOUNT, { endpoint: sts.url });
  await assert.rejects(credentials.token(), new RegExp(`impersonating the service account ${ACCOUNT}: the STS's answer is not a token response`));
});

test("a 503 is sent again twice", async () => {
  const flaky = await fakeSts(300, (attempt) => (attempt < 3 ? { status: 503, body: {} } : undefined));
  assert.equal(await impersonate(accessToken("t"), ACCOUNT, { endpoint: flaky.url }).token(), "account-token-1");
  assert.equal(flaky.exchanges.length, 3);

  const down = await fakeSts(300, () => ({ status: 503, body: {} }));
  await assert.rejects(
    impersonate(accessToken("t"), ACCOUNT, { endpoint: down.url }).token(),
    new RegExp(`impersonating the service account ${ACCOUNT}: the STS is temporarily unavailable`),
  );
  assert.equal(down.exchanges.length, 3);
});

test("only a service account's full name can be impersonated", () => {
  for (const name of [
    "organizations/o/serviceAccounts/deployer",
    "//iam.origincloudapis.eu/users/u",
    "//iam.origincloudapis.eu/organizations/o",
    "deployer@o",
    "https://iam.origincloudapis.eu/organizations/o/serviceAccounts/deployer",
  ]) {
    assert.throws(
      () => impersonate(accessToken("t"), name),
      new RegExp(`the service account to impersonate must be its full name, .*got ${JSON.stringify(name).replace(/[/.]/g, "\\$&")}`),
    );
  }
  process.env["ORIGINCLOUD_ACCESS_TOKEN"] = "t";
  process.env["ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT"] = "not a name";
  assert.throws(() => new Client(), /got "not a name"/);
});

test("the caller's token is sent to an https STS, or to the loopback interface, only", async () => {
  const caller = person();
  const credentials = impersonate(caller.credentials, ACCOUNT, { endpoint: "http://sts.example.com" });
  await assert.rejects(credentials.token(), /"http:\/\/sts.example.com" is not an https URL/);
  assert.equal(caller.asked, 0, "the caller's token wasn't asked for");
});

test("ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT impersonates; the option overrides it, and an empty one turns it off", async () => {
  const sts = await fakeSts();
  process.env["ORIGINCLOUD_ACCESS_TOKEN"] = "person-token";
  assert.ok(!(new Client().credentials instanceof ImpersonatedCredentials));
  for (const blank of ["", "  "]) {
    process.env["ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT"] = blank;
    assert.ok(!(new Client().credentials instanceof ImpersonatedCredentials));
  }

  process.env["ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT"] = ACCOUNT;
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  const client = new Client();
  assert.ok(client.credentials instanceof ImpersonatedCredentials);
  assert.equal(client.credentials.serviceAccount, ACCOUNT);
  assert.equal(client.credentials.endpoint, sts.url);
  assert.equal(await client.credentials.token(), "account-token-1");
  assert.equal(sts.forms()[0]!.get("subject_token"), "person-token");

  // It wraps credentials given to the client, too.
  const given = new Client({ credentials: accessToken("other") });
  assert.ok(given.credentials instanceof ImpersonatedCredentials);

  const other = "//iam.origincloudapis.eu/organizations/o/serviceAccounts/reader";
  const chosen = new Client({ impersonateServiceAccount: other });
  assert.ok(chosen.credentials instanceof ImpersonatedCredentials);
  assert.equal(chosen.credentials.serviceAccount, other);

  const off = new Client({ impersonateServiceAccount: "" });
  assert.ok(!(off.credentials instanceof ImpersonatedCredentials));
  assert.equal(await off.credentials.token(), "person-token");
});

test("every credential of the chain can be impersonated from", () => {
  process.env["ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT"] = ACCOUNT;
  const steps: [Record<string, string>, () => void, Function][] = [
    [{ ORIGINCLOUD_ACCESS_TOKEN: "t" }, () => {}, Object],
    [{ ORIGINCLOUD_CREDENTIALS_FILE: join(dataHome, "credentials.json") }, writeCredentialsFile, ServiceAccountKeyCredentials],
    [{ ORIGINCLOUD_OIDC_TOKEN: "job-token" }, () => {}, FederatedCredentials],
    [{}, () => writeSession("person-token"), CLISessionCredentials],
    [{ ORIGINCLOUD_METADATA_ENDPOINT: "http://127.0.0.1:1" }, () => {}, InstanceMetadataCredentials],
  ];
  for (const [vars, prepare, kind] of steps) {
    for (const name of ENV) if (name !== "ORIGINCLOUD_IMPERSONATE_SERVICE_ACCOUNT") delete process.env[name];
    rmSync(join(dataHome, "origincloud"), { recursive: true, force: true });
    Object.assign(process.env, vars);
    prepare();
    const credentials = new Client().credentials;
    assert.ok(credentials instanceof ImpersonatedCredentials, JSON.stringify(vars));
    assert.ok(credentials.base instanceof kind, `${JSON.stringify(vars)}: ${credentials.base.constructor.name}`);
    assert.equal(credentials.serviceAccount, ACCOUNT);
  }
});

test("a person logged in with `origin id login` acts as the account", async () => {
  const sts = await fakeSts();
  writeSession("person-token");
  process.env["ORIGINCLOUD_METADATA_DISABLED"] = "true";
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  const client = new Client({ endpoint: sts.url, impersonateServiceAccount: ACCOUNT });
  await client.service("pvs").call({ method: "GET", path: "/x" });
  await client.service("pvs").call({ method: "GET", path: "/y" });
  assert.deepEqual(
    sts.forms().map((f) => [f.get("subject_token"), f.get("service_account")]),
    [["person-token", ACCOUNT]],
  );
  assert.deepEqual(sts.calls, ["Bearer account-token-1", "Bearer account-token-1"]);
});

function writeSession(accessTokenValue: string): void {
  mkdirSync(join(dataHome, "origincloud"), { recursive: true });
  const inAnHour = new Date(Date.now() + 3600_000).toISOString();
  writeFileSync(
    join(dataHome, "origincloud", "session.json"),
    JSON.stringify({ access_token: accessTokenValue, expires: inAnHour, refresh_token: "r", refresh_expires: inAnHour }),
  );
}

function writeCredentialsFile(): void {
  writeFileSync(join(dataHome, "credentials.json"), newCredentialsFile().json);
}
