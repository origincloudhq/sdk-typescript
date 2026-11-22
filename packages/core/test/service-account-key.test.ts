import assert from "node:assert/strict";
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { inspect } from "node:util";

import {
  CLISessionCredentials,
  Client,
  FederatedCredentials,
  InstanceMetadataCredentials,
  ServiceAccountKeyCredentials,
  credentialsFile,
  defaultCredentials,
} from "@origincloud/core";

import { KEY_NAME, SERVICE_ACCOUNT, newCredentialsFile } from "../../../test-support/credentials-file.js";
import { type Received, json, serve } from "../../../test-support/fake-server.js";

const ENV = [
  "ORIGINCLOUD_ACCESS_TOKEN",
  "ORIGINCLOUD_CREDENTIALS_FILE",
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

let dir = "";

// Each test starts with no credentials in the environment and a data
// directory of its own, which holds no CLI session.
beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  dir = mkdtempSync(join(tmpdir(), "origincloud-sdk-key-test-"));
  dirs.push(dir);
  process.env["XDG_DATA_HOME"] = dir;
});

function write(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

const JWT_BEARER = "urn:ietf:params:oauth:grant-type:jwt-bearer";

/** Why the fake STS refuses `assertion`, checked as the real one checks it, or `undefined` when it doesn't. */
function refusal(assertion: string, publicKey: KeyObject, audience: string, used: Set<string>): string | undefined {
  const parts = assertion.split(".");
  if (parts.length !== 3) return "not a JWT";
  const [header, claims, signature] = parts as [string, string, string];
  const signed = verify(
    "sha256",
    Buffer.from(`${header}.${claims}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  if (!signed) return "the signature doesn't verify";
  const h = JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>;
  const c = JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>;
  if (h["alg"] !== "ES256") return `alg ${String(h["alg"])}`;
  if (h["kid"] !== KEY_NAME) return `kid ${String(h["kid"])}`;
  if (c["iss"] !== SERVICE_ACCOUNT || c["sub"] !== SERVICE_ACCOUNT) return "iss or sub";
  if (c["aud"] !== audience && c["aud"] !== audience + "/v1/token") return `aud ${String(c["aud"])}`;
  const now = Date.now() / 1000;
  const iat = c["iat"];
  const exp = c["exp"];
  if (typeof iat !== "number" || typeof exp !== "number" || !Number.isInteger(iat) || !Number.isInteger(exp)) {
    return "iat or exp";
  }
  if (iat > now + 60) return "iat in the future";
  if (exp <= now) return "expired";
  if (exp - iat > 3600) return "lives longer than an hour";
  const jti = c["jti"];
  if (typeof jti !== "string" || !jti || jti.length > 128) return "jti";
  if (used.has(jti)) return "jti used before";
  used.add(jti);
  return undefined;
}

/**
 * A fake STS for one key: it checks each assertion's signature against the
 * key's public half and its claims as the real STS does, and answers with
 * access tokens numbered from 1, expiring after `expiresIn` seconds, unless
 * `answer` answers otherwise. It records why it refused what it refused.
 */
async function keySts(expiresIn: number, answer?: (attempt: number) => { status: number; body: unknown } | undefined) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const used = new Set<string>();
  const requests: Received[] = [];
  const refused: string[] = [];
  let issued = 0;
  let url = "";
  const server = await serve((req, res) => {
    requests.push(req);
    const answered = answer?.(requests.length);
    if (answered) {
      json(res, answered.body, answered.status);
      return;
    }
    const form = new URLSearchParams(req.body);
    const reason =
      req.method !== "POST" || req.path !== "/v1/token"
        ? `${req.method} ${req.path}`
        : form.get("grant_type") !== JWT_BEARER
          ? `grant_type ${String(form.get("grant_type"))}`
          : refusal(form.get("assertion") ?? "", publicKey, url, used);
    if (reason) {
      refused.push(reason);
      json(res, { error: "invalid_grant" }, 400);
      return;
    }
    issued++;
    json(res, { access_token: `sa-token-${issued}`, token_type: "Bearer", expires_in: expiresIn });
  });
  closers.push(server.close);
  url = server.url;
  const file = newCredentialsFile(url);
  file.fields["private_key"] = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return {
    url,
    json: JSON.stringify(file.fields),
    pem: file.fields["private_key"],
    requests,
    refused,
    issued: () => issued,
  };
}

/**
 * A fake API that answers a call made with the newest token the STS issued
 * and refuses any other with 401; it records the tokens it got.
 */
async function api(newest: () => string) {
  const tokens: string[] = [];
  const server = await serve((req, res) => {
    const token = String(req.headers["authorization"] ?? "").replace(/^Bearer /, "");
    tokens.push(token);
    if (token !== newest()) {
      json(res, { error: { code: 401, status: "UNAUTHENTICATED", message: "token expired" } }, 401);
      return;
    }
    json(res, { caller: token });
  });
  closers.push(server.close);
  return { url: server.url, tokens };
}

test("with only a credentials file, the client calls the API as the service account", async () => {
  const sts = await keySts(900);
  const service = await api(() => `sa-token-${sts.issued()}`);
  process.env["ORIGINCLOUD_CREDENTIALS_FILE"] = write("key.json", sts.json);
  process.env["ORIGINCLOUD_METADATA_DISABLED"] = "true";

  const client = new Client({ endpoint: service.url });
  assert.ok(client.credentials instanceof ServiceAccountKeyCredentials);
  const pvs = client.service("pvs");
  assert.deepEqual(await pvs.call({ method: "GET", path: "/v1beta1/x" }), { caller: "sa-token-1" });
  assert.deepEqual(await pvs.call({ method: "GET", path: "/v1beta1/y" }), { caller: "sa-token-1" });

  assert.deepEqual(sts.refused, []);
  assert.equal(sts.requests.length, 1, "one exchange serves both calls");
  assert.equal(sts.requests[0]?.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(service.tokens, ["sa-token-1", "sa-token-1"]);
});

test("the assertion names the key, the account and the STS, lives five minutes and is never reused", () => {
  const { json: file } = newCredentialsFile();
  const credentials = ServiceAccountKeyCredentials.fromJSON(file);
  assert.equal(credentials.keyName, KEY_NAME);
  assert.equal(credentials.serviceAccount, SERVICE_ACCOUNT);
  assert.equal(credentials.stsEndpoint, "https://sts.origincloudapis.eu");

  const now = Date.UTC(2026, 10, 22, 12, 0, 0, 500);
  const decode = (part: string | undefined) => JSON.parse(Buffer.from(part ?? "", "base64url").toString()) as Record<string, unknown>;
  const [header, claims] = credentials.assertion(now).split(".");
  assert.deepEqual(decode(header), { alg: "ES256", typ: "JWT", kid: KEY_NAME });
  const c = decode(claims);
  assert.equal(c["iss"], SERVICE_ACCOUNT);
  assert.equal(c["sub"], SERVICE_ACCOUNT);
  assert.equal(c["aud"], "https://sts.origincloudapis.eu");
  assert.equal(c["iat"], Math.floor(now / 1000));
  assert.equal(c["exp"], Math.floor(now / 1000) + 300);
  assert.notEqual(c["jti"], decode(credentials.assertion(now).split(".")[1])["jti"]);
});

test("a token about to expire is renewed before the next call, which doesn't fail", async () => {
  // 61 seconds: a second before the minute's margin it is still used; after
  // it, it is replaced before a call is sent with it.
  const sts = await keySts(61);
  const service = await api(() => `sa-token-${sts.issued()}`);
  const client = new Client({ endpoint: service.url, credentials: credentialsFile(write("key.json", sts.json)) });
  const pvs = client.service("pvs");

  assert.deepEqual(await pvs.call({ method: "GET", path: "/v1beta1/x" }), { caller: "sa-token-1" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  assert.deepEqual(await pvs.call({ method: "GET", path: "/v1beta1/x" }), { caller: "sa-token-2" });

  assert.deepEqual(service.tokens, ["sa-token-1", "sa-token-2"], "no call was refused");
  assert.equal(sts.requests.length, 2);
  assert.deepEqual(sts.refused, [], "the renewal's assertion is a fresh one");
});

test("concurrent callers share one exchange", async () => {
  const sts = await keySts(900);
  const credentials = ServiceAccountKeyCredentials.fromJSON(sts.json);
  const tokens = await Promise.all(Array.from({ length: 20 }, () => credentials.token()));
  assert.deepEqual(new Set(tokens), new Set(["sa-token-1"]));
  assert.equal(sts.requests.length, 1);
});

test("an STS answering 503 is tried again", async () => {
  const sts = await keySts(900, (attempt) =>
    attempt <= 2 ? { status: 503, body: { error: "temporarily_unavailable" } } : undefined,
  );
  assert.equal(await ServiceAccountKeyCredentials.fromJSON(sts.json).token(), "sa-token-1");
  assert.equal(sts.requests.length, 3);
  assert.deepEqual(sts.refused, []);

  const down = await keySts(900, () => ({ status: 503, body: {} }));
  await assert.rejects(
    ServiceAccountKeyCredentials.fromJSON(down.json).token(),
    /^Error: origincloud: the STS is temporarily unavailable \(HTTP 503\): try again later$/,
  );
  assert.equal(down.requests.length, 3, "three attempts in all");
});

test("a refused assertion names the key and the audit log, and never shows the assertion or the key", async () => {
  const sts = await keySts(900);
  // A file whose key isn't the one the STS knows: its signature doesn't verify.
  const other = newCredentialsFile(sts.url);
  const err = await ServiceAccountKeyCredentials.fromJSON(other.json)
    .token()
    .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
  assert.deepEqual(sts.refused, ["the signature doesn't verify"]);
  assert.equal(
    err.message,
    `origincloud: the STS refused the assertion of the service account key ${KEY_NAME} (invalid_grant): ` +
      "the key or its service account may be deleted, or the account isn't an EXTERNAL one; " +
      "the organization's audit log records why",
  );
  assert.equal(sts.requests.length, 1, "a refusal isn't retried");

  const echoing = await serve((req, res) =>
    json(res, { error: "invalid_request", error_description: `bad ${new URLSearchParams(req.body).get("assertion")}` }, 400),
  );
  closers.push(echoing.close);
  const echoed = await ServiceAccountKeyCredentials.fromJSON(newCredentialsFile(echoing.url).json)
    .token()
    .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
  assert.equal(echoed.message, "origincloud: the STS refused the service account key's assertion (HTTP 400): invalid_request: bad [token]");

  const broken = await keySts(900, () => ({ status: 200, body: { token_type: "Bearer" } }));
  await assert.rejects(ServiceAccountKeyCredentials.fromJSON(broken.json).token(), /the STS's answer is not a credential$/);
});

test("no way of printing the credentials shows the private key", async () => {
  const sts = await keySts(900);
  const credentials = ServiceAccountKeyCredentials.fromJSON(sts.json);
  const body = (sts.pem ?? "").split("\n")[1] ?? "";
  assert.ok(body.length > 20);
  for (const shown of [
    inspect(credentials),
    inspect(credentials, { showHidden: true, depth: 10 }),
    JSON.stringify(credentials),
    String(credentials),
    `${credentials}`,
  ]) {
    assert.ok(!shown.includes(body), shown);
    assert.ok(!shown.includes("PRIVATE KEY"), shown);
    assert.ok(shown.includes(KEY_NAME), shown);
  }
});

test("a credentials file that isn't a key's is refused, without quoting it", () => {
  const { fields } = newCredentialsFile();
  const pem = fields["private_key"] ?? "";
  const secret = pem.split("\n")[1] ?? "";
  const refuses = (file: string, message: RegExp) => {
    const err = (() => {
      try {
        ServiceAccountKeyCredentials.fromJSON(file);
      } catch (e) {
        return e as Error;
      }
      return assert.fail(`accepted ${file}`);
    })();
    assert.match(err.message, message);
    assert.ok(!err.message.includes(secret), err.message);
  };
  const changed = (change: Record<string, unknown>) => JSON.stringify({ ...fields, ...change });

  refuses(`{"private_key": "${secret}"`, /^origincloud: the credentials file is not JSON/);
  refuses(`[]`, /is not JSON/);
  refuses(changed({ type: "service_account" }), /is of the type "service_account", not service_account_key$/);
  refuses(changed({ type: undefined }), /has no type$/);
  refuses(changed({ algorithm: "RS256" }), /names the algorithm "RS256", not ES256$/);
  refuses(changed({ service_account: "organizations/o/serviceAccounts/s" }), /as its service_account, not a service account's full name$/);
  refuses(changed({ service_account: "//iam.origincloudapis.eu/users/u" }), /not a service account's full name$/);
  refuses(changed({ name: "//iam.origincloudapis.eu/organizations/o/serviceAccounts/other/keys/k" }), /as its key, not the full name of a key of/);
  refuses(changed({ name: `${SERVICE_ACCOUNT}/keys/` }), /as its key/);
  refuses(changed({ name: `${SERVICE_ACCOUNT}/keys/k/x` }), /as its key/);
  refuses(changed({ sts_endpoint: "http://sts.example.com" }), /as its sts_endpoint, not an https URL$/);
  refuses(changed({ sts_endpoint: "sts.origincloudapis.eu" }), /not an https URL$/);
  refuses(changed({ sts_endpoint: "https://u:p@sts.origincloudapis.eu" }), /not an https URL$/);
  refuses(changed({ private_key: pem.replace(secret, secret.slice(0, 20)) }), /holds no private key in PEM$/);
  refuses(changed({ private_key: undefined }), /has no private_key$/);
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey.export({ type: "pkcs8", format: "pem" });
  refuses(changed({ private_key: p384 }), /holds a private key that isn't a P-256 key$/);
  const ed = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  refuses(changed({ private_key: ed }), /isn't a P-256 key$/);

  // As saved, with a trailing slash on the STS, it is accepted.
  assert.equal(
    ServiceAccountKeyCredentials.fromJSON(changed({ sts_endpoint: "https://sts.origincloudapis.eu/" })).stsEndpoint,
    "https://sts.origincloudapis.eu",
  );
});

test("a credentials file the environment names is the credential: an error with it isn't a reason to look further", () => {
  process.env["ORIGINCLOUD_OIDC_TOKEN"] = "job-token";
  process.env["ORIGINCLOUD_CREDENTIALS_FILE"] = join(dir, "missing.json");
  assert.throws(() => defaultCredentials(), /^Error: origincloud: reading the credentials file .*missing\.json: /);
  process.env["ORIGINCLOUD_CREDENTIALS_FILE"] = write("broken.json", "{");
  assert.throws(() => defaultCredentials(), /^Error: origincloud: the credentials file .*broken\.json is not JSON/);
});

test("the default chain: an access token, the credentials file, a CI job's token, the CLI session, the metadata service", async () => {
  // Every source is there; each one taken away leaves the next.
  process.env["ORIGINCLOUD_ACCESS_TOKEN"] = "from-env";
  process.env["ORIGINCLOUD_CREDENTIALS_FILE"] = write("key.json", newCredentialsFile().json);
  process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"] = write("oidc-token", "job-token");
  process.env["ORIGINCLOUD_OIDC_TOKEN"] = "job-token";
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "http://127.0.0.1:1/idtoken";
  process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
  const session = { access_token: "from-session", expires: new Date(Date.now() + 3600_000).toISOString() };
  mkdirSync(join(dir, "origincloud"), { recursive: true });
  write(join("origincloud", "session.json"), JSON.stringify(session));

  assert.equal(await defaultCredentials().token(), "from-env");
  delete process.env["ORIGINCLOUD_ACCESS_TOKEN"];
  assert.ok(defaultCredentials() instanceof ServiceAccountKeyCredentials);
  delete process.env["ORIGINCLOUD_CREDENTIALS_FILE"];
  assert.ok(defaultCredentials() instanceof FederatedCredentials);
  for (const name of ["ORIGINCLOUD_OIDC_TOKEN_FILE", "ORIGINCLOUD_OIDC_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL"]) {
    delete process.env[name];
  }
  assert.ok(defaultCredentials() instanceof CLISessionCredentials);
  assert.equal(await defaultCredentials().token(), "from-session");
  process.env["XDG_DATA_HOME"] = join(dir, "elsewhere");
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials);
});
