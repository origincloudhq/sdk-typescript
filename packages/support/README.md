# @origincloud/support

The client of Origin Cloud's support service: support cases, each a conversation
between an organization and Origin Cloud support about a question or a problem.
Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { CaseClient } from "@origincloud/support/v1beta1";

const cases = new CaseClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/support/v1beta1` | Support cases, each a conversation between an organization and Origin Cloud support about a question or a problem |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
