// The parts of google.protobuf.FileDescriptorSet the generator reads, in
// the JSON form `buf build --as-file-descriptor-set` writes, with the
// options' extensions under their bracketed names.

export interface FileDescriptorSet {
  file: FileDescriptor[];
}

export interface FileDescriptor {
  name: string;
  package?: string;
  dependency?: string[];
  messageType?: MessageDescriptor[];
  enumType?: EnumDescriptor[];
  service?: ServiceDescriptor[];
  sourceCodeInfo?: { location?: Location[] };
}

export interface Location {
  path?: number[];
  leadingComments?: string;
}

export interface MessageDescriptor {
  name: string;
  field?: FieldDescriptor[];
  nestedType?: MessageDescriptor[];
  enumType?: EnumDescriptor[];
  options?: {
    mapEntry?: boolean;
    "[google.api.resource]"?: { type?: string; pattern?: string[]; plural?: string; singular?: string };
  };
}

export type FieldType =
  | "TYPE_DOUBLE"
  | "TYPE_FLOAT"
  | "TYPE_INT64"
  | "TYPE_UINT64"
  | "TYPE_INT32"
  | "TYPE_FIXED64"
  | "TYPE_FIXED32"
  | "TYPE_BOOL"
  | "TYPE_STRING"
  | "TYPE_GROUP"
  | "TYPE_MESSAGE"
  | "TYPE_BYTES"
  | "TYPE_UINT32"
  | "TYPE_ENUM"
  | "TYPE_SFIXED32"
  | "TYPE_SFIXED64"
  | "TYPE_SINT32"
  | "TYPE_SINT64";

export interface FieldDescriptor {
  name: string;
  jsonName?: string;
  label?: "LABEL_OPTIONAL" | "LABEL_REQUIRED" | "LABEL_REPEATED";
  type: FieldType;
  typeName?: string;
}

export interface EnumDescriptor {
  name: string;
  value?: { name: string; number: number }[];
}

export interface ServiceDescriptor {
  name: string;
  method?: MethodDescriptor[];
  options?: { "[google.api.default_host]"?: string };
}

export interface HttpRule {
  get?: string;
  put?: string;
  post?: string;
  delete?: string;
  patch?: string;
  body?: string;
  additionalBindings?: HttpRule[];
}

export interface MethodDescriptor {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
  options?: {
    "[google.api.http]"?: HttpRule;
    "[google.longrunning.operation_info]"?: { responseType?: string; metadataType?: string };
    idempotencyLevel?: "IDEMPOTENCY_UNKNOWN" | "NO_SIDE_EFFECTS" | "IDEMPOTENT";
  };
}
