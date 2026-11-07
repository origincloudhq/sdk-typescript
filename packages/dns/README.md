# @origincloud/dns

The client of Origin Cloud's DNS service: hosted zones, their record sets, and
private zones' VPC attachments. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { HostedZoneClient } from "@origincloud/dns/v1beta1";

const hostedZones = new HostedZoneClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/dns/v1beta1` | Hosted zones, their record sets, and private zones' VPC attachments |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
