import { errorFromStatus } from "./errors.js";
import { type CallOptions, type Service, pathValue } from "./transport.js";

/** A `google.protobuf.Any` in its JSON form: the message's fields and its type. */
export interface Any {
  "@type": string;
  [field: string]: unknown;
}

/** A `google.protobuf.Empty`: the result of an operation that has none, such as a delete. */
export type Empty = Record<string, never>;

/** A `google.rpc.Status`: what an operation failed with. */
export interface Status {
  /** The canonical code, a `google.rpc.Code`. */
  code?: number;
  message?: string;
  details?: Any[];
}

/** A `google.longrunning.Operation` in its JSON form. */
export interface LongrunningOperation {
  /** The operation's resource name, `projects/{project}/zones/{zone}/operations/{operation}`. */
  name?: string;
  /** What the operation is about. */
  metadata?: Any;
  /** Whether it has finished. */
  done?: boolean;
  /** What it failed with, once done. */
  error?: Status;
  /** Its result, once done. */
  response?: Any;
}

/** The longest the API waits for an operation in one call. */
const MAX_WAIT_PER_CALL = "60s";

// The well-known types whose JSON is not an object, which an Any holds
// in its `value`.
const WRAPPED_IN_ANY = new Set([
  "google.protobuf.Duration",
  "google.protobuf.Timestamp",
  "google.protobuf.FieldMask",
  "google.protobuf.Struct",
  "google.protobuf.Value",
  "google.protobuf.ListValue",
  "google.protobuf.BoolValue",
  "google.protobuf.BytesValue",
  "google.protobuf.DoubleValue",
  "google.protobuf.FloatValue",
  "google.protobuf.Int32Value",
  "google.protobuf.Int64Value",
  "google.protobuf.StringValue",
  "google.protobuf.UInt32Value",
  "google.protobuf.UInt64Value",
]);

/** The message an Any holds, without its type. */
function unpack(any: Any, type: string): unknown {
  if (WRAPPED_IN_ANY.has(type)) return any["value"];
  const { "@type": _type, ...fields } = any;
  return fields;
}

/**
 * A mutation the API accepted and carries out after answering. Its result,
 * of type `T`, is the resource it acted on, or {@link Empty} for a delete;
 * `M` is its metadata.
 */
export class Operation<T, M = unknown> {
  private readonly service: Service;
  private op: LongrunningOperation;
  private readonly resultType: string;

  /**
   * The operation `op`, which a method of `service` answered with, whose
   * result is a `resultType`, such as `origincloud.pvs.v1beta1.Volume`.
   * Generated clients construct it.
   */
  constructor(service: Service, op: LongrunningOperation, resultType: string) {
    this.service = service;
    this.op = op;
    this.resultType = resultType;
  }

  /** The operation's resource name, by which {@link Operation.wait} and a service's OperationClient find it. */
  get name(): string {
    return this.op.name ?? "";
  }

  /** Whether the operation had finished when it was last read. */
  get done(): boolean {
    return this.op.done ?? false;
  }

  /** What the operation is about, as it was last read. */
  get metadata(): M | undefined {
    const metadata = this.op.metadata;
    return metadata ? (unpack(metadata, String(metadata["@type"] ?? "").replace(/^.*\//, "")) as M) : undefined;
  }

  /** The operation as it was last read. */
  get raw(): LongrunningOperation {
    return this.op;
  }

  /**
   * Waits until the operation finishes and returns its result, or throws
   * the {@link OriginCloudError} it failed with. Once it returns, reads
   * through the same client show the operation's effect.
   */
  async wait(options: CallOptions = {}): Promise<T> {
    while (!this.done) {
      const path = pathValue("operation name", this.op.name, "projects/*/zones/*/operations/*");
      this.op = await this.service.call<LongrunningOperation>(
        { method: "POST", path: `/v1beta1/${path}:wait`, body: { timeout: MAX_WAIT_PER_CALL }, idempotent: true },
        options,
      );
    }
    return this.result();
  }

  /**
   * The result of an operation that is done, or the
   * {@link OriginCloudError} it failed with. It throws for an operation
   * that isn't done yet.
   */
  result(): T {
    if (!this.done) {
      throw new Error(`origincloud: operation ${this.name} isn't done`);
    }
    if (this.op.error) throw errorFromStatus(this.op.error);
    const response = this.op.response;
    const want = "type.googleapis.com/" + this.resultType;
    if (!response || response["@type"] !== want) {
      throw new Error(
        `origincloud: reading the result of operation ${this.name}: ` +
          `got ${response ? response["@type"] : "none"}, want ${want}`,
      );
    }
    return unpack(response, this.resultType) as T;
  }
}
