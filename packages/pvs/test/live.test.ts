// Exercises the SDK against the live API. It runs only when
// ORIGINCLOUD_LIVE_ZONE names a zone to work in,
// projects/{project}/zones/{zone}, with credentials found the usual way
// (see @origincloud/core). It creates a volume there and deletes it again.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Client } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

const zone = process.env["ORIGINCLOUD_LIVE_ZONE"] ?? "";

// A volume is created, read straight away, grown and deleted, waiting on
// each operation.
test("volume lifecycle", { skip: zone ? false : "ORIGINCLOUD_LIVE_ZONE isn't set", timeout: 15 * 60_000 }, async (t) => {
  const volumes = new VolumeClient(new Client({ userAgent: "origincloud-sdk-typescript-livetest" }));

  const created = await (
    await volumes.createVolume({
      parent: zone,
      volume: { sizeGib: 1, tags: { "origin:name": "sdk-typescript-livetest" } },
    })
  ).wait();
  t.diagnostic(`created ${created.name}`);
  const name = created.name!;
  let deleted = false;
  try {
    assert.equal(created.state, "AVAILABLE");
    assert.equal(created.sizeGib, 1);

    const got = await volumes.getVolume({ name });
    assert.equal(got.state, "AVAILABLE", "get right after the create");

    const resized = await (await volumes.updateVolume({ volume: { name, sizeGib: 2 }, updateMask: "sizeGib" })).wait();
    assert.equal(resized.sizeGib, 2);
    assert.equal((await volumes.getVolume({ name })).sizeGib, 2, "get right after the resize");

    await (await volumes.deleteVolume({ name })).wait();
    deleted = true;
    assert.equal((await volumes.getVolume({ name })).state, "DELETED", "get right after the delete");

    for await (const volume of volumes.allVolumes({ parent: zone })) {
      assert.notEqual(volume.name, name, "the deleted volume is listed");
    }
  } finally {
    if (!deleted) {
      try {
        await (await volumes.deleteVolume({ name })).wait();
      } catch (err) {
        t.diagnostic(`cleanup: deleting ${name}: ${String(err)}`);
      }
    }
  }
});
