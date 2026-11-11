# @origincloud/sts

The client of Origin Cloud's STS service: the security token service: it turns a
token from an identity provider outside Origin Cloud, such as a CI job's OIDC
token, into the access token of a WORKLOAD service account that trusts it
through a federated credential. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { SecurityTokenClient } from "@origincloud/sts/v1beta1";

const securityTokens = new SecurityTokenClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/sts/v1beta1` | The security token service: it turns a token from an identity provider outside Origin Cloud, such as a CI job's OIDC token, into the access token of a WORKLOAD service account that trusts it through a federated credential |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
