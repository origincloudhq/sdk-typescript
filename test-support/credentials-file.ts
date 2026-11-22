import { type KeyObject, generateKeyPairSync } from "node:crypto";

/** The service account the test credentials files are of. */
export const SERVICE_ACCOUNT = "//iam.origincloudapis.eu/organizations/o/serviceAccounts/s";

/** The key the test credentials files are of. */
export const KEY_NAME = `${SERVICE_ACCOUNT}/keys/k`;

/**
 * A service account key's credentials file, as creating a key returns it,
 * with a new P-256 key and `stsEndpoint` as its STS, and the key's public
 * half, which the STS checks the assertion with.
 */
export function newCredentialsFile(stsEndpoint = "https://sts.origincloudapis.eu"): {
  json: string;
  fields: Record<string, string>;
  publicKey: KeyObject;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fields = {
    type: "service_account_key",
    name: KEY_NAME,
    service_account: SERVICE_ACCOUNT,
    algorithm: "ES256",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    sts_endpoint: stsEndpoint,
  };
  return { json: JSON.stringify(fields, null, 2), fields, publicKey };
}
