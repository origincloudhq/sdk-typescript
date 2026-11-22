import { setTimeout as sleep } from "node:timers/promises";

import { type FetchLike, MAX_TOKEN_RESPONSE_BYTES, readLimited } from "./credentials.js";

/** Where the security token service (STS) exchanges a CI job's OIDC token or a key's assertion for an access token. */
export const STS_ENDPOINT = "https://sts.origincloudapis.eu";

/** How long before its expiry an access token from the STS is replaced. */
export const STS_EXPIRY_MARGIN_MS = 60_000;

/** How long to wait before exchanging again after the STS answered 503: twice, so three attempts in all. */
const STS_RETRY_DELAYS_MS = [200, 400];

/** The STS's answer to a token request. */
export interface StsAnswer {
  status: number;
  /** The answer's JSON object; empty when it is none. */
  body: Record<string, unknown>;
}

/**
 * Posts `form` to the STS's OAuth token endpoint, `{endpoint}/v1/token`,
 * again while it answers 503, and returns the last answer. `what` names
 * the request in the error when no answer comes.
 */
export async function postToSts(
  fetchImpl: FetchLike | undefined,
  endpoint: string,
  form: Record<string, string>,
  what: string,
): Promise<StsAnswer> {
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  };
  const url = endpoint + "/v1/token";
  for (let attempt = 0; ; attempt++) {
    let status: number;
    let text: string;
    try {
      const response = await (fetchImpl ?? globalThis.fetch).call(globalThis, url, init);
      status = response.status;
      text = (await readLimited(response, MAX_TOKEN_RESPONSE_BYTES)).text;
    } catch (err) {
      throw new Error(`origincloud: ${what} at ${endpoint}: ${String(err)}`, { cause: err });
    }
    const delay = STS_RETRY_DELAYS_MS[attempt];
    if (status === 503 && delay !== undefined) {
      await sleep(delay);
      continue;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status, body: typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {} };
  }
}

/**
 * The access token in a 200 answer, and when it expires, in milliseconds
 * since the epoch.
 */
export function grantedBySts(answer: StsAnswer): { token: string; expiry: number } {
  const token = answer.body["access_token"];
  if (typeof token !== "string" || !token) {
    throw new Error("origincloud: the STS's answer is not a credential");
  }
  return { token, expiry: Date.now() + (Number(answer.body["expires_in"]) || 0) * 1000 };
}

/** The error of an STS answering 503 even after the retries. */
export function stsUnavailable(): Error {
  return new Error("origincloud: the STS is temporarily unavailable (HTTP 503): try again later");
}

/**
 * The error of a refusal other than the ones a caller explains itself: its
 * status, `error` and `error_description`, with `secret` (what was sent,
 * which the description is not expected to quote) never shown.
 */
export function stsRefused(answer: StsAnswer, what: string, secret: string): Error {
  const error = typeof answer.body["error"] === "string" ? answer.body["error"] : "";
  const description = String(answer.body["error_description"] ?? "").replaceAll(secret, "[token]");
  const reason = [error, description].filter(Boolean).join(": ");
  return new Error(`origincloud: the STS refused ${what} (HTTP ${answer.status})${reason ? ": " + reason : ""}`);
}
