import assert from "node:assert/strict";
import { test } from "node:test";

import { Client, FullNameError, accessToken } from "@origincloud/core";
import { InstanceClient, InstanceTypeClient, LaunchTemplateClient } from "@origincloud/compute/v1beta1";

test("getInstanceType gets a resource by its name from compute.origincloudapis.eu", async () => {
  const urls: string[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: "instanceTypes/x" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const got = await new InstanceTypeClient(client).getInstanceType({ name: "instanceTypes/x" });
  assert.deepEqual(urls, ["https://compute.origincloudapis.eu/v1beta1/instanceTypes/x"]);
  assert.equal(got.name, "instanceTypes/x");
});

// A client given only a full name calls the resource: the name carries the
// project, the zone and the service, so nothing else is given and no table
// from collection to service is consulted. The request goes to the
// service's host, at the name's relative path.
test("a client given only a full name calls the resource", async () => {
  const sent: { method: string | undefined; url: string }[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url, init) => {
      sent.push({ method: init?.method, url: String(url) });
      return new Response(JSON.stringify({ name: "projects/p/zones/eu-central1-az1/instances/i-1" }), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  await new InstanceClient(client).getInstance({
    name: "//compute.origincloudapis.eu/projects/p/zones/eu-central1-az1/instances/i-1",
  });
  assert.equal(sent.length, 1);
  const url = new URL(sent[0]!.url);
  assert.equal(sent[0]!.method, "GET");
  assert.equal(url.host, "compute.origincloudapis.eu");
  assert.equal(url.pathname, "/v1beta1/projects/p/zones/eu-central1-az1/instances/i-1");
});

// A full name on another service's host is refused before anything is
// sent: the client doesn't send a name its service doesn't own.
test("a full name of another service is refused before sending", async () => {
  let sent = 0;
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async () => {
      sent++;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
  });

  await assert.rejects(
    new InstanceClient(client).getInstance({
      name: "//pvs.origincloudapis.eu/projects/p/zones/eu-central1-az1/instances/i-1",
    }),
    (err: unknown) =>
      err instanceof FullNameError &&
      err.reason === "otherService" &&
      err.message.includes("name must be a name on compute.origincloudapis.eu"),
  );
  assert.equal(sent, 0);
});

// A launch template's versions are the template itself (AIP-162), so their
// pager is named after its method, not after the field it shares with
// allLaunchTemplates.
test("allLaunchTemplateVersions follows the pages", async () => {
  const template = "projects/p/launchTemplates/web";
  const pages: Record<string, unknown> = {
    "": { launchTemplates: [{ name: `${template}@1` }, { name: `${template}@2` }], nextPageToken: "p2" },
    p2: { launchTemplates: [{ name: `${template}@3` }] },
  };
  const urls: URL[] = [];
  const client = new Client({
    credentials: accessToken("t"),
    fetch: async (url) => {
      const u = new URL(String(url));
      urls.push(u);
      return new Response(JSON.stringify(pages[u.searchParams.get("pageToken") ?? ""]), {
        headers: { "content-type": "application/json" },
      });
    },
  });

  const names: string[] = [];
  for await (const version of new LaunchTemplateClient(client).allLaunchTemplateVersions({ name: template })) {
    names.push(version.name ?? "");
  }
  assert.deepEqual(names, [`${template}@1`, `${template}@2`, `${template}@3`]);
  assert.deepEqual(
    urls.map((u) => u.pathname),
    [`/v1beta1/${template}:listVersions`, `/v1beta1/${template}:listVersions`],
  );
});
