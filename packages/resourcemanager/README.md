# @origincloud/resourcemanager

The client of Origin Cloud's resourcemanager service: organizations, projects
and their quotas. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { OrganizationClient } from "@origincloud/resourcemanager/v1beta1";

const organizations = new OrganizationClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/resourcemanager/v1beta1` | Organizations, projects and their quotas |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
