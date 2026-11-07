// Generates the service packages' sources from the API definitions: one
// TypeScript module per proto file, with an interface per message in its
// proto3 JSON form, an object and a union type per enum, and a client
// class per service whose methods send their google.api.http binding
// through @origincloud/core.
//
// A method answering with a long-running operation returns an Operation of
// the result its operation_info names. A list method (AIP-158) also gets an
// all... method iterating over every page. A method with a request_id gets
// one filled in when it is empty, so that it is safe to retry.
//
//   node generator/dist/main.js <descriptors.json> <out>
//
// reads the descriptor set `buf build --as-file-descriptor-set` wrote as
// JSON and writes <out>/<service>/src/... for each service under
// origincloud/<service>/. The shared origincloud.longrunning package is
// generated into each service package that uses it, its OperationService
// client bound to that service's host.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import type {
  EnumDescriptor,
  FieldDescriptor,
  FileDescriptor,
  FileDescriptorSet,
  HttpRule,
  MessageDescriptor,
  MethodDescriptor,
  ServiceDescriptor,
} from "./descriptors.js";

/** The services that answer only at their regionless host. */
const GLOBAL_SERVICES = new Set(["iam", "resourcemanager", "location", "billing", "support", "dns"]);

/** Packages every service shares, generated into each service package that uses them. */
const SHARED_PACKAGES = ["origincloud.longrunning."];

const CORE = "@origincloud/core";
const OPERATION_TYPE = "google.longrunning.Operation";

// Descriptor paths (google.protobuf.SourceCodeInfo.Location.path).
const FILE_MESSAGE = 4;
const FILE_ENUM = 5;
const FILE_SERVICE = 6;
const MESSAGE_FIELD = 2;
const MESSAGE_NESTED = 3;
const MESSAGE_ENUM = 4;
const ENUM_VALUE = 2;
const SERVICE_METHOD = 2;

/** A message or enum, by its full name without the leading dot. */
interface TypeInfo {
  file: FileDescriptor;
  /** Its TypeScript name: nested names joined by `_`, such as `Volume_State`. */
  tsName: string;
  message?: MessageDescriptor;
  enum?: EnumDescriptor;
}

/** The types of the well-known and Google packages the APIs use, by full name. */
const MAPPED: Record<string, { type: string; core?: string }> = {
  "google.protobuf.Timestamp": { type: "string" },
  "google.protobuf.Duration": { type: "string" },
  "google.protobuf.FieldMask": { type: "string" },
  "google.protobuf.Struct": { type: "Record<string, unknown>" },
  "google.protobuf.Value": { type: "unknown" },
  "google.protobuf.ListValue": { type: "unknown[]" },
  "google.protobuf.BoolValue": { type: "boolean" },
  "google.protobuf.BytesValue": { type: "string" },
  "google.protobuf.DoubleValue": { type: "number" },
  "google.protobuf.FloatValue": { type: "number" },
  "google.protobuf.Int32Value": { type: "number" },
  "google.protobuf.UInt32Value": { type: "number" },
  "google.protobuf.Int64Value": { type: "string" },
  "google.protobuf.UInt64Value": { type: "string" },
  "google.protobuf.StringValue": { type: "string" },
  "google.protobuf.Empty": { type: "Empty", core: "Empty" },
  "google.protobuf.Any": { type: "Any", core: "Any" },
  "google.rpc.Status": { type: "Status", core: "Status" },
  [OPERATION_TYPE]: { type: "LongrunningOperation", core: "LongrunningOperation" },
};

class GenerateError extends Error {}

function fail(message: string): never {
  throw new GenerateError(message);
}

function main(): void {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) {
    console.error("usage: main.js <descriptors.json> <out>");
    process.exit(2);
  }
  const set = JSON.parse(readFileSync(input, "utf8")) as FileDescriptorSet;
  try {
    for (const [path, content] of generate(set)) {
      const target = join(out, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  } catch (err) {
    if (err instanceof GenerateError) {
      console.error(`generator: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

/** The generated files, by their path under the output directory. */
export function generate(set: FileDescriptorSet): Map<string, string> {
  const files = new Map(set.file.map((f) => [f.name, f]));
  const types = new Map<string, TypeInfo>();
  const jsonNames = new Map<string, string>();
  for (const file of set.file) {
    const prefix = file.package ? file.package + "." : "";
    for (const m of file.messageType ?? []) collectMessage(types, jsonNames, file, prefix, "", m);
    for (const e of file.enumType ?? []) types.set(prefix + e.name, { file, tsName: e.name, enum: e });
  }

  const services = new Set<string>();
  for (const file of set.file) {
    const match = /^origincloud\.([a-z0-9_]+)\./.exec(file.package ?? "");
    if (match?.[1] && !SHARED_PACKAGES.some((p) => file.package?.startsWith(p))) services.add(match[1]);
  }

  const output = new Map<string, string>();
  for (const service of [...services].sort()) {
    const own = set.file.filter((f) => f.package?.startsWith(`origincloud.${service}.`));
    const included = new Map<string, string>(); // proto file -> module path under src/
    for (const f of own) included.set(f.name, f.name.slice(`origincloud/${service}/`.length).replace(/\.proto$/, ".ts"));
    const pending = [...own];
    while (pending.length > 0) {
      const f = pending.pop()!;
      for (const dep of f.dependency ?? []) {
        const d = files.get(dep);
        if (!d?.package?.startsWith("origincloud.") || included.has(d.name)) continue;
        if (!SHARED_PACKAGES.some((p) => d.package!.startsWith(p))) {
          fail(`${f.name} imports ${d.name} of another service, which isn't supported yet`);
        }
        included.set(d.name, d.name.slice("origincloud/".length).replace(/\.proto$/, ".ts"));
        pending.push(d);
      }
    }
    const ctx: PackageContext = { service, types, jsonNames, modules: included };
    const directories = new Map<string, string[]>();
    for (const [protoFile, module] of [...included].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      output.set(`${service}/src/${module}`, new FileGenerator(ctx, files.get(protoFile)!, module).generate());
      const dir = posix.dirname(module);
      directories.set(dir, [...(directories.get(dir) ?? []), posix.basename(module, ".ts")]);
    }
    for (const [dir, modules] of directories) {
      const lines = [HEADER, "", ...modules.sort().map((m) => `export * from "./${m}.js";`), ""];
      output.set(`${service}/src/${dir}/index.ts`, lines.join("\n"));
    }
  }
  return output;
}

function collectMessage(
  types: Map<string, TypeInfo>,
  jsonNames: Map<string, string>,
  file: FileDescriptor,
  prefix: string,
  tsPrefix: string,
  m: MessageDescriptor,
): void {
  const tsName = tsPrefix + m.name;
  types.set(prefix + m.name, { file, tsName, message: m });
  if (file.package?.startsWith("origincloud.")) {
    for (const f of m.field ?? []) {
      if (!jsonNames.has(f.name)) jsonNames.set(f.name, jsonName(f));
    }
  }
  for (const n of m.nestedType ?? []) collectMessage(types, jsonNames, file, prefix + m.name + ".", tsName + "_", n);
  for (const e of m.enumType ?? []) {
    types.set(prefix + m.name + "." + e.name, { file, tsName: tsName + "_" + e.name, enum: e });
  }
}

function jsonName(f: FieldDescriptor): string {
  return f.jsonName ?? f.name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const HEADER = "// Code generated by the SDK's generator (generator/). DO NOT EDIT.";

interface PackageContext {
  service: string;
  types: Map<string, TypeInfo>;
  /** Proto field names and their JSON names, for rewriting comments. */
  jsonNames: Map<string, string>;
  /** The proto files generated into the package, and their module paths under src/. */
  modules: Map<string, string>;
}

/** One generated module: the TypeScript of one proto file. */
class FileGenerator {
  private readonly ctx: PackageContext;
  private readonly file: FileDescriptor;
  private readonly module: string;
  private readonly comments = new Map<string, string>();
  /** Imported names by module, and whether each is only a type. */
  private readonly imports = new Map<string, Map<string, boolean>>();
  private readonly body: string[] = [];

  constructor(ctx: PackageContext, file: FileDescriptor, module: string) {
    this.ctx = ctx;
    this.file = file;
    this.module = module;
    for (const location of file.sourceCodeInfo?.location ?? []) {
      if (location.leadingComments) this.comments.set((location.path ?? []).join(","), location.leadingComments);
    }
  }

  generate(): string {
    (this.file.service ?? []).forEach((s, i) => this.service(s, [FILE_SERVICE, i]));
    (this.file.enumType ?? []).forEach((e, i) => this.enumeration(e, e.name, [FILE_ENUM, i]));
    (this.file.messageType ?? []).forEach((m, i) => this.message(m, m.name, [FILE_MESSAGE, i]));

    const lines = [HEADER, `// source: ${this.file.name}`, ""];
    const modules = [...this.imports.keys()].sort((a, b) => {
      // The core package first, then the package's own modules.
      const rank = (m: string) => (m.startsWith(".") ? 1 : 0);
      return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const module of modules) {
      const names = [...this.imports.get(module)!].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const typeOnly = names.every(([, t]) => t);
      const specifiers = names.map(([n, t]) => (t && !typeOnly ? "type " + n : n));
      const keyword = typeOnly ? "import type" : "import";
      const line = `${keyword} { ${specifiers.join(", ")} } from "${module}";`;
      if (line.length <= 100) {
        lines.push(line);
      } else {
        lines.push(`${keyword} {`, ...specifiers.map((n) => `  ${n},`), `} from "${module}";`);
      }
    }
    if (modules.length > 0) lines.push("");
    lines.push(...this.body);
    while (lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n") + "\n";
  }

  private use(module: string, name: string, typeOnly: boolean): void {
    const names = this.imports.get(module) ?? new Map<string, boolean>();
    names.set(name, (names.get(name) ?? true) && typeOnly);
    this.imports.set(module, names);
  }

  private core(name: string, typeOnly = true): string {
    this.use(CORE, name, typeOnly);
    return name;
  }

  private emit(...lines: string[]): void {
    this.body.push(...lines);
  }

  // Comments.

  /** The proto comment at `path`, without the API linter's directives and with field names in their JSON form. */
  private comment(path: number[]): string[] {
    const raw = this.comments.get(path.join(","));
    if (!raw) return [];
    const text = raw.replace(/\(--[\s\S]*?--\)/g, "").trim();
    if (!text) return [];
    return text.split("\n").map((line) =>
      line
        .replace(/^ /, "")
        .trimEnd()
        .replace(/`([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)`/g, (whole, name: string) => {
          const segments = name.split(".");
          if (!segments.every((s) => this.ctx.jsonNames.has(s))) return whole;
          return "`" + segments.map((s) => this.ctx.jsonNames.get(s)).join(".") + "`";
        }),
    );
  }

  private doc(lines: string[], indent: string): void {
    const escaped = lines.map((l) => l.replace(/\*\//g, "*\\/"));
    while (escaped.length > 0 && escaped[escaped.length - 1] === "") escaped.pop();
    if (escaped.length === 0) return;
    if (escaped.length === 1) {
      this.emit(`${indent}/** ${escaped[0]} */`);
      return;
    }
    this.emit(`${indent}/**`, ...escaped.map((l) => (l ? `${indent} * ${l}` : `${indent} *`)), `${indent} */`);
  }

  // Types.

  private typeInfo(typeName: string): TypeInfo {
    const info = this.ctx.types.get(typeName.replace(/^\./, ""));
    if (!info) fail(`${this.file.name}: the type ${typeName} isn't defined`);
    return info;
  }

  /** The TypeScript type of a message or enum, importing it when it is defined elsewhere. */
  private ref(typeName: string): string {
    const fullName = typeName.replace(/^\./, "");
    const mapped = MAPPED[fullName];
    if (mapped) {
      if (mapped.core) this.core(mapped.core);
      return mapped.type;
    }
    const info = this.typeInfo(fullName);
    if (info.file === this.file) return info.tsName;
    const module = this.ctx.modules.get(info.file.name);
    if (!module) fail(`${this.file.name}: ${fullName} is in ${info.file.name}, which the SDK doesn't generate`);
    let relative = posix.relative(posix.dirname(this.module), module).replace(/\.ts$/, ".js");
    if (!relative.startsWith(".")) relative = "./" + relative;
    this.use(relative, info.tsName, true);
    return info.tsName;
  }

  private fieldType(field: FieldDescriptor): string {
    if (field.label === "LABEL_REPEATED" && field.type === "TYPE_MESSAGE") {
      const entry = this.typeInfo(field.typeName!).message;
      if (entry?.options?.mapEntry) {
        const value = entry.field?.find((f) => f.name === "value");
        if (!value) fail(`${field.typeName} is a map entry without a value`);
        return `Record<string, ${this.singularType(value)}>`;
      }
    }
    const type = this.singularType(field);
    if (field.label !== "LABEL_REPEATED") return type;
    return /[ |]/.test(type) ? `(${type})[]` : `${type}[]`;
  }

  private singularType(field: FieldDescriptor): string {
    switch (field.type) {
      case "TYPE_DOUBLE":
      case "TYPE_FLOAT":
      case "TYPE_INT32":
      case "TYPE_UINT32":
      case "TYPE_SINT32":
      case "TYPE_FIXED32":
      case "TYPE_SFIXED32":
        return "number";
      // proto3 JSON writes 64-bit integers as decimal strings.
      case "TYPE_INT64":
      case "TYPE_UINT64":
      case "TYPE_SINT64":
      case "TYPE_FIXED64":
      case "TYPE_SFIXED64":
        return "string";
      case "TYPE_BOOL":
        return "boolean";
      case "TYPE_STRING":
      case "TYPE_BYTES":
        return "string";
      case "TYPE_ENUM":
      case "TYPE_MESSAGE":
        return this.ref(field.typeName!);
      case "TYPE_GROUP":
        return fail(`${field.name}: groups aren't supported`);
    }
  }

  private message(m: MessageDescriptor, tsName: string, path: number[]): void {
    if (m.options?.mapEntry) return;
    this.doc(this.comment(path), "");
    const fields = m.field ?? [];
    if (fields.length === 0) {
      this.emit(`export interface ${tsName} {}`, "");
    } else {
      this.emit(`export interface ${tsName} {`);
      fields.forEach((f, i) => {
        this.doc(this.comment([...path, MESSAGE_FIELD, i]), "  ");
        this.emit(`  ${jsonName(f)}?: ${this.fieldType(f)};`);
      });
      this.emit("}", "");
    }
    (m.enumType ?? []).forEach((e, i) => this.enumeration(e, `${tsName}_${e.name}`, [...path, MESSAGE_ENUM, i]));
    (m.nestedType ?? []).forEach((n, i) => this.message(n, `${tsName}_${n.name}`, [...path, MESSAGE_NESTED, i]));
  }

  private enumeration(e: EnumDescriptor, tsName: string, path: number[]): void {
    const doc = this.comment(path);
    this.doc(doc, "");
    this.emit(`export const ${tsName} = {`);
    (e.value ?? []).forEach((v, i) => {
      this.doc(this.comment([...path, ENUM_VALUE, i]), "  ");
      this.emit(`  ${v.name}: "${v.name}",`);
    });
    this.emit("} as const;", "");
    this.doc(doc, "");
    this.emit(`export type ${tsName} = (typeof ${tsName})[keyof typeof ${tsName}];`, "");
  }

  // Services.

  private service(s: ServiceDescriptor, path: number[]): void {
    const client = s.name.replace(/Service$/, "") + "Client";
    const host = s.options?.["[google.api.default_host]"];
    const shortcode = host ? host.split(".")[0]! : this.ctx.service;
    const regional = !GLOBAL_SERVICES.has(shortcode);
    const clientType = this.core("Client");
    const serviceType = this.core("Service");

    const doc = [`Calls ${s.name}.`];
    const comment = this.comment(path);
    if (comment.length > 0) doc.push("", ...comment);
    this.doc(doc, "");
    this.emit(`export class ${client} {`);
    this.doc(
      [
        "The endpoint the client sends its calls to, which also serves the",
        "operations its methods answer with.",
      ],
      "  ",
    );
    this.emit(`  readonly service: ${serviceType};`, "");
    if (host) {
      this.doc([`A client of ${s.name} that sends its calls through \`client\`.`], "  ");
    } else {
      this.doc(
        [
          `A client of ${s.name} at the ${shortcode} host, which serves the`,
          `operations the ${shortcode} methods answer with.`,
        ],
        "  ",
      );
    }
    this.emit(
      `  constructor(client: ${clientType}) {`,
      `    this.service = client.service(${JSON.stringify(shortcode)}, ${regional});`,
      "  }",
    );
    (s.method ?? []).forEach((m, i) => {
      try {
        this.method(m, [...path, SERVICE_METHOD, i]);
      } catch (err) {
        if (err instanceof GenerateError) fail(`${s.name}.${m.name}: ${err.message}`);
        throw err;
      }
    });
    this.emit("}", "");
  }

  private method(m: MethodDescriptor, path: number[]): void {
    if (m.clientStreaming || m.serverStreaming) fail("streaming isn't supported");
    const rule = m.options?.["[google.api.http]"];
    if (!rule) fail("no google.api.http binding");
    const [verb, template] = binding(rule);
    if (!template || (rule.additionalBindings ?? []).length > 0) fail("one binding with a path is supported");

    const input = this.typeInfo(m.inputType);
    const inputMessage = input.message!;
    const inputType = this.ref(m.inputType);
    const name = lowerFirst(m.name);
    const callOptions = this.core("CallOptions");

    // The result: an Operation of the result operation_info names, or the
    // output message.
    let returns: string;
    let operation: { result: string; resultName: string; metadata: string } | undefined;
    const info = m.options?.["[google.longrunning.operation_info]"];
    if (m.outputType.replace(/^\./, "") === OPERATION_TYPE && info) {
      const resultName = this.resolve(info.responseType ?? "");
      const result = this.ref(resultName);
      const metadata = info.metadataType ? this.ref(this.resolve(info.metadataType)) : "unknown";
      returns = `${this.core("Operation", false)}<${result}, ${metadata}>`;
      operation = { result, resultName, metadata };
    } else {
      returns = this.ref(m.outputType);
    }

    const doc = this.comment(path);
    if (doc.length === 0) doc.push(`Calls ${m.name}.`);
    if (operation) {
      doc.push(
        "",
        operation.resultName === "google.protobuf.Empty"
          ? "It answers with an operation to wait on, which has no result."
          : `It answers with an operation to wait on, whose result is the ${operation.result}.`,
      );
    }
    this.emit("");
    this.doc(doc, "  ");
    this.emit(`  async ${name}(request: ${inputType}, options?: ${callOptions}): Promise<${returns}> {`);

    const requestId = fieldNamed(inputMessage, "request_id");
    // Or the API declares it safe to repeat, as a read that isn't a GET
    // (WaitOperation) does.
    const level = m.options?.idempotencyLevel;
    const idempotent = verb === "GET" || requestId !== undefined || (level !== undefined && level !== "IDEMPOTENCY_UNKNOWN");
    if (requestId) {
      if (requestId.type !== "TYPE_STRING") fail("request_id isn't a string");
      const key = jsonName(requestId);
      this.emit(`    if (!request.${key}) request = { ...request, ${key}: ${this.core("newRequestId", false)}() };`);
    }

    let pathExpression = "";
    const bound: string[] = [];
    let variable = 0;
    for (const segment of this.parseTemplate(input, template)) {
      if (segment.literal !== undefined) {
        pathExpression += segment.literal.replace(/[`\\]|\$\{/g, (c) => "\\" + c);
        continue;
      }
      const jsonPath = segment.fields.map(jsonName).join(".");
      const access = "request." + segment.fields.map(jsonName).join("?.");
      bound.push(jsonPath);
      const v = `p${variable++}`;
      this.emit(
        `    const ${v} = ${this.core("pathValue", false)}(${JSON.stringify(jsonPath)}, ${access}, ${JSON.stringify(segment.pattern)});`,
      );
      pathExpression += "${" + v + "}";
    }

    const request = [`method: "${verb}"`, `path: \`${pathExpression}\``];
    const body = rule.body ?? "";
    if (body === "*") {
      request.push("body: request");
    } else {
      const skip = [...bound];
      if (body) {
        const field = fieldNamed(inputMessage, body);
        if (!field) fail(`the body field ${body} isn't a field of ${input.tsName}`);
        skip.push(jsonName(field));
        request.push(`body: request.${jsonName(field)}`);
      }
      request.push(`query: ${this.core("query", false)}(request, ${JSON.stringify(skip).replace(/,/g, ", ")})`);
    }
    if (idempotent) request.push("idempotent: true");

    const call = ["      {", ...request.map((r) => `        ${r},`), "      },", "      options,", "    );"];
    if (operation) {
      const raw = this.core("LongrunningOperation");
      this.emit(`    const op = await this.service.call<${raw}>(`, ...call);
      this.emit(
        `    return new Operation<${operation.result}, ${operation.metadata}>(this.service, op, ${JSON.stringify(operation.resultName)});`,
      );
    } else {
      this.emit(`    return this.service.call<${returns}>(`, ...call);
    }
    this.emit("  }");

    const items = listItems(this.ctx.types, m, inputMessage);
    if (items) this.all(name, inputType, items, callOptions);
  }

  /** An all... method iterating over every page of the list method `listName`. */
  private all(listName: string, inputType: string, items: FieldDescriptor, callOptions: string): void {
    const itemType = this.ref(items.typeName!);
    const field = jsonName(items);
    const name = "all" + field.charAt(0).toUpperCase() + field.slice(1);
    this.emit("");
    this.doc(
      [
        `Iterates over everything ${listName} lists from the request's page on,`,
        "fetching the next page as the loop reaches it. A page that fails ends",
        "the iteration with its error.",
      ],
      "  ",
    );
    this.emit(
      `  async *${name}(request: ${inputType}, options?: ${callOptions}): AsyncGenerator<${itemType}, void, undefined> {`,
      "    for (let page = request; ; ) {",
      `      const response = await this.${listName}(page, options);`,
      `      yield* response.${field} ?? [];`,
      "      if (!response.nextPageToken) return;",
      "      page = { ...page, pageToken: response.nextPageToken };",
      "    }",
      "  }",
    );
  }

  /** A type name of operation_info, resolved against the file's package when it is relative. */
  private resolve(name: string): string {
    if (!name) fail("operation_info names no response type");
    if (name.includes(".")) return name;
    return (this.file.package ? this.file.package + "." : "") + name;
  }

  /**
   * Splits a path template, such as `/v1beta1/{name=projects/*}:wait`, into
   * literals and the fields its variables bind.
   */
  private parseTemplate(input: TypeInfo, template: string): Segment[] {
    const segments: Segment[] = [];
    let rest = template;
    while (rest !== "") {
      const open = rest.indexOf("{");
      if (open < 0) {
        segments.push({ literal: rest, fields: [], pattern: "" });
        break;
      }
      if (open > 0) segments.push({ literal: rest.slice(0, open), fields: [], pattern: "" });
      const end = rest.indexOf("}", open);
      if (end < 0) fail(`unbalanced braces in ${template}`);
      const variable = rest.slice(open + 1, end);
      const eq = variable.indexOf("=");
      const fieldPath = eq < 0 ? variable : variable.slice(0, eq);
      const pattern = eq < 0 ? "*" : variable.slice(eq + 1);
      if (pattern.includes("**")) fail(`${template}: ** isn't supported`);
      segments.push({ fields: this.resolveField(input, fieldPath), pattern });
      rest = rest.slice(end + 1);
    }
    return segments;
  }

  /** The string field a dotted path names. */
  private resolveField(input: TypeInfo, path: string): FieldDescriptor[] {
    const fields: FieldDescriptor[] = [];
    let message: MessageDescriptor | undefined = input.message;
    for (const name of path.split(".")) {
      const field = message ? fieldNamed(message, name) : undefined;
      if (!field) fail(`the path variable ${path} isn't a field`);
      fields.push(field);
      message = field.type === "TYPE_MESSAGE" ? this.typeInfo(field.typeName!).message : undefined;
    }
    const last = fields[fields.length - 1]!;
    if (last.type !== "TYPE_STRING" || last.label === "LABEL_REPEATED") {
      fail(`the path variable ${path} isn't a string field`);
    }
    return fields;
  }
}

interface Segment {
  literal?: string;
  fields: FieldDescriptor[];
  pattern: string;
}

function binding(rule: HttpRule): [string, string] {
  if (rule.get !== undefined) return ["GET", rule.get];
  if (rule.post !== undefined) return ["POST", rule.post];
  if (rule.put !== undefined) return ["PUT", rule.put];
  if (rule.patch !== undefined) return ["PATCH", rule.patch];
  if (rule.delete !== undefined) return ["DELETE", rule.delete];
  return ["", ""];
}

function fieldNamed(message: MessageDescriptor, name: string): FieldDescriptor | undefined {
  return (message.field ?? []).find((f) => f.name === name);
}

/**
 * The repeated message field of a list method (AIP-158): its request takes
 * a page token and its response carries the next one and one repeated
 * field of messages.
 */
function listItems(
  types: Map<string, TypeInfo>,
  m: MethodDescriptor,
  input: MessageDescriptor,
): FieldDescriptor | undefined {
  const output = types.get(m.outputType.replace(/^\./, ""))?.message;
  if (!output || !fieldNamed(input, "page_token") || !fieldNamed(output, "next_page_token")) return undefined;
  const repeated = (output.field ?? []).filter((f) => {
    if (f.label !== "LABEL_REPEATED" || f.type !== "TYPE_MESSAGE") return false;
    return !types.get(f.typeName!.replace(/^\./, ""))?.message?.options?.mapEntry;
  });
  return repeated.length === 1 ? repeated[0] : undefined;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

main();
