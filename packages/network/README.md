# @origincloud/network

The client of Origin Cloud's network service: VPCs, subnets, routing, gateways,
floating IPs, network interfaces, security groups, ACLs and DNS policies. Part
of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { AclClient } from "@origincloud/network/v1beta1";

const acls = new AclClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/network/v1beta1` | VPCs, subnets, routing, gateways, floating IPs, network interfaces, security groups, ACLs and DNS policies |
| `@origincloud/network/longrunning/v1beta1` | Network operations, for resuming one by name |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
