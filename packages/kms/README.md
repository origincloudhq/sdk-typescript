# @origincloud/kms

The client of Origin Cloud's KMS service: grants: permission for one platform
host to use one key for one operation and one encryption context, for at most an
hour at a time. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { GrantClient } from "@origincloud/kms/v1beta1";

const grants = new GrantClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/kms/v1beta1` | Grants: permission for one platform host to use one key for one operation and one encryption context, for at most an hour at a time |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
