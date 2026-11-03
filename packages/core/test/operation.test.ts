import assert from "node:assert/strict";
import { after, test } from "node:test";

import {
  CONSISTENCY_TOKEN_HEADER,
  Client,
  type LongrunningOperation,
  Operation,
  OriginCloudError,
  accessToken,
} from "@origincloud/core";

import { type Handler, json, serve } from "../../../test-support/fake-server.js";

interface Volume {
  name?: string;
  sizeGib?: number;
}

const name = "projects/p/zones/z/operations/op-1";
const volumeType = "origincloud.pvs.v1beta1.Volume";
const metadata = {
  "@type": "type.googleapis.com/origincloud.longrunning.v1beta1.OperationMetadata",
  target: "projects/p/zones/z/volumes/vol-1",
  verb: "create",
};

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

async function service(handler: Handler) {
  const server = await serve(handler);
  closers.push(server.close);
  return new Client({ endpoint: server.url, credentials: accessToken("t") }).service("pvs");
}

test("wait waits until the operation is done", async () => {
  const bodies: unknown[] = [];
  const presented: unknown[] = [];
  let waits = 0;
  const svc = await service((req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.path, `/v1beta1/${name}:wait`);
    bodies.push(JSON.parse(req.body));
    presented.push(req.headers[CONSISTENCY_TOKEN_HEADER.toLowerCase()]);
    waits++;
    if (waits < 3) {
      json(res, { name, metadata });
      return;
    }
    json(
      res,
      { name, metadata, done: true, response: { "@type": `type.googleapis.com/${volumeType}`, name: "v", sizeGib: 2 } },
      200,
      { [CONSISTENCY_TOKEN_HEADER]: "v1.7" },
    );
  });
  svc.client.consistencyToken = "v1.5";
  const op = new Operation<Volume, { target?: string; verb?: string }>(svc, { name, metadata }, volumeType);
  assert.equal(op.name, name);
  assert.equal(op.done, false);
  assert.deepEqual(op.metadata, { target: "projects/p/zones/z/volumes/vol-1", verb: "create" });

  const volume = await op.wait();
  assert.deepEqual(volume, { name: "v", sizeGib: 2 });
  assert.equal(op.done, true);
  assert.equal(waits, 3);
  assert.deepEqual(bodies[0], { timeout: "60s" });
  assert.deepEqual(presented, ["v1.5", "v1.5", "v1.5"], "the waiter sends the token the client holds");
  assert.equal(svc.client.consistencyToken, "v1.7", "the finished operation's token is kept");
});

test("a failed operation throws its error", async () => {
  const svc = await service(() => assert.fail("not done operations only are waited for"));
  const failed: LongrunningOperation = {
    name,
    done: true,
    error: {
      code: 9,
      message: "the volume is attached",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "VOLUME_IN_USE",
          domain: "origincloudapis.eu",
          metadata: { instance: "projects/p/zones/z/instances/i" },
        },
        { "@type": "type.googleapis.com/google.rpc.RequestInfo", requestId: "req-9" },
      ],
    },
  };
  await assert.rejects(new Operation<Volume>(svc, failed, volumeType).wait(), (err: unknown) => {
    assert.ok(err instanceof OriginCloudError);
    assert.equal(err.httpStatus, 0);
    assert.equal(err.status, "FAILED_PRECONDITION");
    assert.equal(err.reason, "VOLUME_IN_USE");
    assert.deepEqual(err.metadata, { instance: "projects/p/zones/z/instances/i" });
    assert.equal(err.message, "the volume is attached");
    assert.equal(err.requestId, "req-9");
    return true;
  });
});

test("an operation answered done is not waited for, and an empty result is empty", async () => {
  const svc = await service(() => assert.fail("a done operation is not waited for"));
  const done: LongrunningOperation = {
    name,
    done: true,
    response: { "@type": "type.googleapis.com/google.protobuf.Empty" },
  };
  assert.deepEqual(await new Operation(svc, done, "google.protobuf.Empty").wait(), {});
});

test("the result of an operation that isn't done, or of another type", async () => {
  const svc = await service(() => assert.fail("not sent"));
  assert.throws(() => new Operation<Volume>(svc, { name }, volumeType).result(), /isn't done/);
  const other: LongrunningOperation = {
    name,
    done: true,
    response: { "@type": "type.googleapis.com/origincloud.pvs.v1beta1.Snapshot" },
  };
  assert.throws(() => new Operation<Volume>(svc, other, volumeType).result(), /want type.googleapis.com\/origincloud/);
});

test("a malformed operation name is refused before waiting", async () => {
  const svc = await service(() => assert.fail("not sent"));
  await assert.rejects(new Operation<Volume>(svc, { name: "op-1" }, volumeType).wait(), /operation name must have the form/);
});
