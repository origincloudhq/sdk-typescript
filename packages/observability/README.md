# @origincloud/observability

The client of Origin Cloud's observability service: the metrics the platform
collects for a project's compute instances, volumes and network interfaces. Part
of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { MetricClient } from "@origincloud/observability/v1beta1";

const metrics = new MetricClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/observability/v1beta1` | The metrics the platform collects for a project's compute instances, volumes and network interfaces |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
