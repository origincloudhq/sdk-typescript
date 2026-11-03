# @origincloud/iam

The client of Origin Cloud's IAM service: users, service accounts, roles, role
bindings, permissions and the audit log. Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { AuditLogClient } from "@origincloud/iam/v1beta1";

const auditLogs = new AuditLogClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/iam/v1beta1` | Users, service accounts, roles, role bindings, permissions and the audit log |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
