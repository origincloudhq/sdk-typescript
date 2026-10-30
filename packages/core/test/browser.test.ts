// The browser entry point: a bundle of it for the browser imports nothing
// of Node's, and its client takes its credentials from the page.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { type BuildOptions, build } from "esbuild";

import { json, serve } from "../../../test-support/fake-server.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function bundle(contents: string, options: Partial<BuildOptions> = {}) {
  return build({
    stdin: { contents, resolveDir: root, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    metafile: true,
    logLevel: "silent",
    ...options,
  });
}

const entry = `
export { Client, OriginCloudError, accessToken } from "@origincloud/core";
export { VolumeClient } from "@origincloud/pvs/v1beta1";
export { OperationClient } from "@origincloud/pvs/longrunning/v1beta1";
`;

const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const close of closers) await close();
});

test("the browser bundle has no node: imports", async () => {
  const result = await bundle(entry);
  const code = result.outputFiles![0]!.text;
  assert.doesNotMatch(code, /["']node:/);
  assert.doesNotMatch(code, /process\.env/);
  const inputs = Object.keys(result.metafile!.inputs);
  assert.ok(inputs.some((i) => i.endsWith("packages/core/dist/browser.js")), inputs.join("\n"));
  assert.ok(!inputs.some((i) => i.includes("node-credentials")), inputs.join("\n"));
});

test("the Node entry point can't be bundled for a browser", async () => {
  // The control: the check above would notice Node's modules.
  await assert.rejects(bundle(`export * from "@origincloud/core/node";`), /node:/);
});

test("the browser client sends the token the page supplies, and no agent of its own", async () => {
  const result = await bundle(entry);
  const code = result.outputFiles![0]!.text;
  const browser = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
    Client: new (options?: object) => unknown;
    VolumeClient: new (client: unknown) => {
      getVolume(request: { name: string }): Promise<{ name?: string }>;
    };
  };

  assert.throws(() => new browser.Client(), /in a browser, pass `credentials`/);

  const seen: Record<string, unknown>[] = [];
  const server = await serve((req, res) => {
    seen.push(req.headers);
    json(res, { name: "projects/p/zones/z/volumes/vol-1" });
  });
  closers.push(server.close);
  let calls = 0;
  const client = new browser.Client({
    endpoint: server.url,
    credentials: async () => `session-token-${++calls}`,
  });
  const volumes = new browser.VolumeClient(client);
  const volume = await volumes.getVolume({ name: "projects/p/zones/z/volumes/vol-1" });
  assert.equal(volume.name, "projects/p/zones/z/volumes/vol-1");
  await volumes.getVolume({ name: "projects/p/zones/z/volumes/vol-1" });
  assert.equal(seen[0]?.["authorization"], "Bearer session-token-1");
  assert.equal(seen[1]?.["authorization"], "Bearer session-token-2", "the getter is asked on every call");
  assert.doesNotMatch(String(seen[0]?.["user-agent"]), /origincloud-sdk/);
});
