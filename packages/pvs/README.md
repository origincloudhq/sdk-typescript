# @origincloud/pvs

The client of Origin Cloud's persistent volume service (PVS): volumes,
snapshots and storage classes. Part of the
[Origin Cloud SDK for TypeScript](https://github.com/origincloudhq/sdk-typescript),
generated from the API definitions in
[origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

const volumes = new VolumeClient(new Client());
const volume = await (
  await volumes.createVolume({
    parent: "projects/my-project-123/zones/eu-central1-az1",
    volume: { sizeGib: 10 },
  })
).wait();
```

| Import | API |
|---|---|
| `@origincloud/pvs/v1beta1` | Volumes, snapshots and storage classes |
| `@origincloud/pvs/longrunning/v1beta1` | PVS operations, for resuming one by name |

`v1beta1` is a preview version and may change in incompatible ways, like the
API itself. See the [repository's README](https://github.com/origincloudhq/sdk-typescript#readme)
for credentials and behaviour.

Apache License 2.0.
