# @origincloud/secretmanager

The client of Origin Cloud's secretmanager service: secrets: small confidential
values, such as a database password, an API key or a TLS private key, kept
encrypted and versioned by the platform and read by the people and workloads you
allow. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { SecretManagerClient } from "@origincloud/secretmanager/v1beta1";

const secretManagers = new SecretManagerClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/secretmanager/v1beta1` | Secrets: small confidential values, such as a database password, an API key or a TLS private key, kept encrypted and versioned by the platform and read by the people and workloads you allow |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
