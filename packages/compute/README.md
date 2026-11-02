# @origincloud/compute

The client of Origin Cloud's compute service: instances, images, key pairs,
volume attachments and the instance catalog. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { InstanceTypeClient } from "@origincloud/compute/v1beta1";

const instanceTypes = new InstanceTypeClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/compute/v1beta1` | Instances, images, key pairs, volume attachments and the instance catalog |
| `@origincloud/compute/longrunning/v1beta1` | Compute operations, for resuming one by name |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
