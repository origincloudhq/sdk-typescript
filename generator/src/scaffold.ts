// Scaffolds the package of each service the API has but this repository
// doesn't yet, so that the regeneration bringing a new service is complete:
//
//   node generator/dist/scaffold.js <descriptors.json> <repository> <out>
//
// writes, under <out> at their paths in the repository, for each new
// service, packages/<service> as packages/location has it: package.json,
// tsconfig.json, README.md, LICENSE and a test of its client
// (test/client.test.ts). It also writes the root package.json, tsconfig.json,
// tsconfig.test.json and README.md with the package added. It writes nothing
// when every service has its package. scripts/generate.sh copies them and
// installs the packages, which adds them to package-lock.json.
//
// What a service serves, in its package's description and READMEs, is the
// first of these that its definitions have:
//
// 1. the first sentence of its package's comment, the leading comment of a
//    file's `package` statement;
// 2. the first sentence of its service's comment, when it has one service;
// 3. the resources it serves, but those within another of its resources (a
//    rule within its ACL): "instances, images and key pairs", spelled as its
//    comments spell them ("VPCs", "DNS policies").
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FileDescriptor, FileDescriptorSet, MethodDescriptor } from "./descriptors.js";

/** Packages every service shares, which have no package of their own. */
const SHARED_PACKAGES = ["origincloud.longrunning."];

// Descriptor paths (google.protobuf.SourceCodeInfo.Location.path).
const FILE_PACKAGE = 2;
const FILE_SERVICE = 6;

/** A service, as its package describes it. */
export interface Description {
  /** The service, as its packages name it: `compute`. */
  service: string;
  /** Its name in prose: the service's, in capitals when it is three letters at most (IAM). */
  name: string;
  /** What it serves, a phrase starting in lowercase; empty when the definitions say nothing. */
  what: string;
  /** Its versions: `v1beta1`. */
  versions: string[];
}

/** The description of `service`, from the files of its packages, `origincloud.{service}.{version}`. */
export function describe(set: FileDescriptorSet, service: string): Description {
  const prefix = `origincloud.${service}.`;
  const files = set.file.filter((f) => f.package?.startsWith(prefix));
  const versions = [...new Set(files.map((f) => f.package!.slice(prefix.length)))].sort();
  const services = files.flatMap((f) => (f.service ?? []).map((s, i) => ({ file: f, index: i, service: s })));

  let what = "";
  for (const f of files) {
    const comment = leading(f, [FILE_PACKAGE]);
    if (comment) {
      what = firstSentence(comment);
      break;
    }
  }
  if (!what && services.length === 1) {
    const only = services[0]!;
    what = firstSentence(leading(only.file, [FILE_SERVICE, only.index]) ?? "");
  }
  what = what ? lowerFirst(what) : resources(files);
  return { service, name: service.length <= 3 ? service.toUpperCase() : service, what, versions };
}

/** The package's description: "Origin Cloud's compute service: instances, images and key pairs." */
export function summary(d: Description): string {
  return d.what ? `Origin Cloud's ${d.name} service: ${d.what}.` : `Origin Cloud's ${d.name} service.`;
}

/** The resources the files serve, but those within another of them, as a phrase: "instances, images and key pairs". */
function resources(files: FileDescriptor[]): string {
  const found: { pattern: string; plural: string }[] = [];
  for (const f of files) {
    for (const m of f.messageType ?? []) {
      const resource = m.options?.["[google.api.resource]"];
      const pattern = resource?.pattern?.[0];
      if (!pattern) continue;
      found.push({ pattern, plural: resource.plural || lowerFirst(`${m.name}s`) });
    }
  }
  const comments = commentsText(files);
  const words: string[] = [];
  for (const { pattern, plural } of found) {
    const parent = parentPattern(pattern);
    if (found.some((other) => other.pattern === parent)) continue;
    const phrase = spelled(comments, humanize(plural));
    if (!words.includes(phrase)) words.push(phrase);
  }
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The pattern of a resource's parent: `projects/{project}` of `projects/{project}/keyPairs/{key_pair}`, and of a singleton's `projects/{project}/quota`. */
export function parentPattern(pattern: string): string {
  const segments = pattern.split("/");
  const own = segments[segments.length - 1]!.startsWith("{") ? 2 : 1;
  return segments.slice(0, Math.max(0, segments.length - own)).join("/");
}

/** A resource's plural as words: `keyPairs` is "key pairs". */
export function humanize(plural: string): string {
  return plural.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`).trim();
}

/**
 * words as the comments spell them, such as "ACLs" for "acls" and "DNS
 * policies" for "dns policies", but for a capital that only starts a
 * sentence: "Floating IPs" is "floating IPs". The first spelling with a
 * capital left counts; words the comments have only in lowercase, or not at
 * all, stay as they are.
 */
function spelled(comments: string, words: string): string {
  const escaped = words.split(" ").map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(`\\b${escaped.join("\\s+")}\\b`, "gi");
  for (const match of comments.matchAll(re)) {
    const spelling = match[0].split(/\s+/).map(lowerFirst).join(" ");
    if (/[A-Z]/.test(spelling)) return spelling;
  }
  return words;
}

/** Every leading comment of the files, as prose: without linter directives, and without what is in backticks, such as resource names and enum values. */
function commentsText(files: FileDescriptor[]): string {
  return files
    .flatMap((f) => (f.sourceCodeInfo?.location ?? []).map((l) => l.leadingComments ?? ""))
    .map((c) => c.replace(/\(--[\s\S]*?--\)/g, "").replace(/`[^`]*`/g, ""))
    .join("\n");
}

/** The leading comment at path in file, if it has one. */
function leading(file: FileDescriptor, path: number[]): string | undefined {
  const key = path.join(",");
  const comment = file.sourceCodeInfo?.location?.find((l) => (l.path ?? []).join(",") === key)?.leadingComments;
  return comment?.trim() ? comment : undefined;
}

/** The first sentence of a comment's first paragraph, as plain text on one line, without its full stop. */
export function firstSentence(comment: string): string {
  const text = comment.replace(/\(--[\s\S]*?--\)/g, "").replace(/`/g, "");
  const paragraph = text.split(/\n\s*\n/).find((p) => p.trim()) ?? "";
  const line = paragraph.split(/\s+/).filter(Boolean).join(" ");
  const end = line.indexOf(". ");
  return (end >= 0 ? line.slice(0, end) : line).replace(/\.+$/, "").trim();
}

/** text with a lowercase first letter, unless the word it starts is an abbreviation: "The" is "the", but "VPCs" stays. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** text wrapped at 80 columns. */
function wrap(text: string): string {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > 80) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join("\n");
}

/** The services of the API without a package in the repository, sorted. */
export function newServices(set: FileDescriptorSet, repository: string): string[] {
  const services = new Set<string>();
  for (const f of set.file) {
    const match = /^origincloud\.([a-z0-9_]+)\./.exec(f.package ?? "");
    if (match?.[1] && !SHARED_PACKAGES.some((p) => f.package?.startsWith(p))) services.add(match[1]);
  }
  return [...services].filter((s) => !existsSync(join(repository, "packages", s, "package.json"))).sort();
}

/** The files adding the packages of `services` to the repository, by their path in it. */
export function scaffold(set: FileDescriptorSet, repository: string, services: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (services.length === 0) return out;
  const read = (path: string) => readFileSync(join(repository, path), "utf8");
  const version = (JSON.parse(read("packages/core/package.json")) as { version: string }).version;
  const license = read("LICENSE");
  const tsconfig = read("packages/location/tsconfig.json");

  let rootPackage = read("package.json");
  let references = read("tsconfig.json");
  let testReferences = read("tsconfig.test.json");
  const rows: string[] = [];
  for (const service of services) {
    const d = describe(set, service);
    const files = set.file.filter((f) => f.package?.startsWith(`origincloud.${service}.`));
    const longrunning = files.some((f) => (f.dependency ?? []).some((dep) => dep.startsWith("origincloud/longrunning/")));
    const client = exampleClient(files);
    const dir = `packages/${service}`;

    out.set(`${dir}/package.json`, packageJson(d, version));
    out.set(`${dir}/tsconfig.json`, tsconfig);
    out.set(`${dir}/LICENSE`, license);
    out.set(`${dir}/README.md`, readme(d, longrunning, client));
    out.set(`${dir}/test/client.test.ts`, clientTest(d, client));

    rootPackage = withWorkspace(rootPackage, dir);
    references = withReference(references, dir);
    testReferences = withReference(testReferences, dir);
    for (const v of d.versions) {
      rows.push(`| \`@origincloud/${service}\` | \`@origincloud/${service}/${v}\` | ${d.what ? upperFirst(d.what) : `The ${d.name} service`} |`);
      if (longrunning) {
        rows.push(`| | \`@origincloud/${service}/longrunning/${v}\` | ${operations(d)} |`);
      }
    }
  }
  out.set("package.json", rootPackage);
  out.set("tsconfig.json", references);
  out.set("tsconfig.test.json", testReferences);
  out.set("README.md", withRows(read("README.md"), "| Package | Import | API |", rows));
  return out;
}

function operations(d: Description): string {
  return `${d.name.length <= 3 ? d.name : upperFirst(d.name)} operations, for resuming one by name`;
}

function packageJson(d: Description, version: string): string {
  const pkg = {
    name: `@origincloud/${d.service}`,
    version,
    description: summary(d),
    license: "Apache-2.0",
    homepage: "https://github.com/origincloudhq/sdk-typescript#readme",
    repository: {
      type: "git",
      url: "git+https://github.com/origincloudhq/sdk-typescript.git",
      directory: `packages/${d.service}`,
    },
    bugs: "https://github.com/origincloudhq/sdk-typescript/issues",
    keywords: ["origincloud", "origin-cloud", "sdk", d.service],
    type: "module",
    sideEffects: false,
    engines: { node: ">=20" },
    exports: {
      "./*": { types: "./dist/*/index.d.ts", default: "./dist/*/index.js" },
      "./package.json": "./package.json",
    },
    files: ["dist", "src", "!dist/**/*.tsbuildinfo"],
    peerDependencies: { "@origincloud/core": `^${version}` },
    devDependencies: { "@origincloud/core": `^${version}` },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** A client of the service a README and a test show, and a method of it that gets a resource by name. */
interface ExampleClient {
  version: string;
  /** The client's class: `KeyPairClient`. */
  name: string;
  /** Its host: `compute.origincloudapis.eu`. */
  host: string;
  /** A method answering GET with only `name` in its path, and the path's template: `/v1beta1/{name=projects/*}`. */
  get?: { method: string; template: string };
}

/** The first service with a host, preferring one that gets a resource by its name. */
function exampleClient(files: FileDescriptor[]): ExampleClient | undefined {
  let first: ExampleClient | undefined;
  for (const f of files) {
    for (const s of f.service ?? []) {
      const host = s.options?.["[google.api.default_host]"];
      if (!host) continue;
      const client: ExampleClient = {
        version: f.package!.split(".").pop()!,
        name: s.name.replace(/Service$/, "") + "Client",
        host,
      };
      const get = (s.method ?? []).find(getsByName);
      if (get) return { ...client, get: { method: lowerFirst(get.name), template: get.options!["[google.api.http]"]!.get! } };
      first ??= client;
    }
  }
  return first;
}

function getsByName(m: MethodDescriptor): boolean {
  const template = m.options?.["[google.api.http]"]?.get;
  return !!template && /^\/[^{}]*\{name=[^{}]+\}$/.test(template);
}

/** A name a template matches, its wildcards filled in: `projects/x/keyPairs/x`. */
function exampleName(template: string): string {
  const pattern = /\{name=([^}]+)\}/.exec(template)![1]!;
  return pattern.replace(/\*\*?/g, "x");
}

function readme(d: Description, longrunning: boolean, client: ExampleClient | undefined): string {
  const lines = [
    `# @origincloud/${d.service}`,
    "",
    wrap(
      `The client of Origin Cloud's ${d.name} service${d.what ? `: ${d.what}` : ""}. Part of the ` +
        "[Origin Cloud SDK for TypeScript](https://github.com/origincloudhq/sdk-typescript), " +
        "generated from the API definitions in [origincloudhq/api](https://github.com/origincloudhq/api).",
    ),
    "",
  ];
  if (client) {
    const resource = lowerFirst(client.name.replace(/Client$/, ""));
    const variable = resource.endsWith("s") ? resource : `${resource}s`;
    lines.push(
      "```ts",
      'import { Client } from "@origincloud/core";',
      `import { ${client.name} } from "@origincloud/${d.service}/${client.version}";`,
      "",
      `const ${variable} = new ${client.name}(new Client());`,
      "```",
      "",
    );
  }
  lines.push("| Import | API |", "|---|---|");
  for (const v of d.versions) {
    lines.push(`| \`@origincloud/${d.service}/${v}\` | ${d.what ? upperFirst(d.what) : `The ${d.name} service`} |`);
    if (longrunning) lines.push(`| \`@origincloud/${d.service}/longrunning/${v}\` | ${operations(d)} |`);
  }
  lines.push("");
  const previews = d.versions.filter((v) => /alpha|beta/.test(v));
  if (previews.length > 0) {
    const list = previews.map((v) => `\`${v}\``).join(" and ");
    lines.push(
      wrap(
        `${list} ${previews.length === 1 ? "is a preview version" : "are preview versions"} and may change in incompatible ways, like the ` +
          "API itself. See the [repository's README](https://github.com/origincloudhq/sdk-typescript#readme) " +
          "for credentials and behaviour.",
      ),
    );
  } else {
    lines.push(
      wrap(
        "See the [repository's README](https://github.com/origincloudhq/sdk-typescript#readme) for credentials and behaviour.",
      ),
    );
  }
  lines.push("", "Apache License 2.0.", "");
  return lines.join("\n");
}

function clientTest(d: Description, client: ExampleClient | undefined): string {
  const head = ['import assert from "node:assert/strict";', 'import { test } from "node:test";', ""];
  if (!client) {
    return [...head, 'test("the package has no client", () => {', "  assert.ok(true);", "});", ""].join("\n");
  }
  const imports = [
    'import { Client, accessToken } from "@origincloud/core";',
    `import { ${client.name} } from "@origincloud/${d.service}/${client.version}";`,
    "",
  ];
  if (!client.get) {
    return [
      ...head,
      ...imports,
      `test("a ${client.name} sends its calls to ${client.host}", () => {`,
      `  const client = new ${client.name}(new Client({ credentials: accessToken("t") }));`,
      `  assert.equal(client.service.base, "https://${client.host}");`,
      "});",
      "",
    ].join("\n");
  }
  const name = exampleName(client.get.template);
  const path = client.get.template.replace(/\{name=[^}]+\}/, name);
  return [
    ...head,
    ...imports,
    `test("${client.get.method} gets a resource by its name from ${client.host}", async () => {`,
    "  const urls: string[] = [];",
    "  const client = new Client({",
    '    credentials: accessToken("t"),',
    "    fetch: async (url) => {",
    "      urls.push(String(url));",
    '      return new Response(JSON.stringify({ name: "' + name + '" }), {',
    '        headers: { "content-type": "application/json" },',
    "      });",
    "    },",
    "  });",
    "",
    `  const got = await new ${client.name}(client).${client.get.method}({ name: "${name}" });`,
    `  assert.deepEqual(urls, ["https://${client.host}${path}"]);`,
    `  assert.equal(got.name, "${name}");`,
    "});",
    "",
  ].join("\n");
}

/** The root package.json with `dir` among its workspaces, after the others. */
export function withWorkspace(text: string, dir: string): string {
  const pkg = JSON.parse(text) as { workspaces?: string[] };
  if (!pkg.workspaces) throw new Error("package.json has no workspaces to add the new package to");
  if (!pkg.workspaces.includes(dir)) pkg.workspaces.push(dir);
  return JSON.stringify(pkg, null, 2) + "\n";
}

/** A tsconfig with `dir` among its references, after the last package's. */
export function withReference(text: string, dir: string): string {
  const lines = text.split("\n");
  const reference = /^(\s*)\{ "path": "packages\/[^"]+" \}(,?)$/;
  let last = -1;
  lines.forEach((line, i) => {
    if (reference.test(line)) last = i;
  });
  if (last < 0) throw new Error(`no reference to a package to add ${dir} after`);
  if (lines.some((line) => line.includes(`"path": "${dir}"`))) return text;
  const [, indent, comma] = reference.exec(lines[last]!)!;
  if (!comma) lines[last] += ",";
  lines.splice(last + 1, 0, `${indent}{ "path": "${dir}" }${comma}`);
  return lines.join("\n");
}

/** README.md with `rows` at the end of the table headed `header`; a row it has is left out. */
export function withRows(text: string, header: string, rows: string[]): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === header);
  if (start < 0) throw new Error(`README.md has no table headed ${header} to add the new package to`);
  let end = start;
  while (end < lines.length && lines[end]!.startsWith("|")) end++;
  const added = rows.filter((r) => !lines.slice(start, end).includes(r));
  lines.splice(end, 0, ...added);
  return lines.join("\n");
}

function main(): void {
  const [input, repository, out] = process.argv.slice(2);
  if (!input || !repository || !out) {
    console.error("usage: scaffold.js <descriptors.json> <repository> <out>");
    process.exit(2);
  }
  const set = JSON.parse(readFileSync(input, "utf8")) as FileDescriptorSet;
  const services = newServices(set, repository);
  for (const [path, content] of scaffold(set, repository, services)) {
    const target = join(out, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  for (const service of services) {
    console.error(`notice: ${service} is a new service: packages/${service} was scaffolded as "${summary(describe(set, service))}"`);
  }
}

// Run as a script, not when a test imports it.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

