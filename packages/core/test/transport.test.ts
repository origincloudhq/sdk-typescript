import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { after, afterEach, test } from "node:test";

import {
  CONSISTENCY_TOKEN_HEADER,
  Client,
  OriginCloudError,
  VERSION,
  accessToken,
  newRequestId,
  pathValue,
  query,
  reasonOf,
} from "@origincloud/core";

import { type Handler, json, serve } from "../../../test-support/fake-server.js";

const unavailable = {
  error: {
    code: 503,
    status: "UNAVAILABLE",
    message: "try again",
    details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_UNAVAILABLE", domain: "origincloudapis.eu" },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.010s" },
    ],
  },
};

const badRequest = {
  error: {
    code: 400,
    status: "INVALID_ARGUMENT",
    message: "the request is invalid",
    details: [
      { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "INVALID_ARGUMENT", domain: "origincloudapis.eu" },
      { "@type": "type.googleapis.com/google.rpc.RequestInfo", requestId: "req-1" },
      {
        "@type": "type.googleapis.com/google.rpc.BadRequest",
        fieldViolations: [{ field: "volume.sizeGib", description: "must be at least 1" }],
      },
    ],
  },
};

const servers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of servers) await close();
});

const savedRegion = process.env["ORIGINCLOUD_REGION"];
afterEach(() => {
  if (savedRegion === undefined) delete process.env["ORIGINCLOUD_REGION"];
  else process.env["ORIGINCLOUD_REGION"] = savedRegion;
});

async function testClient(handler: Handler, options: { maxAttempts?: number } = {}): Promise<Client> {
  const server = await serve(handler);
  servers.push(server.close);
  return new Client({ endpoint: server.url, credentials: accessToken("t"), ...options });
}

test("a request carries its credentials and agent", async () => {
  let seen: Record<string, string | string[] | undefined> = {};
  const client = await testClient((req, res) => {
    seen = req.headers;
    json(res, {});
  });
  await client.service("pvs").call({ method: "GET", path: "/x" });
  assert.equal(seen["authorization"], "Bearer t");
  assert.equal(seen["accept"], "application/json");
  assert.equal(seen["user-agent"], `origincloud-sdk-typescript/${VERSION}`);

  const require = createRequire(import.meta.url);
  for (const name of ["@origincloud/core", "@origincloud/pvs", "@origincloud/location"]) {
    const pkg = require(`${name}/package.json`) as { version: string };
    assert.equal(VERSION, pkg.version, `VERSION is ${name}'s version`);
  }
});

test("a product is added to the agent", async () => {
  let agent: unknown;
  const server = await serve((req, res) => {
    agent = req.headers["user-agent"];
    json(res, {});
  });
  servers.push(server.close);
  const client = new Client({ endpoint: server.url, credentials: () => "t", userAgent: "my-tool/1.2" });
  await client.service("pvs").call({ method: "GET", path: "/x" });
  assert.equal(agent, `my-tool/1.2 origincloud-sdk-typescript/${VERSION}`);
});

test("an idempotent call is retried while the answer is retryable", async () => {
  let calls = 0;
  const client = await testClient((_, res) => {
    calls++;
    if (calls < 3) json(res, unavailable, 503);
    else json(res, { ok: true });
  });
  const answer = await client.service("pvs").call<{ ok: boolean }>({ method: "GET", path: "/x", idempotent: true });
  assert.deepEqual(answer, { ok: true });
  assert.equal(calls, 3);
});

test("a call that isn't idempotent is sent once", async () => {
  let calls = 0;
  const client = await testClient((_, res) => {
    calls++;
    json(res, unavailable, 503);
  });
  await assert.rejects(client.service("pvs").call({ method: "POST", path: "/x" }), (err: unknown) => {
    assert.ok(err instanceof OriginCloudError);
    assert.equal(err.reason, "SERVICE_UNAVAILABLE");
    assert.equal(err.retryable, true);
    assert.equal(err.retryDelayMs, 10);
    return true;
  });
  assert.equal(calls, 1);
});

test("retries stop at the most attempts", async () => {
  let calls = 0;
  const client = await testClient(
    (_, res) => {
      calls++;
      json(res, unavailable, 503);
    },
    { maxAttempts: 3 },
  );
  await assert.rejects(client.service("pvs").call({ method: "GET", path: "/x", idempotent: true }), OriginCloudError);
  assert.equal(calls, 3);
});

test("an error that isn't retryable is not retried, and says what was refused", async () => {
  let calls = 0;
  const client = await testClient((_, res) => {
    calls++;
    json(res, badRequest, 400);
  });
  await assert.rejects(client.service("pvs").call({ method: "GET", path: "/x", idempotent: true }), (err: unknown) => {
    assert.ok(err instanceof OriginCloudError);
    assert.equal(err.httpStatus, 400);
    assert.equal(err.status, "INVALID_ARGUMENT");
    assert.equal(err.reason, "INVALID_ARGUMENT");
    assert.equal(err.message, "the request is invalid");
    assert.equal(err.requestId, "req-1");
    assert.deepEqual(err.fieldViolations, [{ field: "volume.sizeGib", description: "must be at least 1" }]);
    assert.equal(err.retryable, false);
    assert.equal(String(err), "origincloud: INVALID_ARGUMENT: the request is invalid (request req-1)");
    assert.equal(reasonOf(err), "INVALID_ARGUMENT");
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(reasonOf(new Error("x")), "");
});

test("a proxy error without a status is retryable", async () => {
  let calls = 0;
  const client = await testClient((_, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(502, { "Content-Type": "text/html" });
      res.end("<html>bad gateway</html>");
    } else {
      json(res, {});
    }
  });
  await client.service("pvs").call({ method: "GET", path: "/x", idempotent: true });
  assert.equal(calls, 2);
});

test("a connection that fails is retried when the call is idempotent", async () => {
  let calls = 0;
  const client = await testClient((_, res) => {
    calls++;
    if (calls === 1) res.socket?.destroy();
    else json(res, {});
  });
  await client.service("pvs").call({ method: "GET", path: "/x", idempotent: true });
  assert.equal(calls, 2);
});

test("the consistency token is kept and sent back", async () => {
  const presented: string[] = [];
  const client = await testClient((req, res) => {
    presented.push(String(req.headers[CONSISTENCY_TOKEN_HEADER.toLowerCase()] ?? ""));
    switch (req.path) {
      case "/mutate":
        json(res, {}, 200, { [CONSISTENCY_TOKEN_HEADER]: "v1.after-mutation" });
        break;
      case "/fail":
        // A failed mutation may have applied a command all the same.
        json(res, badRequest, 400, { [CONSISTENCY_TOKEN_HEADER]: "v1.after-failure" });
        break;
      default:
        json(res, {});
    }
  });
  const service = client.service("pvs");
  const call = (path: string) => service.call({ method: "GET", path }).catch(() => undefined);

  await call("/read");
  await call("/mutate");
  await call("/read");
  await call("/fail");
  await call("/read");

  assert.deepEqual(presented, ["", "", "v1.after-mutation", "v1.after-mutation", "v1.after-failure"]);
  assert.equal(client.consistencyToken, "v1.after-failure");
});

test("a region that isn't a region code is refused", () => {
  delete process.env["ORIGINCLOUD_REGION"];
  for (const region of ["eu/central1", "x@evil.com/", "eu central1", "eu-central1:443", "EU-CENTRAL1"]) {
    assert.throws(() => new Client({ credentials: accessToken("t"), region }), /region code/, region);
  }
  process.env["ORIGINCLOUD_REGION"] = "pvs.evil.com/";
  assert.throws(() => new Client({ credentials: accessToken("t") }), /region code/);
  delete process.env["ORIGINCLOUD_REGION"];
});

test("endpoints", () => {
  delete process.env["ORIGINCLOUD_REGION"];
  const cases: [string, boolean, string][] = [
    ["", true, "https://pvs.origincloudapis.eu"],
    ["eu-central1", true, "https://pvs.eu-central1.origincloudapis.eu"],
    ["eu-central1", false, "https://pvs.origincloudapis.eu"],
  ];
  for (const [region, regional, want] of cases) {
    const client = new Client({ credentials: accessToken("t"), region });
    assert.equal(client.service("pvs", regional).base, want, `region ${region}, regional ${regional}`);
  }
  for (const global of ["iam", "resourcemanager", "location"]) {
    assert.equal(
      new Client({ credentials: accessToken("t"), region: "eu-central1" }).service(global).base,
      `https://${global}.origincloudapis.eu`,
      `${global} is a global service, which has no regional host`,
    );
  }

  process.env["ORIGINCLOUD_REGION"] = "eu-west1";
  assert.equal(new Client({ credentials: accessToken("t") }).service("pvs").base, "https://pvs.eu-west1.origincloudapis.eu");
  assert.equal(
    new Client({ credentials: accessToken("t"), region: "" }).service("pvs").base,
    "https://pvs.origincloudapis.eu",
    "an empty region overrides the environment",
  );
});

test("zero most attempts and an empty endpoint mean the defaults", async () => {
  delete process.env["ORIGINCLOUD_REGION"];
  const client = new Client({ credentials: accessToken("t"), maxAttempts: 0, endpoint: "" });
  assert.equal(client.maxAttempts, 5);
  assert.equal(client.service("pvs").base, "https://pvs.origincloudapis.eu");
});

test("a response body is read up to 32 MiB", async () => {
  const big = JSON.stringify({ padding: "x".repeat(32 << 20) });
  const client = await testClient((req, res) => {
    if (req.path === "/error") json(res, big, 400);
    else json(res, big);
  });
  await assert.rejects(
    client.service("pvs").call({ method: "GET", path: "/x" }),
    /reading the response to GET \/x: it is larger than 33554432 bytes/,
  );
  // An error's body that is cut off is an error by its status alone.
  await assert.rejects(client.service("pvs").call({ method: "GET", path: "/error" }), (err: unknown) => {
    assert.ok(err instanceof OriginCloudError);
    assert.equal(err.httpStatus, 400);
    assert.equal(err.message, "Bad Request");
    return true;
  });
});

test("invalid options are refused", () => {
  assert.throws(() => new Client({ credentials: accessToken("t"), maxAttempts: -1 }), /at least 1/);
  assert.throws(() => new Client({ credentials: accessToken("t"), endpoint: "localhost" }), /absolute URL/);
});

test("pathValue", () => {
  assert.equal(
    pathValue("name", "projects/p 1/zones/z/volumes/vol-1", "projects/*/zones/*/volumes/*"),
    "projects/p%201/zones/z/volumes/vol-1",
  );
  for (const bad of [
    undefined,
    "",
    "projects/p/zones/z",
    "projects/p/zones//volumes/v",
    "projects/p/regions/z/volumes/v",
    "projects/p/zones/z/volumes/v/x",
    "projects/p/zones/z/volumes/..",
    "projects/p/zones/z/volumes/.",
    "projects/../zones/z/volumes/v",
  ]) {
    assert.throws(() => pathValue("name", bad, "projects/*/zones/*/volumes/*"), /name must have the form/, String(bad));
  }
});

test("query", () => {
  const got = query(
    {
      parent: "projects/p/zones/z",
      pageSize: 10,
      pageToken: "",
      filter: { state: "AVAILABLE", ids: ["a", "b"] },
      all: true,
      none: false,
      zero: 0,
      unset: undefined,
    },
    ["parent"],
  );
  assert.equal(got.toString(), "all=true&filter.ids=a&filter.ids=b&filter.state=AVAILABLE&pageSize=10");
});

test("newRequestId is a version 4 UUID", () => {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const id = newRequestId();
    assert.match(id, uuid);
    assert.ok(!seen.has(id));
    seen.add(id);
  }
});

test("an aborted signal stops retrying", async () => {
  const client = await testClient((_, res) => {
    json(res, JSON.stringify(unavailable).replace("0.010s", "60s"), 503);
  });
  const start = Date.now();
  await assert.rejects(
    client.service("pvs").call({ method: "GET", path: "/x", idempotent: true }, { signal: AbortSignal.timeout(100) }),
    (err: unknown) => (err as Error).name === "TimeoutError",
  );
  assert.ok(Date.now() - start < 5000, `took ${Date.now() - start} ms`);
});
