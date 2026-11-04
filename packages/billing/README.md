# @origincloud/billing

The client of Origin Cloud's billing service: billing accounts and the projects
they pay for, payment methods, cost and usage, spend limits and the price list.
Part of the [Origin Cloud SDK for
TypeScript](https://github.com/origincloudhq/sdk-typescript), generated from the
API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).

```ts
import { Client } from "@origincloud/core";
import { BillingAccountClient } from "@origincloud/billing/v1beta1";

const billingAccounts = new BillingAccountClient(new Client());
```

| Import | API |
|---|---|
| `@origincloud/billing/v1beta1` | Billing accounts and the projects they pay for, payment methods, cost and usage, spend limits and the price list |

`v1beta1` is a preview version and may change in incompatible ways, like the API
itself. See the [repository's
README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials
and behaviour.

Apache License 2.0.
