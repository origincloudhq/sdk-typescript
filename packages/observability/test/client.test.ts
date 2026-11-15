import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Client, FullNameError, accessToken } from "@origincloud/core";
import { MetricClient } from "@origincloud/observability/v1beta1";

import { type Received, json, serve } from "../../../test-support/fake-server.js";

test("a MetricClient sends its calls to observability.origincloudapis.eu", () => {
  const client = new MetricClient(new Client({ credentials: accessToken("t") }));
  assert.equal(client.service.base, "https://observability.origincloudapis.eu");
});

test("a MetricClient with a region calls its region's observability host", () => {
  const client = new MetricClient(new Client({ credentials: accessToken("t"), region: "eu-central1" }));
  assert.equal(client.service.base, "https://observability.eu-central1.origincloudapis.eu");
});

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

// A query's parent is a project, resourcemanager's: its full name is sent as
// its relative name, the same request as projects/p makes. A full name on
// any other host is refused before sending, naming the host the field
// takes: the client's own service's is no project's.
test("a parent takes the full name of the project it refers to", async () => {
  const calls: Received[] = [];
  const server = await serve((req, res) => {
    calls.push(req);
    json(res, {});
  });
  closers.push(server.close);
  const metrics = new MetricClient(new Client({ endpoint: server.url, credentials: accessToken("t") }));
  const query = { metrics: ["oc_compute_instance_cpu_seconds_total"], resource: "projects/p/zones/z/instances/i-1" };

  for (const parent of ["projects/p", "//resourcemanager.origincloudapis.eu/projects/p"]) {
    await metrics.queryTimeSeries({ ...query, parent });
  }
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.path, "/v1beta1/projects/p/timeSeries:query");
  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.query.toString(), c.body]),
    [0, 1].map(() => [calls[0]!.method, calls[0]!.path, calls[0]!.query.toString(), calls[0]!.body]),
  );

  for (const parent of [
    "//pvs.origincloudapis.eu/projects/p",
    "//observability.origincloudapis.eu/projects/p",
    "//resourcemanager.eu-central1.origincloudapis.eu/projects/p",
  ]) {
    await assert.rejects(metrics.queryTimeSeries({ ...query, parent }), (err: unknown) => {
      assert.ok(err instanceof FullNameError, `${parent}: ${String(err)}`);
      assert.ok(err.message.startsWith("origincloud: parent must be a name on resourcemanager.origincloudapis.eu"), err.message);
      return true;
    });
  }
  await assert.rejects(
    metrics.queryTimeSeries({ ...query, parent: "//pvs.origincloudapis.eu/projects/p" }),
    (err: unknown) => err instanceof FullNameError && err.reason === "otherService",
  );
  assert.equal(calls.length, 2);
});
