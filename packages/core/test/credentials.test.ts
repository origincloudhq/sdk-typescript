import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

import {
  CLISessionCredentials,
  Client,
  NoCredentialsError,
  ServiceAccountCredentials,
  cliSession,
  defaultCredentials,
} from "@origincloud/core";

import { json, serve } from "../../../test-support/fake-server.js";

const ENV = ["ORIGINCLOUD_ACCESS_TOKEN", "ORIGINCLOUD_CLIENT_ID", "ORIGINCLOUD_CLIENT_SECRET", "ORIGINCLOUD_REGION"];
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

test("no credentials at all", () => {
  assert.throws(() => defaultCredentials(), NoCredentialsError);
  assert.throws(() => new Client(), NoCredentialsError);
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
