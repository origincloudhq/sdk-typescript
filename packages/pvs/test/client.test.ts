import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Client, accessToken } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

import { type Handler, type Received, json, serve } from "../../../test-support/fake-server.js";

const zone = "projects/p/zones/z";
const uuid = /^[0-9a-f-]{36}$/;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

async function volumeClient(handler: Handler): Promise<VolumeClient> {
  const server = await serve(handler);
  closers.push(server.close);
  return new VolumeClient(new Client({ endpoint: server.url, credentials: accessToken("t") }));
}

/** A client whose calls are recorded and answered with an empty JSON object. */
async function recordingClient(): Promise<[VolumeClient, Received[]]> {
  const calls: Received[] = [];
  const client = await volumeClient((req, res) => {
    calls.push(req);
    json(res, {});
  });
  return [client, calls];
}

// The raw path as sent, before the server decodes it.
async function rawPaths(): Promise<[VolumeClient, string[]]> {
  const paths: string[] = [];
  const server = await serve((_, res) => json(res, {}));
  closers.push(server.close);
  const client = new Client({
    endpoint: server.url,
    credentials: accessToken("t"),
    fetch: (url, init) => {
      paths.push(new URL(url).pathname);
      return fetch(url, init);
    },
  });
  return [new VolumeClient(client), paths];
}

test("each binding is sent as its HTTP rule says", async () => {
  const [volumes, calls] = await recordingClient();
  const name = `${zone}/volumes/vol-1`;

  await volumes.listVolumes({ parent: zone, pageSize: 5, pageToken: "next" });
  await volumes.updateVolume({ volume: { name, sizeGib: 2 }, updateMask: "sizeGib,tags" });
  await volumes.importVolume({
    parent: zone,
    volume: { sizeGib: 3 },
    sourceUrl: "https://example.com/disk.img",
    requestId: "given",
  });
  await volumes.deleteVolume({ name });

  const [list, update, imported, deleted] = calls;
  assert.ok(list && update && imported && deleted);

  assert.equal(list.method, "GET");
  assert.equal(list.path, `/v1beta1/${zone}/volumes`);
  assert.equal(list.body, "");
  assert.deepEqual([...list.query], [
    ["pageSize", "5"],
    ["pageToken", "next"],
  ]);

  // body: "volume": the volume is the body, the rest goes in the query.
  assert.equal(update.method, "PATCH");
  assert.equal(update.path, `/v1beta1/${name}`);
  assert.deepEqual(JSON.parse(update.body), { name, sizeGib: 2 });
  assert.equal(update.query.get("updateMask"), "sizeGib,tags");
  assert.match(update.query.get("requestId") ?? "", uuid);
  assert.equal(update.headers["content-type"], "application/json");

  // body: "*": everything is the body, nothing the query.
  assert.equal(imported.method, "POST");
  assert.equal(imported.path, `/v1beta1/${zone}/volumes:import`);
  assert.equal([...imported.query].length, 0);
  assert.deepEqual(JSON.parse(imported.body), {
    parent: zone,
    volume: { sizeGib: 3 },
    sourceUrl: "https://example.com/disk.img",
    requestId: "given",
  });

  assert.equal(deleted.method, "DELETE");
  assert.equal(deleted.path, `/v1beta1/${name}`);
  assert.equal(deleted.body, "");
  assert.match(deleted.query.get("requestId") ?? "", uuid);
});

test("an empty request id is filled in without changing the caller's request", async () => {
  const [volumes, calls] = await recordingClient();
  const request = { parent: zone, volume: { sizeGib: 1 } };
  await volumes.createVolume(request);
  assert.deepEqual(request, { parent: zone, volume: { sizeGib: 1 } });
  assert.match(calls[0]?.query.get("requestId") ?? "", uuid);

  // Each call gets its own.
  await volumes.createVolume(request);
  assert.notEqual(calls[1]?.query.get("requestId"), calls[0]?.query.get("requestId"));
});

test("a create retried after a lost answer sends the same request id", async () => {
  const ids: string[] = [];
  const volumes = await volumeClient((req, res) => {
    ids.push(req.query.get("requestId") ?? "");
    if (ids.length === 1) {
      json(
        res,
        {
          error: {
            code: 503,
            status: "UNAVAILABLE",
            message: "busy",
            details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "0.010s" }],
          },
        },
        503,
      );
      return;
    }
    json(res, { name: `${zone}/operations/op-1` });
  });
  const op = await volumes.createVolume({ parent: zone, volume: { sizeGib: 1 } });
  assert.equal(op.name, `${zone}/operations/op-1`);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("a name is escaped once", async () => {
  const [volumes, paths] = await rawPaths();
  await volumes.getVolume({ name: "projects/a b%/zones/z/volumes/v" });
  assert.equal(paths[0], "/v1beta1/projects/a%20b%25/zones/z/volumes/v");
});

test("a name of the wrong form is refused before sending", async () => {
  const [volumes, calls] = await recordingClient();
  await assert.rejects(
    volumes.getVolume({ name: "vol-1" }),
    /name must have the form projects\/\*\/zones\/\*\/volumes\/\*, got "vol-1"/,
  );
  await assert.rejects(volumes.updateVolume({ volume: { sizeGib: 2 } }), /volume\.name must have the form/);
  assert.equal(calls.length, 0);
});

test("allVolumes follows the pages", async () => {
  const pages: Record<string, unknown> = {
    "": { volumes: [{ name: `${zone}/volumes/vol-1` }, { name: `${zone}/volumes/vol-2` }], nextPageToken: "p2" },
    p2: { volumes: [{ name: `${zone}/volumes/vol-3` }] },
  };
  const tokens: string[] = [];
  const volumes = await volumeClient((req, res) => {
    const token = req.query.get("pageToken") ?? "";
    tokens.push(token);
    json(res, pages[token]);
  });
  const names: string[] = [];
  for await (const volume of volumes.allVolumes({ parent: zone, pageSize: 2 })) {
    names.push(volume.name?.slice(`${zone}/volumes/`.length) ?? "");
  }
  assert.deepEqual(names, ["vol-1", "vol-2", "vol-3"]);
  assert.deepEqual(tokens, ["", "p2"]);
});

test("a page that fails ends the iteration with its error", async () => {
  const volumes = await volumeClient((req, res) => {
    if (req.query.get("pageToken")) {
      json(res, { error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, 403);
      return;
    }
    json(res, { volumes: [{ name: `${zone}/volumes/vol-1` }], nextPageToken: "p2" });
  });
  const names: string[] = [];
  await assert.rejects(async () => {
    for await (const volume of volumes.allVolumes({ parent: zone })) names.push(volume.name ?? "");
  }, /PERMISSION_DENIED/);
  assert.equal(names.length, 1);
});
