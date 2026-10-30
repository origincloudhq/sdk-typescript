import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { after, test } from "node:test";

import { CONSISTENCY_TOKEN_HEADER, Client, accessToken, reasonOf } from "@origincloud/core";
import { type Volume, VolumeClient } from "@origincloud/pvs/v1beta1";

import { type Received, json, serve } from "../../../test-support/fake-server.js";

const zone = "projects/p/zones/z";
const header = CONSISTENCY_TOKEN_HEADER.toLowerCase();

const token = (position: number) => `v1.${position}`;
const position = (value: unknown) => Number(String(value ?? "").replace(/^v1\./, "")) || 0;
const volumeName = (position: number) => `${zone}/volumes/vol-${position}`;
const volume = (position: number): Volume => ({ name: volumeName(position), state: "AVAILABLE", sizeGib: 1 });

/**
 * A front door whose read model trails every write until the test releases
 * it, as the API's lags: a read presenting a token the read model hasn't
 * reached answers UNAVAILABLE, retryable, as the API does once its bound
 * has passed; a read without one answers what the read model has,
 * NOT_FOUND for a volume it hasn't seen yet. No answer depends on how long
 * anything takes.
 */
class LaggingFrontDoor {
  /** How many writes were made, and how many the read model has. */
  private written = 0;
  private reached = 0;
  /** How many reads presenting a token were answered UNAVAILABLE. */
  behind = 0;
  /** Called when a read presenting a token finds the read model behind. */
  onBehind: () => void = () => {};

  /** The read model catches up with every write so far. */
  release(): void {
    this.reached = this.written;
  }

  readonly handle = (req: Received, res: ServerResponse): void => {
    const presented = position(req.headers[header]);
    if (req.method === "POST" && req.path === `/v1beta1/${zone}/volumes`) {
      assert.deepEqual(JSON.parse(req.body), { sizeGib: 1 });
      assert.ok(req.query.get("requestId"), "a create carries a request id");
      const written = ++this.written;
      json(res, { name: `${zone}/operations/op-${written}` }, 200, {
        [CONSISTENCY_TOKEN_HEADER]: token(Math.max(presented, written)),
      });
      return;
    }
    const wait = /\/operations\/op-(\d+):wait$/.exec(req.path);
    if (req.method === "POST" && wait) {
      const written = Number(wait[1]);
      json(
        res,
        {
          name: `${zone}/operations/op-${written}`,
          done: true,
          response: { "@type": "type.googleapis.com/origincloud.pvs.v1beta1.Volume", ...volume(written) },
        },
        200,
        { [CONSISTENCY_TOKEN_HEADER]: token(Math.max(presented, written)) },
      );
      return;
    }
    const get = new RegExp(`^/v1beta1/${zone}/volumes/vol-(\\d+)$`).exec(req.path);
    if (req.method === "GET" && get) {
      const wanted = Number(get[1]);
      if (this.reached < presented) {
        this.behind++;
        this.onBehind();
        json(
          res,
          {
            error: {
              code: 503,
              status: "UNAVAILABLE",
              message: "the read model hasn't reached the token yet",
              details: [
                {
                  "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                  reason: "SERVICE_UNAVAILABLE",
                  domain: "origincloudapis.eu",
                },
                { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.010s" },
              ],
            },
          },
          503,
        );
        return;
      }
      if (this.reached < wanted) {
        json(
          res,
          {
            error: {
              code: 404,
              status: "NOT_FOUND",
              message: "volume not found",
              details: [
                { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "NOT_FOUND", domain: "origincloudapis.eu" },
              ],
            },
          },
          404,
        );
        return;
      }
      json(res, volume(wanted));
      return;
    }
    json(res, { error: { code: 404, status: "NOT_FOUND", message: `unexpected ${req.method} ${req.path}` } }, 404);
  };
}

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

// A get right after a create's operation is done finds the volume, every
// time, although the read model is behind the create: the get presents
// the token, so it is held until the read model has the create, instead
// of answering NOT_FOUND.
test("a get after a create is done finds the volume", async () => {
  const frontDoor = new LaggingFrontDoor();
  // The read model catches up only once a read waits for it.
  frontDoor.onBehind = () => frontDoor.release();
  const server = await serve(frontDoor.handle);
  closers.push(server.close);
  const newClient = () => new VolumeClient(new Client({ endpoint: server.url, credentials: accessToken("t") }));
  const volumes = newClient();

  for (let i = 0; i < 20; i++) {
    const op = await volumes.createVolume({ parent: zone, volume: { sizeGib: 1 } });
    const created = await op.wait();

    // The control: a client that didn't write doesn't see it yet, so the
    // read model really is behind.
    await assert.rejects(
      newClient().getVolume({ name: created.name! }),
      (err: unknown) => reasonOf(err) === "NOT_FOUND",
      `get ${i} without the token should find the read model behind`,
    );

    const got = await volumes.getVolume({ name: created.name! });
    assert.equal(got.name, created.name, `get ${i} after its create`);
    assert.equal(got.state, "AVAILABLE");
    assert.equal(frontDoor.behind, i + 1, `get ${i} was held for the read model`);
  }
});

// The token can be handed to another client, such as one in another
// process, for its reads to show the first client's writes.
test("a handed-over token shows another client's writes", async () => {
  const frontDoor = new LaggingFrontDoor();
  frontDoor.onBehind = () => frontDoor.release();
  const server = await serve(frontDoor.handle);
  closers.push(server.close);
  const writer = new Client({ endpoint: server.url, credentials: accessToken("t") });
  const created = await (await new VolumeClient(writer).createVolume({ parent: zone, volume: { sizeGib: 1 } })).wait();

  const reader = new Client({ endpoint: server.url, credentials: accessToken("t") });
  reader.consistencyToken = writer.consistencyToken;
  const got = await new VolumeClient(reader).getVolume({ name: created.name! });
  assert.equal(got.name, created.name);
  assert.equal(frontDoor.behind, 1);
});
