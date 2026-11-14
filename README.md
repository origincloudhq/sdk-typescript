# Origin Cloud SDK for TypeScript

The TypeScript client for Origin Cloud's REST APIs, for Node and for
browsers. Its service packages are generated from the API definitions in
[origincloudhq/api](https://github.com/origincloudhq/api); `@origincloud/core`
is what they share: credentials, endpoints, retries, errors, long-running
operations and read-your-writes.

```sh
npm install @origincloud/core @origincloud/pvs
```

`@origincloud/core` is a peer dependency of every service package, so that
an application has one copy of it, which its errors and operations all come
from: install it next to them.

| Package | Import | API |
|---|---|---|
| `@origincloud/core` | `@origincloud/core` | The client every service package uses |
| `@origincloud/pvs` | `@origincloud/pvs/v1beta1` | Persistent volumes: volumes, snapshots, storage classes |
| | `@origincloud/pvs/longrunning/v1beta1` | PVS operations, for resuming one by name |
| `@origincloud/location` | `@origincloud/location/v1beta1` | Regions and zones, and the services each zone offers |
| `@origincloud/compute` | `@origincloud/compute/v1beta1` | Instances, images, key pairs, volume attachments and the instance catalog |
| | `@origincloud/compute/longrunning/v1beta1` | Compute operations, for resuming one by name |
| `@origincloud/network` | `@origincloud/network/v1beta1` | VPCs, subnets, routing, gateways, floating IPs, network interfaces, security groups, ACLs and DNS policies |
| | `@origincloud/network/longrunning/v1beta1` | Network operations, for resuming one by name |
| `@origincloud/resourcemanager` | `@origincloud/resourcemanager/v1beta1` | Organizations, projects and their quotas |
| `@origincloud/iam` | `@origincloud/iam/v1beta1` | Users, service accounts, roles, role bindings, permissions and the audit log |
| `@origincloud/billing` | `@origincloud/billing/v1beta1` | Billing accounts and the projects they pay for, payment methods, cost and usage, spend limits and the price list |
| `@origincloud/observability` | `@origincloud/observability/v1beta1` | The metrics the platform collects for a project's compute instances, volumes and network interfaces |
| `@origincloud/support` | `@origincloud/support/v1beta1` | Support cases, each a conversation between an organization and Origin Cloud support about a question or a problem |
| `@origincloud/dns` | `@origincloud/dns/v1beta1` | Hosted zones, their record sets, and private zones' VPC attachments |
| `@origincloud/sts` | `@origincloud/sts/v1beta1` | The security token service: it turns a token from an identity provider outside Origin Cloud, such as a CI job's OIDC token, into the access token of a WORKLOAD service account that trusts it through a federated credential |
| `@origincloud/kms` | `@origincloud/kms/v1beta1` | Grants: permission for one platform host to use one key for one operation and one encryption context, for at most an hour at a time |

The packages are ES modules with type declarations, depend on nothing but
each other, and send their requests with the platform's `fetch`. They need
Node 20 or later, or a current browser.

## Example

```ts
import { Client } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

const client = new Client();
const volumes = new VolumeClient(client);

let volume = await (
  await volumes.createVolume({
    parent: "projects/my-project-123/zones/eu-central1-az1",
    volume: { sizeGib: 10 },
  })
).wait();

volume = await (
  await volumes.updateVolume({
    volume: { name: volume.name, sizeGib: 20 },
    updateMask: "sizeGib",
  })
).wait();
console.log(`${volume.name} has ${volume.sizeGib} GiB`);

await (await volumes.deleteVolume({ name: volume.name })).wait();
```

Messages are plain objects in their JSON form, as the API sends them:
fields have their camelCase names, enums are their value names (such as
`"AVAILABLE"`, also available as `Volume_State.AVAILABLE`), 64-bit
integers, timestamps and durations are strings, and a field mask is a
comma-separated list of camelCase paths (`"sizeGib,tags"`). A field at its
default value may be absent from a response: `volume.sizeGib ?? 0`.

## Credentials

### Node

`new Client()` takes the first of:

1. `ORIGINCLOUD_ACCESS_TOKEN`: an access token, sent as it is.
2. `ORIGINCLOUD_CLIENT_ID` and `ORIGINCLOUD_CLIENT_SECRET`: a service account's
   credential, exchanged for access tokens as they expire. This is what
   automation should use. Setting only one of the two is an error.
3. A CI job's OIDC token, exchanged at the security token service
   (`https://sts.origincloudapis.eu`, or `ORIGINCLOUD_STS_ENDPOINT`) for the
   access tokens of the workload service account whose federated credential
   trusts it: no secret is stored. The token is read from the file
   `ORIGINCLOUD_OIDC_TOKEN_FILE` names (any CI provider, or a Kubernetes
   projected token), or else taken from `ORIGINCLOUD_OIDC_TOKEN`, which holds
   the token itself, or else, in GitHub Actions, requested from GitHub, which
   the workflow allows with `permissions: id-token: write`; its audience is
   `https://sts.origincloudapis.eu`, or `ORIGINCLOUD_OIDC_AUDIENCE`. A fresh
   job token is exchanged a minute before each access token expires. A job
   token found is the credential: when its exchange fails, the call rejects
   with why, and the steps below aren't tried. `ORIGINCLOUD_OIDC_DISABLED=true`
   leaves this step out, such as on a self-hosted runner that should use its
   instance's service account.

   In GitLab CI, `id_tokens` sets the variable, and the job needs no script:

   ```yaml
   deploy:
     id_tokens:
       ORIGINCLOUD_OIDC_TOKEN:
         aud: https://sts.origincloudapis.eu
   ```

   A token in the variable can't be renewed: each access token is exchanged
   for the same job token, which works until that token expires; the call
   then rejects saying so. A job that outlasts its token asks the CI provider
   for a longer-lived one, or names a file the provider rotates in
   `ORIGINCLOUD_OIDC_TOKEN_FILE`.
4. The session the `origin` CLI stored at its last login (`origin id login`),
   renewed in memory when it expires; the CLI's file is never written.
5. The instance's metadata service, at `http://169.254.169.254` or
   `ORIGINCLOUD_METADATA_ENDPOINT`: on an instance that runs as a service
   account, that account's access tokens, replaced a minute before they
   expire. Nothing is asked until the first call, which rejects with
   `NoCredentialsError` within about two seconds where no metadata service
   answers, or where another cloud's answers instead; a 503 is tried again
   twice. `ORIGINCLOUD_METADATA_DISABLED=true`
   leaves this step out, and `new Client()` then throws when none of the
   others is found.

`credentials` sets them explicitly instead:

```ts
import { Client, serviceAccount } from "@origincloud/core";

const client = new Client({ credentials: serviceAccount(clientId, clientSecret) });
```

`githubActions()`, `oidcTokenFile(path)`, `oidcToken(token)` and
`federated(getToken)` exchange a CI job's token the same way, from GitHub
Actions, a file, a token given as it is, or any function that returns a
fresh one.

### Browser

A web application passes the access token of the user's session: any
function that returns the current token, such as an OIDC client's
access-token getter. It is asked before every call, so a renewed token is
picked up without creating a new client.

```ts
import { Client } from "@origincloud/core";
import { VolumeClient } from "@origincloud/pvs/v1beta1";

const client = new Client({ credentials: () => session.getAccessToken() });
const volumes = new VolumeClient(client);

for await (const volume of volumes.allVolumes({ parent: zone })) {
  console.log(volume.name, volume.state);
}
```

Bundlers pick the browser build through the `browser` export condition. It
reads no environment and no files and imports nothing of Node's, so a client
created without `credentials` there throws. The Node build is selected by
the `node` condition; `@origincloud/core/browser` and `@origincloud/core/node`
name either one explicitly.

### Node with TypeScript's `bundler` module resolution

TypeScript resolving modules as a bundler (`"moduleResolution": "bundler"`)
doesn't apply the `node` condition, so `@origincloud/core` gives it the
browser build's types, which lack the Node-only exports. A Node program
compiled that way imports those from `@origincloud/core/node`:

```ts
import { Client, defaultCredentials } from "@origincloud/core/node";
```

That entry point has everything `@origincloud/core` has, and also
`defaultCredentials`, `cliSession`, `CLISessionCredentials`,
`instanceMetadata`, `InstanceMetadataCredentials`, `METADATA_ENDPOINT` and
`NoCredentialsError`.

## Behaviour

- **Endpoints.** Every service answers at `{service}.origincloudapis.eu`,
  which serves every resource wherever it lives. The `region` option, or
  `ORIGINCLOUD_REGION` in Node, picks a region's front door instead,
  `{service}.{region}.origincloudapis.eu`, for the services that have one.
  `endpoint` sends every call to one base URL, such as a test server's.
- **Operations.** A create, update or delete returns an `Operation`; its
  `wait()` resolves to the resource once the change is complete, or rejects
  with the error the change failed with. `name`, `done` and `metadata`
  describe it meanwhile.
- **Retries.** A call answered as retryable (an error carrying `RetryInfo`,
  or a gateway's 502, 503 or 504 without an error body), or one that got no
  answer, is sent again with a growing delay, up to five attempts in all
  (`maxAttempts`), when sending it again is safe: a read, or a mutation with
  a request id. The client fills in an empty request id with a UUID, so a
  retried create never creates twice.
- **Read-your-writes.** The client keeps the consistency token each write
  answers with (the `Origin-Consistency-Token` header) and sends it with
  later calls, waiting on operations included, so a read right after a
  write, or after waiting on an operation, always sees it. `consistencyToken`
  reads and sets it, to hand it to another client.
- **Pages.** Each list method has an `all...` counterpart, an async iterator
  over every page.
- **Errors.** A refused call rejects with an `OriginCloudError`: branch on
  its `reason`, the platform's error code. `metadata` names what the error
  is about, by key, such as `serviceAccount` on a `CONFLICT`, and is empty
  when the API names nothing. It also carries `httpStatus`, `status`,
  `message`, `requestId` and `fieldViolations`.
- **Cancelling.** Every method takes `{ signal }`, an `AbortSignal` that stops
  the call and its retries.

## Versions

A service's import path carries its API's version: `@origincloud/pvs/v1beta1`
is the preview version of the PVS API and may change in incompatible ways,
like the API itself.

## Contributing

Issues and pull requests are welcome. The service packages are generated from
the API definitions, so a change to what a service offers starts as an issue;
see [CONTRIBUTING.md](CONTRIBUTING.md) for how the SDK is built and checked.

## License

Apache License 2.0; see [LICENSE](LICENSE).
