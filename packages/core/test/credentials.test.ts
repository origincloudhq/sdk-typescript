import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  CLISessionCredentials,
  Client,
  InstanceMetadataCredentials,
  METADATA_ENDPOINT,
  NoCredentialsError,
  ServiceAccountCredentials,
  cliSession,
  defaultCredentials,
  instanceMetadata,
} from "@origincloud/core";

import { type Received, json, serve } from "../../../test-support/fake-server.js";

const ENV = [
  "ORIGINCLOUD_ACCESS_TOKEN",
  "ORIGINCLOUD_CLIENT_ID",
  "ORIGINCLOUD_CLIENT_SECRET",
  "ORIGINCLOUD_REGION",
  "ORIGINCLOUD_METADATA_DISABLED",
  "ORIGINCLOUD_METADATA_ENDPOINT",
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
  const answers: [number, RegExp | typeof NoCredentialsError][] = [
    [404, NoCredentialsError],
    [403, /refused a request that came through a proxy$/],
    [400, /^Error: origincloud: the metadata service refused a session \(HTTP 400\)$/],
  ];
  for (const [status, expected] of answers) {
    const server = await serve((_, res) => {
      res.writeHead(status).end();
    });
    closers.push(server.close);
    await assert.rejects(instanceMetadata({ endpoint: server.url }).token(), expected);
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
