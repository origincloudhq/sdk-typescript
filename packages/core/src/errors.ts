/** One request field the API refused. */
export interface FieldViolation {
  /** The field's JSON path, such as `volume.sizeGib`. */
  readonly field: string;
  readonly description: string;
}

/** What an {@link OriginCloudError} is made of. */
export interface OriginCloudErrorFields {
  httpStatus: number;
  status: string;
  reason: string;
  message: string;
  requestId: string;
  fieldViolations: FieldViolation[];
  retryDelayMs: number;
  retryable: boolean;
}

/**
 * A call the API refused, or an operation that failed. Branch on
 * {@link OriginCloudError.reason}.
 */
export class OriginCloudError extends Error {
  /** The response's status code; 0 for an operation's error. */
  readonly httpStatus: number;
  /** The closest canonical code, such as `NOT_FOUND`, for generic tooling. */
  readonly status: string;
  /**
   * The platform's error code, such as `NOT_FOUND` or `CONFLICT`: what to
   * branch on.
   */
  readonly reason: string;
  /** Identifies the request to Origin Cloud's support. */
  readonly requestId: string;
  /** The request fields that were refused, by their JSON path. */
  readonly fieldViolations: readonly FieldViolation[];
  /**
   * How long the API asks to wait before trying again, in milliseconds; 0
   * when it doesn't ask.
   */
  readonly retryDelayMs: number;
  /** Whether the same call may succeed if it is sent again. */
  readonly retryable: boolean;
  // `message` is what went wrong, for a person, as the API said it.

  constructor(fields: Partial<OriginCloudErrorFields>) {
    super(fields.message ?? "");
    this.name = "OriginCloudError";
    this.httpStatus = fields.httpStatus ?? 0;
    this.status = fields.status ?? "";
    this.reason = fields.reason ?? "";
    this.requestId = fields.requestId ?? "";
    this.fieldViolations = fields.fieldViolations ?? [];
    this.retryDelayMs = fields.retryDelayMs ?? 0;
    this.retryable = fields.retryable ?? false;
    // A V8 stack trace's first line, which Node prints, says what went
    // wrong in full; other engines' traces have no such line.
    const stack = this.stack;
    if (typeof stack === "string") {
      const end = stack.indexOf("\n");
      const first = end < 0 ? stack : stack.slice(0, end);
      if (/^\w*Error: /.test(first) && first.endsWith(this.message)) {
        this.stack = `${this.name}: ${this.summary()}` + (end < 0 ? "" : stack.slice(end));
      }
    }
  }

  /**
   * The error in one line: the reason, the message and the request id,
   * such as `origincloud: NOT_FOUND: volume not found (request 9f1c...)`.
   */
  override toString(): string {
    return "origincloud: " + this.summary();
  }

  private summary(): string {
    let summary = this.reason || this.status || `HTTP ${this.httpStatus}`;
    if (this.message) summary += ": " + this.message;
    if (this.requestId) summary += ` (request ${this.requestId})`;
    return summary;
  }
}

/**
 * The {@link OriginCloudError.reason} of `err`, or `""` when it isn't an
 * {@link OriginCloudError}.
 */
export function reasonOf(err: unknown): string {
  return err instanceof OriginCloudError ? err.reason : "";
}

const TYPE_ERROR_INFO = "type.googleapis.com/google.rpc.ErrorInfo";
const TYPE_REQUEST_INFO = "type.googleapis.com/google.rpc.RequestInfo";
const TYPE_RETRY_INFO = "type.googleapis.com/google.rpc.RetryInfo";
const TYPE_BAD_REQUEST = "type.googleapis.com/google.rpc.BadRequest";

// google.rpc.Code, by number.
const CODES = [
  "OK",
  "CANCELLED",
  "UNKNOWN",
  "INVALID_ARGUMENT",
  "DEADLINE_EXCEEDED",
  "NOT_FOUND",
  "ALREADY_EXISTS",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "FAILED_PRECONDITION",
  "ABORTED",
  "OUT_OF_RANGE",
  "UNIMPLEMENTED",
  "INTERNAL",
  "UNAVAILABLE",
  "DATA_LOSS",
  "UNAUTHENTICATED",
];

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A JSON duration, such as `1.5s`, in milliseconds; 0 when it isn't one. */
export function parseDuration(value: unknown): number {
  const match = typeof value === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(value) : null;
  return match?.[1] ? Math.round(Number(match[1]) * 1000) : 0;
}

/** The fields a google.rpc.Status's details carry. */
function readDetails(details: unknown, into: Partial<OriginCloudErrorFields>): void {
  if (!Array.isArray(details)) return;
  for (const detail of details) {
    if (!isRecord(detail)) continue;
    switch (detail["@type"]) {
      case TYPE_ERROR_INFO:
        into.reason = str(detail["reason"]);
        break;
      case TYPE_REQUEST_INFO:
        into.requestId = str(detail["requestId"]);
        break;
      case TYPE_RETRY_INFO:
        into.retryable = true;
        into.retryDelayMs = parseDuration(detail["retryDelay"]);
        break;
      case TYPE_BAD_REQUEST: {
        const violations = Array.isArray(detail["fieldViolations"]) ? detail["fieldViolations"] : [];
        into.fieldViolations = [
          ...(into.fieldViolations ?? []),
          ...violations.filter(isRecord).map((v) => ({ field: str(v["field"]), description: str(v["description"]) })),
        ];
        break;
      }
    }
  }
}

/**
 * The error a response with a status other than 200 carries. A response
 * that carries none, such as a proxy's, is an error by its status alone,
 * retryable when the status is.
 */
export function errorFromResponse(httpStatus: number, body: string): OriginCloudError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const status = isRecord(parsed) ? parsed["error"] : undefined;
  if (!isRecord(status)) {
    const fields: Partial<OriginCloudErrorFields> = {
      httpStatus,
      message: STATUS_TEXT[httpStatus] ?? `HTTP ${httpStatus}`,
    };
    if (httpStatus === 502 || httpStatus === 503 || httpStatus === 504) {
      fields.status = "UNAVAILABLE";
      fields.retryable = true;
    }
    return new OriginCloudError(fields);
  }
  const fields: Partial<OriginCloudErrorFields> = {
    httpStatus,
    status: str(status["status"]),
    message: str(status["message"]),
  };
  readDetails(status["details"], fields);
  return new OriginCloudError(fields);
}

/** The error a failed operation carries: a google.rpc.Status. */
export function errorFromStatus(status: unknown): OriginCloudError {
  const s = isRecord(status) ? status : {};
  const code = typeof s["code"] === "number" ? s["code"] : 2;
  const fields: Partial<OriginCloudErrorFields> = {
    status: CODES[code] ?? `CODE_${code}`,
    message: str(s["message"]),
  };
  readDetails(s["details"], fields);
  // An operation's error is its outcome: sending the call again doesn't
  // change it.
  fields.retryable = false;
  fields.retryDelayMs = 0;
  return new OriginCloudError(fields);
}
