# @origincloud/core

What every package of the [Origin Cloud SDK for TypeScript](https://github.com/origincloudhq/sdk-typescript)
shares: credentials, endpoints, retries, errors, long-running operations and
read-your-writes. Use it with a service package, such as `@origincloud/pvs`:

```ts
import { Client } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

const volumes = new VolumeClient(new Client());
```

In Node, `new Client()` finds its credentials in the environment, the
`origin` CLI's session or the instance's metadata service; in a browser, pass the session's access-token getter
as `credentials`. See the [repository's README](https://github.com/origincloudhq/sdk-typescript#readme)
for credentials and behaviour.

Apache License 2.0.
