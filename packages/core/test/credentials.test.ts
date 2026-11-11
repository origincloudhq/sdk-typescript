import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  CLISessionCredentials,
  Client,
  FederatedCredentials,
  InstanceMetadataCredentials,
  METADATA_ENDPOINT,
  NoCredentialsError,
  OIDC_AUDIENCE,
  STS_ENDPOINT,
  ServiceAccountCredentials,
  cliSession,
  defaultCredentials,
  federated,
  githubActions,
  instanceMetadata,
  oidcToken,
  oidcTokenFile,
} from "@origincloud/core";

import { type Received, json, serve } from "../../../test-support/fake-server.js";

const ENV = [
  "ORIGINCLOUD_ACCESS_TOKEN",
  "ORIGINCLOUD_CLIENT_ID",
  "ORIGINCLOUD_CLIENT_SECRET",
  "ORIGINCLOUD_REGION",
  "ORIGINCLOUD_METADATA_DISABLED",
  "ORIGINCLOUD_METADATA_ENDPOINT",
  "ORIGINCLOUD_OIDC_DISABLED",
  "ORIGINCLOUD_OIDC_TOKEN_FILE",
  // GitLab CI sets this when a job's `id_tokens` names it.
  "ORIGINCLOUD_OIDC_TOKEN",
  "ORIGINCLOUD_OIDC_AUDIENCE",
  "ORIGINCLOUD_STS_ENDPOINT",
  // A GitHub Actions runner sets these when its workflow may request an OIDC token.
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
// directory of its own.
beforeEach(() => {
  for (const name of ENV) delete process.env[name];
  dataHome = mkdtempSync(join(tmpdir(), "origincloud-sdk-test-"));
  dirs.push(dataHome);
  process.env["XDG_DATA_HOME"] = dataHome;
});

/**
 * A token endpoint answering with access tokens numbered from 1, expiring
 * after `expiresIn` seconds; it records the forms it got.
 */
async function tokenServer(expiresIn: number) {
  const forms: URLSearchParams[] = [];
  const server = await serve((req, res) => {
    const form = new URLSearchParams(req.body);
    forms.push(form);
    if (form.get("client_secret") === "wrong") {
      json(res, { error: "unauthorized_client", error_description: "Invalid client secret" }, 401);
      return;
    }
    json(res, {
      access_token: `token-${forms.length}`,
      expires_in: expiresIn,
      refresh_token: `refresh-${forms.length}`,
      refresh_expires_in: 1800,
    });
  });
  closers.push(server.close);
  return { url: server.url, forms };
}

function writeSession(session: Record<string, string>): string {
  const path = join(dataHome, "origincloud", "session.json");
  mkdirSync(join(dataHome, "origincloud"), { recursive: true });
  writeFileSync(path, JSON.stringify(session));
  return path;
}

const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();
const anHourAgo = () => new Date(Date.now() - 3600_000).toISOString();

test("an access token in the environment comes first", async () => {
  process.env["ORIGINCLOUD_ACCESS_TOKEN"] = "from-env";
  process.env["ORIGINCLOUD_CLIENT_ID"] = "id";
  process.env["ORIGINCLOUD_CLIENT_SECRET"] = "secret";
  writeSession({ access_token: "from-session", expires: inAnHour() });
  assert.equal(await defaultCredentials().token(), "from-env");
});

test("a service account in the environment comes before the CLI session", () => {
  process.env["ORIGINCLOUD_CLIENT_ID"] = "id";
  process.env["ORIGINCLOUD_CLIENT_SECRET"] = "secret";
  writeSession({ access_token: "from-session", expires: inAnHour() });
  const credentials = defaultCredentials();
  assert.ok(credentials instanceof ServiceAccountCredentials);
  assert.equal(credentials.clientId, "id");
  assert.equal(credentials.tokenUrl, "https://auth.origincloud.eu/realms/origincloud/protocol/openid-connect/token");
});

test("half a service account is refused", () => {
  writeSession({ access_token: "from-session", expires: inAnHour() });
  process.env["ORIGINCLOUD_CLIENT_ID"] = "id";
  assert.throws(() => defaultCredentials(), /must be set together/);
  delete process.env["ORIGINCLOUD_CLIENT_ID"];
  process.env["ORIGINCLOUD_CLIENT_SECRET"] = "secret";
  assert.throws(() => defaultCredentials(), /must be set together/);
});

test("without the environment or a CLI session, the instance's metadata service is asked", () => {
  const credentials = defaultCredentials();
  assert.ok(credentials instanceof InstanceMetadataCredentials);
  assert.equal(credentials.endpoint, METADATA_ENDPOINT);
  assert.equal(METADATA_ENDPOINT, "http://169.254.169.254");

  process.env["ORIGINCLOUD_METADATA_ENDPOINT"] = "http://127.0.0.1:8080/";
  const elsewhere = defaultCredentials();
  assert.ok(elsewhere instanceof InstanceMetadataCredentials);
  assert.equal(elsewhere.endpoint, "http://127.0.0.1:8080");
});

test("no credentials at all", () => {
  process.env["ORIGINCLOUD_METADATA_DISABLED"] = "TRUE";
  assert.throws(() => defaultCredentials(), NoCredentialsError);
  assert.throws(() => new Client(), NoCredentialsError);
  assert.throws(
    () => defaultCredentials(),
    /log in with `origin id login`, or run on an instance that runs as a service account$/,
  );
  process.env["ORIGINCLOUD_METADATA_DISABLED"] = "1";
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials, "only `true` disables it");
});

test("a service account token is reused until it is about to expire", async () => {
  const { url, forms } = await tokenServer(3600);
  const credentials = new ServiceAccountCredentials("id", "secret", { tokenUrl: url });
  assert.equal(await credentials.token(), "token-1");
  assert.equal(await credentials.token(), "token-1");
  assert.equal(forms.length, 1);
  assert.equal(forms[0]?.get("grant_type"), "client_credentials");
  assert.equal(forms[0]?.get("client_id"), "id");
  assert.equal(forms[0]?.get("client_secret"), "secret");

  // A token within the expiry margin is replaced.
  const short = await tokenServer(10);
  const renewing = new ServiceAccountCredentials("id", "secret", { tokenUrl: short.url });
  assert.equal(await renewing.token(), "token-1");
  assert.equal(await renewing.token(), "token-2");

  // Concurrent callers share one request.
  const shared = await tokenServer(3600);
  const concurrent = new ServiceAccountCredentials("id", "secret", { tokenUrl: shared.url });
  const tokens = await Promise.all([concurrent.token(), concurrent.token(), concurrent.token()]);
  assert.deepEqual(tokens, ["token-1", "token-1", "token-1"]);
  assert.equal(shared.forms.length, 1);
});

test("a refused service account says why", async () => {
  const { url } = await tokenServer(3600);
  const credentials = new ServiceAccountCredentials("id", "wrong", { tokenUrl: url });
  await assert.rejects(credentials.token(), /refused \(HTTP 401\): Invalid client secret/);
});

test("the CLI session is used as stored", async () => {
  writeSession({
    access_token: "from-session",
    expires: inAnHour(),
    refresh_token: "r",
    refresh_expires: inAnHour(),
  });
  const credentials = defaultCredentials();
  assert.ok(credentials instanceof CLISessionCredentials);
  assert.equal(await credentials.token(), "from-session");
});

test("an expired CLI session is renewed without writing its file", async () => {
  const path = writeSession({
    access_token: "expired",
    expires: anHourAgo(),
    refresh_token: "stored-refresh",
    refresh_expires: inAnHour(),
  });
  const before = readFileSync(path, "utf8");
  const { url, forms } = await tokenServer(300);
  const session = cliSession({ tokenUrl: url });
  assert.ok(session);
  assert.equal(await session.token(), "token-1");
  assert.equal(forms[0]?.get("grant_type"), "refresh_token");
  assert.equal(forms[0]?.get("client_id"), "origin-cli");
  assert.equal(forms[0]?.get("refresh_token"), "stored-refresh");
  assert.equal(readFileSync(path, "utf8"), before, "the CLI's file is never written");
});

test("a CLI session past its refresh expiry asks to log in", async () => {
  writeSession({
    access_token: "expired",
    expires: anHourAgo(),
    refresh_token: "r",
    refresh_expires: anHourAgo(),
  });
  const session = cliSession();
  assert.ok(session);
  await assert.rejects(session.token(), /log in again with `origin id login`/);
});

test("a caller that aborts doesn't stop the renewal the others share", async () => {
  let answer: (response: Response) => void = () => {};
  const signals: (AbortSignal | null | undefined)[] = [];
  const credentials = new ServiceAccountCredentials("id", "secret", {
    fetch: (_, init) => {
      signals.push(init.signal);
      return new Promise<Response>((resolve) => (answer = resolve));
    },
  });
  const aborting = new AbortController();
  const a = credentials.token(aborting.signal);
  const b = credentials.token();
  aborting.abort(new Error("A gave up"));
  await assert.rejects(a, /A gave up/);

  answer(new Response(JSON.stringify({ access_token: "shared", expires_in: 300 }), { status: 200 }));
  assert.equal(await b, "shared");
  assert.equal(signals.length, 1, "one renewal");
  assert.equal(signals[0], undefined, "the renewal runs without a caller's signal");
});

test("a malformed time in the CLI session is an error", () => {
  writeSession({ access_token: "a", expires: inAnHour(), refresh_token: "r", refresh_expires: "tomorrow" });
  assert.throws(() => cliSession(), /refresh_expires isn't an RFC 3339 time/);
  assert.throws(() => defaultCredentials(), /refresh_expires isn't an RFC 3339 time/);
  writeSession({ access_token: "a", expires: "", refresh_token: "r", refresh_expires: inAnHour() });
  assert.throws(() => cliSession(), /expires isn't an RFC 3339 time/);
});

/**
 * A metadata service handing out sessions numbered from 1 and the access
 * tokens `credential` answers with, by the session presented; it records
 * the requests it got.
 */
async function metadataServer(credential: (session: string, request: Received) => { status: number; body: unknown }) {
  const requests: Received[] = [];
  let sessions = 0;
  const server = await serve((req, res) => {
    requests.push(req);
    if (req.method === "PUT" && req.path === "/latest/api/token") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`session-${++sessions}`);
      return;
    }
    if (req.method === "GET" && req.path === "/latest/meta-data/service-account/token") {
      const { status, body } = credential(String(req.headers["x-origincloud-metadata-token"]), req);
      json(res, body, status);
      return;
    }
    res.writeHead(404).end();
  });
  closers.push(server.close);
  return { url: server.url, requests };
}

const granted = (token: string, expiresAt = inAnHour()) => ({
  status: 200,
  body: { access_token: token, token_type: "Bearer", expires_at: expiresAt },
});

test("an instance's token comes from its metadata service and is reused until it is about to expire", async () => {
  const { url, requests } = await metadataServer((session) => granted(`token-for-${session}`));
  const credentials = instanceMetadata({ endpoint: url });
  assert.equal(requests.length, 0, "creating them sends no request");
  assert.equal(await credentials.token(), "token-for-session-1");
  assert.equal(await credentials.token(), "token-for-session-1");
  assert.deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    ["PUT /latest/api/token", "GET /latest/meta-data/service-account/token"],
  );
  assert.equal(requests[0]?.headers["x-origincloud-metadata-token-ttl-seconds"], "21600");
  assert.equal(requests[1]?.headers["x-origincloud-metadata-token"], "session-1");

  // A token within the expiry margin is replaced, with the same session.
  let issued = 0;
  const short = await metadataServer(() => granted(`token-${++issued}`, new Date(Date.now() + 10_000).toISOString()));
  const renewing = instanceMetadata({ endpoint: short.url });
  assert.equal(await renewing.token(), "token-1");
  assert.equal(await renewing.token(), "token-2");
  assert.equal(short.requests.filter((r) => r.method === "PUT").length, 1);

  // Its margin is a minute, not the 30 seconds of other tokens.
  const soon = await metadataServer(() => granted(`token-${++issued}`, new Date(Date.now() + 45_000).toISOString()));
  const early = instanceMetadata({ endpoint: soon.url });
  assert.equal(await early.token(), "token-3");
  assert.equal(await early.token(), "token-4");
  const later = await metadataServer(() => granted(`token-${++issued}`, new Date(Date.now() + 90_000).toISOString()));
  const kept = instanceMetadata({ endpoint: later.url });
  assert.equal(await kept.token(), "token-5");
  assert.equal(await kept.token(), "token-5");
});

test("a session the metadata service refuses is opened again, once", async () => {
  const { url, requests } = await metadataServer((session) =>
    session === "session-1" ? { status: 401, body: "" } : granted(`token-for-${session}`),
  );
  assert.equal(await instanceMetadata({ endpoint: url }).token(), "token-for-session-2");
  assert.equal(requests.length, 4);

  const refusing = await metadataServer(() => ({ status: 401, body: "" }));
  await assert.rejects(
    instanceMetadata({ endpoint: refusing.url }).token(),
    /^Error: origincloud: the metadata service answered HTTP 401$/,
  );
  assert.equal(refusing.requests.length, 4, "one retry");
});

test("the metadata service's refusals say why", async () => {
  const cases: [{ status: number; body: unknown }, RegExp][] = [
    [{ status: 404, body: "" }, /^Error: origincloud: the instance runs as no service account$/],
    [
      { status: 403, body: "" },
      /^Error: origincloud: the metadata service refused a request that came through a proxy$/,
    ],
    [{ status: 503, body: "" }, /^Error: origincloud: the metadata service answered HTTP 503$/],
    [{ status: 200, body: "not json" }, /the metadata service's answer is not a credential$/],
    [{ status: 200, body: { access_token: "", expires_at: inAnHour() } }, /is not a credential$/],
    [{ status: 200, body: { access_token: "t", expires_at: "tomorrow" } }, /is not a credential$/],
  ];
  for (const [answer, message] of cases) {
    const { url } = await metadataServer(() => answer);
    await assert.rejects(instanceMetadata({ endpoint: url }).token(), message);
  }
});

test("a refused metadata session says why", async () => {
  const answers: [number, RegExp][] = [
    [403, /refused a request that came through a proxy$/],
    [503, /^Error: origincloud: the metadata service refused a session \(HTTP 503\)$/],
  ];
  for (const [status, expected] of answers) {
    const server = await serve((_, res) => {
      res.writeHead(status).end();
    });
    closers.push(server.close);
    await assert.rejects(instanceMetadata({ endpoint: server.url }).token(), expected);
  }
});

test("another cloud's metadata service, or no instance's address, means no credentials", async () => {
  // Such as AWS's 400, GCP's 404 or 405 and Azure's 411 to a request they don't know.
  for (const status of [400, 404, 405, 411]) {
    const server = await serve((_, res) => {
      res.writeHead(status).end();
    });
    closers.push(server.close);
    await assert.rejects(instanceMetadata({ endpoint: server.url }).token(), NoCredentialsError, `HTTP ${status}`);
  }
});

test("where no metadata service answers, there are no credentials, at once", async () => {
  const server = await serve((_, res) => {
    res.end();
  });
  await server.close();
  const started = Date.now();
  await assert.rejects(instanceMetadata({ endpoint: server.url }).token(), NoCredentialsError);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

test("a metadata service that doesn't answer is given up on within two seconds", async () => {
  const server = await serve(() => new Promise<void>(() => {}));
  closers.push(server.close);
  const started = Date.now();
  await assert.rejects(instanceMetadata({ endpoint: server.url }).token(), NoCredentialsError);
  const took = Date.now() - started;
  assert.ok(took >= 1900 && took < 3000, `took ${took} ms`);
});

/**
 * A metadata service answering each request with the next of `statuses`
 * for its path, then 200; it records when requests came.
 */
async function busyServer(statuses: Record<string, number[]>) {
  const times: Record<string, number[]> = {};
  const server = await serve((req, res) => {
    (times[req.method] ??= []).push(Date.now());
    const status = statuses[req.method]?.shift() ?? 200;
    if (status !== 200) {
      res.writeHead(status).end();
    } else if (req.method === "PUT") {
      res.end("session");
    } else {
      json(res, { access_token: "after-503", expires_at: inAnHour() });
    }
  });
  closers.push(server.close);
  return { url: server.url, times };
}

test("a 503 is tried again after 100 ms, then 200 ms", async () => {
  const { url, times } = await busyServer({ PUT: [503], GET: [503, 503] });
  assert.equal(await instanceMetadata({ endpoint: url }).token(), "after-503");
  assert.equal(times["PUT"]?.length, 2);
  assert.equal(times["GET"]?.length, 3);
  const [first = 0, second = 0, third = 0] = times["GET"] ?? [];
  assert.ok(second - first >= 90 && third - second >= 190, `waited ${second - first} and ${third - second} ms`);

  const unavailable = await busyServer({ GET: [503, 503, 503] });
  await assert.rejects(
    instanceMetadata({ endpoint: unavailable.url }).token(),
    /^Error: origincloud: the metadata service answered HTTP 503$/,
  );
  assert.equal(unavailable.times["GET"]?.length, 3, "three attempts in all");

  const noSession = await busyServer({ PUT: [503, 503, 503] });
  await assert.rejects(
    instanceMetadata({ endpoint: noSession.url }).token(),
    /^Error: origincloud: the metadata service refused a session \(HTTP 503\)$/,
  );
  assert.equal(noSession.times["PUT"]?.length, 3);
});

test("a caller that aborts stops waiting for the metadata service's retries", async () => {
  const { url } = await busyServer({ GET: [503, 503, 503] });
  const aborting = new AbortController();
  const started = Date.now();
  const pending = instanceMetadata({ endpoint: url }).token(aborting.signal);
  setTimeout(() => aborting.abort(new Error("gave up")), 50);
  await assert.rejects(pending, /gave up/);
  assert.ok(Date.now() - started < 250, `took ${Date.now() - started} ms`);
});

test("the metadata credentials send their requests with the fetch they are given", async () => {
  const sent: string[] = [];
  const credentials = new InstanceMetadataCredentials({
    endpoint: "http://metadata.test",
    fetch: async (input, init) => {
      sent.push(`${init.method} ${input}`);
      if (init.method === "PUT") return new Response("s", { status: 200 });
      return new Response(JSON.stringify({ access_token: "via-fetch", expires_at: inAnHour() }), { status: 200 });
    },
  });
  assert.equal(await credentials.token(), "via-fetch");
  assert.deepEqual(sent, [
    "PUT http://metadata.test/latest/api/token",
    "GET http://metadata.test/latest/meta-data/service-account/token",
  ]);
});

/**
 * An STS answering token exchanges with access tokens numbered from 1,
 * expiring after `expiresIn` seconds, unless `answer` answers otherwise; it
 * records the forms it got and when.
 */
async function stsServer(expiresIn: number, answer?: (form: URLSearchParams) => { status: number; body: unknown } | undefined) {
  const forms: URLSearchParams[] = [];
  const times: number[] = [];
  const requests: Received[] = [];
  const server = await serve((req, res) => {
    requests.push(req);
    const form = new URLSearchParams(req.body);
    forms.push(form);
    times.push(Date.now());
    const answered = answer?.(form);
    if (answered) {
      json(res, answered.body, answered.status);
      return;
    }
    json(res, {
      access_token: `access-${forms.length}`,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: expiresIn,
    });
  });
  closers.push(server.close);
  return { url: server.url, forms, times, requests };
}

/**
 * GitHub Actions' token endpoint, answering with job tokens numbered from
 * 1, or `status` when it is set; it records the requests it got.
 */
async function githubServer(status = 200) {
  const requests: Received[] = [];
  const server = await serve((req, res) => {
    requests.push(req);
    if (status !== 200) {
      json(res, { message: "Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable" }, status);
      return;
    }
    json(res, { count: 1, value: `job-token-${requests.length}` });
  });
  closers.push(server.close);
  return { url: server.url, requests };
}

/** Points GitHub Actions' environment variables at `url`, as a runner sets them. */
function inGitHubActions(url: string) {
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = `${url}/idtoken?api-version=2.0`;
  process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
}

/** An unsigned JWT whose payload holds `claims`. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
}

function writeTokenFile(token: string): string {
  const path = join(dataHome, "oidc-token");
  writeFileSync(path, token);
  return path;
}

test("a GitHub Actions job's token is requested for the STS and exchanged there", async () => {
  const github = await githubServer();
  const sts = await stsServer(900);
  inGitHubActions(github.url);
  const credentials = githubActions({ endpoint: sts.url + "/" });
  assert.equal(sts.forms.length + github.requests.length, 0, "creating them sends no request");
  assert.equal(await credentials.token(), "access-1");

  const [request] = github.requests;
  assert.equal(request?.method, "GET");
  assert.equal(request?.path, "/idtoken");
  assert.equal(request?.query.get("api-version"), "2.0");
  assert.equal(request?.query.get("audience"), "https://sts.origincloudapis.eu");
  assert.equal(request?.headers["authorization"], "bearer request-token");
  assert.equal(OIDC_AUDIENCE, "https://sts.origincloudapis.eu");

  assert.equal(sts.requests[0]?.method, "POST");
  assert.equal(sts.requests[0]?.path, "/v1/token");
  assert.equal(sts.requests[0]?.headers["content-type"], "application/x-www-form-urlencoded");
  assert.deepEqual(Object.fromEntries(sts.forms[0] ?? []), {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: "job-token-1",
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });

  // A request URL without a query gets one; the audience is encoded.
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = `${github.url}/plain`;
  await githubActions({ endpoint: sts.url, audience: "api://a b&c" }).token();
  assert.equal(github.requests[1]?.path, "/plain");
  assert.deepEqual([...(github.requests[1]?.query ?? [])], [["audience", "api://a b&c"]]);
});

test("an exchanged token is reused until a minute before its expiry, then renewed with a fresh job token", async () => {
  const github = await githubServer();
  inGitHubActions(github.url);

  const sts = await stsServer(3600);
  const credentials = githubActions({ endpoint: sts.url });
  assert.equal(await credentials.token(), "access-1");
  assert.equal(await credentials.token(), "access-1");
  assert.equal(sts.forms.length, 1);

  // Its margin is a minute.
  const soon = await stsServer(45);
  const renewing = githubActions({ endpoint: soon.url });
  assert.equal(await renewing.token(), "access-1");
  assert.equal(await renewing.token(), "access-2");
  assert.deepEqual(
    soon.forms.map((f) => f.get("subject_token")),
    ["job-token-2", "job-token-3"],
    "every exchange asks GitHub for a fresh job token",
  );
  const later = await stsServer(90);
  const kept = githubActions({ endpoint: later.url });
  assert.equal(await kept.token(), "access-1");
  assert.equal(await kept.token(), "access-1");

  // Concurrent callers share one exchange.
  const shared = await stsServer(900);
  const concurrent = githubActions({ endpoint: shared.url });
  const tokens = await Promise.all([concurrent.token(), concurrent.token(), concurrent.token()]);
  assert.deepEqual(tokens, ["access-1", "access-1", "access-1"]);
  assert.equal(shared.forms.length, 1);
});

test("the token file is read again at every exchange", async () => {
  const path = writeTokenFile("file-token-1\n");
  const sts = await stsServer(30);
  const credentials = oidcTokenFile(path, { endpoint: sts.url });
  assert.equal(await credentials.token(), "access-1");
  writeTokenFile("file-token-2");
  assert.equal(await credentials.token(), "access-2");
  assert.deepEqual(
    sts.forms.map((f) => f.get("subject_token")),
    ["file-token-1", "file-token-2"],
  );

  writeTokenFile(" \n");
  await assert.rejects(oidcTokenFile(path, { endpoint: sts.url }).token(), /the OIDC token file .* is empty$/);
  await assert.rejects(
    oidcTokenFile(join(dataHome, "missing"), { endpoint: sts.url }).token(),
    /^Error: origincloud: reading the OIDC token file: .*ENOENT/,
  );
  assert.equal(sts.forms.length, 2, "nothing is exchanged without a token");
});

test("a token given as it is is exchanged again at every renewal, until it expires", async () => {
  const jobToken = unsignedJwt({ sub: "project_path:group/app", exp: Math.floor(Date.now() / 1000) + 3600 });
  const sts = await stsServer(30);
  const credentials = oidcToken(jobToken, { endpoint: sts.url });
  assert.ok(credentials instanceof FederatedCredentials);
  assert.equal(sts.forms.length, 0, "creating them sends no request");
  assert.equal(await credentials.token(), "access-1");
  assert.equal(await credentials.token(), "access-2");
  assert.equal(await credentials.token(), "access-3");
  assert.deepEqual(
    sts.forms.map((f) => f.get("subject_token")),
    [jobToken, jobToken, jobToken],
  );

  const expired = unsignedJwt({ sub: "project_path:group/app", exp: 1_700_000_000 });
  const err = await oidcToken(expired, { endpoint: sts.url })
    .token()
    .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
  assert.equal(
    err.message,
    "origincloud: the CI job's OIDC token expired at 2023-11-14T22:13:20.000Z: a token given as it is " +
      "can't be renewed: ask the CI provider for a longer-lived one, or use ORIGINCLOUD_OIDC_TOKEN_FILE",
  );
  assert.ok(!err.message.includes(expired));
  assert.equal(sts.forms.length, 3, "an expired token isn't sent");

  // A token whose expiry can't be read is the STS's to judge.
  for (const opaque of ["not-a-jwt", "a.!!!.c", unsignedJwt({ sub: "no-exp" }), unsignedJwt({ exp: "soon" })]) {
    const expected: string = `access-${sts.forms.length + 1}`;
    assert.equal(await oidcToken(opaque, { endpoint: sts.url }).token(), expected);
    assert.equal(sts.forms.at(-1)?.get("subject_token"), opaque);
  }
});

test("any source of job tokens can be exchanged, with the fetch given", async () => {
  const sent: string[] = [];
  let issued = 0;
  const credentials = federated(() => `own-token-${++issued}`, {
    fetch: async (input, init) => {
      sent.push(`${init.method} ${input} ${String(init.body)}`);
      return new Response(JSON.stringify({ access_token: "via-fetch", expires_in: 900 }), { status: 200 });
    },
  });
  assert.ok(credentials instanceof FederatedCredentials);
  assert.equal(credentials.endpoint, STS_ENDPOINT);
  assert.equal(STS_ENDPOINT, "https://sts.origincloudapis.eu");
  assert.equal(await credentials.token(), "via-fetch");
  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /^POST https:\/\/sts\.origincloudapis\.eu\/v1\/token .*subject_token=own-token-1&/);

  await assert.rejects(federated(() => "").token(), /^Error: origincloud: the CI job's OIDC token is empty$/);
});

test("an STS answering 503 is tried again after 200 ms, then 400 ms", async () => {
  let unavailable = 2;
  const sts = await stsServer(900, () =>
    unavailable-- > 0 ? { status: 503, body: { error: "temporarily_unavailable" } } : undefined,
  );
  const path = writeTokenFile("file-token");
  assert.equal(await oidcTokenFile(path, { endpoint: sts.url }).token(), "access-3");
  const [first = 0, second = 0, third = 0] = sts.times;
  assert.ok(second - first >= 190 && third - second >= 390, `waited ${second - first} and ${third - second} ms`);

  const down = await stsServer(900, () => ({ status: 503, body: { error: "temporarily_unavailable" } }));
  await assert.rejects(
    oidcTokenFile(path, { endpoint: down.url }).token(),
    /^Error: origincloud: the STS is temporarily unavailable \(HTTP 503\): try again later$/,
  );
  assert.equal(down.forms.length, 3, "three attempts in all");
});

test("a job token the STS refuses says what to check, and never shows a token", async () => {
  const path = writeTokenFile("secret-job-token");
  const refusing = await stsServer(900, () => ({ status: 400, body: { error: "invalid_grant" } }));
  const err = await oidcTokenFile(path, { endpoint: refusing.url })
    .token()
    .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
  assert.match(
    err.message,
    /^origincloud: the STS refused the CI job's OIDC token \(invalid_grant\): check the federated credential's issuer, audience and conditions against the token's claims$/,
  );
  assert.equal(refusing.forms.length, 1, "a refusal isn't retried");

  const malformed = await stsServer(900, (form) => ({
    status: 400,
    body: { error: "invalid_request", error_description: `unsupported subject_token ${form.get("subject_token")}` },
  }));
  await assert.rejects(
    oidcTokenFile(path, { endpoint: malformed.url }).token(),
    /^Error: origincloud: the STS refused the token exchange \(HTTP 400\): invalid_request: unsupported subject_token \[token\]$/,
  );

  const broken = await stsServer(900, () => ({ status: 200, body: { token_type: "Bearer" } }));
  await assert.rejects(oidcTokenFile(path, { endpoint: broken.url }).token(), /the STS's answer is not a credential$/);
  const failing = await stsServer(900, () => ({ status: 500, body: "oops" }));
  await assert.rejects(
    oidcTokenFile(path, { endpoint: failing.url }).token(),
    /^Error: origincloud: the STS refused the token exchange \(HTTP 500\)$/,
  );
});

test("a failed GitHub token request names `permissions: id-token: write`, and never the request token", async () => {
  const sts = await stsServer(900);
  for (const status of [403, 404, 500]) {
    const github = await githubServer(status);
    inGitHubActions(github.url);
    const err = await githubActions({ endpoint: sts.url })
      .token()
      .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
    assert.match(
      err.message,
      new RegExp(
        `^origincloud: requesting the job's OIDC token from GitHub Actions: HTTP ${status}: ` +
          "does the workflow grant `permissions: id-token: write`\\?$",
      ),
    );
    assert.ok(!err.message.includes("request-token"));
  }
  assert.equal(sts.forms.length, 0);

  delete process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
  assert.throws(
    () => githubActions(),
    /ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN aren't set: the workflow needs `permissions: id-token: write`$/,
  );
});

test("in the default chain, a CI job's token comes after the service account and before the CLI session", async () => {
  const github = await githubServer();
  const sts = await stsServer(900);
  inGitHubActions(github.url);
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  process.env["ORIGINCLOUD_OIDC_AUDIENCE"] = "api://custom";
  writeSession({ access_token: "from-session", expires: inAnHour(), refresh_token: "r", refresh_expires: inAnHour() });

  const credentials = defaultCredentials();
  assert.ok(credentials instanceof FederatedCredentials);
  assert.equal(credentials.endpoint, sts.url);
  assert.equal(await credentials.token(), "access-1");
  assert.equal(github.requests[0]?.query.get("audience"), "api://custom");

  process.env["ORIGINCLOUD_CLIENT_ID"] = "id";
  process.env["ORIGINCLOUD_CLIENT_SECRET"] = "secret";
  assert.ok(defaultCredentials() instanceof ServiceAccountCredentials);
  process.env["ORIGINCLOUD_ACCESS_TOKEN"] = "from-env";
  assert.equal(await defaultCredentials().token(), "from-env");

  delete process.env["ORIGINCLOUD_STS_ENDPOINT"];
  delete process.env["ORIGINCLOUD_CLIENT_ID"];
  delete process.env["ORIGINCLOUD_CLIENT_SECRET"];
  delete process.env["ORIGINCLOUD_ACCESS_TOKEN"];
  const byDefault = defaultCredentials();
  assert.ok(byDefault instanceof FederatedCredentials);
  assert.equal(byDefault.endpoint, STS_ENDPOINT);
});

test("in the default chain, the token file comes before GitHub Actions", async () => {
  const github = await githubServer();
  const sts = await stsServer(900);
  inGitHubActions(github.url);
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"] = writeTokenFile("file-token");
  assert.equal(await defaultCredentials().token(), "access-1");
  assert.equal(sts.forms[0]?.get("subject_token"), "file-token");
  assert.equal(github.requests.length, 0);
});

test("in the default chain, the token in ORIGINCLOUD_OIDC_TOKEN comes after the token file and before GitHub Actions", async () => {
  const github = await githubServer();
  const sts = await stsServer(900);
  inGitHubActions(github.url);
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  process.env["ORIGINCLOUD_OIDC_AUDIENCE"] = "api://ignored";
  const jobToken = unsignedJwt({ sub: "project_path:group/app", exp: Math.floor(Date.now() / 1000) + 3600 });
  process.env["ORIGINCLOUD_OIDC_TOKEN"] = jobToken;

  const credentials = defaultCredentials();
  assert.ok(credentials instanceof FederatedCredentials);
  assert.equal(credentials.endpoint, sts.url);
  assert.equal(await credentials.token(), "access-1");
  assert.equal(sts.forms[0]?.get("subject_token"), jobToken);
  assert.equal(github.requests.length, 0);

  process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"] = writeTokenFile("file-token");
  assert.equal(await defaultCredentials().token(), "access-2");
  assert.equal(sts.forms[1]?.get("subject_token"), "file-token");
  delete process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"];

  // The variable is read when the chain runs.
  const found = defaultCredentials();
  process.env["ORIGINCLOUD_OIDC_TOKEN"] = "changed-later";
  assert.equal(await found.token(), "access-3");
  assert.equal(sts.forms[2]?.get("subject_token"), jobToken);

  const expired = unsignedJwt({ sub: "project_path:group/app", exp: Math.floor(Date.now() / 1000) - 60 });
  process.env["ORIGINCLOUD_OIDC_TOKEN"] = expired;
  const err = await defaultCredentials()
    .token()
    .then(() => assert.fail("resolved"), (e: unknown) => e as Error);
  assert.match(
    err.message,
    /^origincloud: the CI job's OIDC token in ORIGINCLOUD_OIDC_TOKEN expired at \d{4}-\d{2}-\d{2}T[\d:.]+Z: a token given as it is can't be renewed: ask the CI provider for a longer-lived one, or use ORIGINCLOUD_OIDC_TOKEN_FILE$/,
  );
  assert.ok(!err.message.includes(expired));
  assert.equal(sts.forms.length, 3, "an expired token isn't sent");
  assert.equal(github.requests.length, 0);

  process.env["ORIGINCLOUD_OIDC_DISABLED"] = "true";
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials);
});

test("a CI job's token that fails is the default chain's error, not a reason to look further", async () => {
  const github = await githubServer(403);
  const sts = await stsServer(900);
  inGitHubActions(github.url);
  process.env["ORIGINCLOUD_STS_ENDPOINT"] = sts.url;
  writeSession({ access_token: "from-session", expires: inAnHour(), refresh_token: "r", refresh_expires: inAnHour() });
  await assert.rejects(defaultCredentials().token(), /permissions: id-token: write/);

  process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"] = join(dataHome, "missing");
  await assert.rejects(defaultCredentials().token(), /reading the OIDC token file/);
});

test("ORIGINCLOUD_OIDC_DISABLED=true leaves the CI job's token out of the default chain", async () => {
  const github = await githubServer();
  inGitHubActions(github.url);
  process.env["ORIGINCLOUD_OIDC_TOKEN_FILE"] = writeTokenFile("file-token");
  process.env["ORIGINCLOUD_OIDC_DISABLED"] = "True";
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials);
  writeSession({ access_token: "from-session", expires: inAnHour(), refresh_token: "r", refresh_expires: inAnHour() });
  assert.equal(await defaultCredentials().token(), "from-session");
  assert.equal(github.requests.length, 0);

  process.env["ORIGINCLOUD_OIDC_DISABLED"] = "1";
  assert.ok(defaultCredentials() instanceof FederatedCredentials, "only `true` disables it");
});

test("half of GitHub Actions' variables is no CI job's token", () => {
  process.env["ACTIONS_ID_TOKEN_REQUEST_URL"] = "http://127.0.0.1:1/idtoken";
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials);
  delete process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
  process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"] = "request-token";
  assert.ok(defaultCredentials() instanceof InstanceMetadataCredentials);
});
