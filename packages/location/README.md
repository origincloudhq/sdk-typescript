# @origincloud/location

The client of Origin Cloud's location service: the platform's regions and
zones, and the services each zone offers. Part of the
[Origin Cloud SDK for TypeScript](https://github.com/origincloudhq/sdk-typescript),
generated from the API definitions in
[origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { LocationClient } from "@origincloud/location/v1beta1";

const location = new LocationClient(new Client());
const { zones = [] } = await location.listZones({});
const offeringPvs = zones.filter((zone) => zone.services?.includes("pvs"));
```

| Import | API |
|---|---|
| `@origincloud/location/v1beta1` | Regions and zones |

`v1beta1` is a preview version and may change in incompatible ways, like the
API itself. See the [repository's README](https://github.com/origincloudhq/sdk-typescript#readme)
for credentials and behaviour.

Apache License 2.0.
