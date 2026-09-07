// Language registry for the code index: which grammar parses which extension,
// and the tag query each grammar answers. The queries follow the shape of the
// upstream tree-sitter `tags.scm` files: `@definition.<kind>` on the whole
// declaration with `@name.definition.<kind>` on its identifier, and
// `@name.reference.<kind>` on calls, constructions, inheritance and imports.
// Grammars are the prebuilt WASM files in `tree-sitter-wasms` (Unlicense),
// loaded lazily by parser.ts.

export type LanguageId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'c_sharp'
  | 'c'
  | 'cpp'
  | 'ruby'
  | 'php';

/** Extension → grammar. Everything else is either a text file or skipped. */
export const EXT_TO_LANGUAGE: Record<string, LanguageId> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.rb': 'ruby',
  '.php': 'php',
};

/** Non-code files worth a node of their own (docs, config, tests live here too). */
export const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.csv', '.xml', '.xaml', '.html', '.css', '.scss', '.sql', '.graphql', '.proto']);

export function languageForPath(path: string): LanguageId | null {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_LANGUAGE[path.slice(dot).toLowerCase()] ?? null;
}

export function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && TEXT_EXT.has(path.slice(dot).toLowerCase());
}

const TS_COMMON = `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(method_definition name: (property_identifier) @name.definition.method) @definition.method
(lexical_declaration (variable_declarator name: (identifier) @name.definition.function value: (arrow_function))) @definition.function
(lexical_declaration (variable_declarator name: (identifier) @name.definition.function value: (function_expression))) @definition.function
(call_expression function: (identifier) @name.reference.call) @reference.call
(call_expression function: (member_expression property: (property_identifier) @name.reference.call)) @reference.call
(new_expression constructor: (identifier) @name.reference.class) @reference.class
(import_statement source: (string (string_fragment) @name.reference.import)) @reference.import
(export_statement source: (string (string_fragment) @name.reference.import)) @reference.import
`;

export const TAG_QUERIES: Record<LanguageId, string> = {
  typescript: `${TS_COMMON}
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(abstract_class_declaration name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration name: (type_identifier) @name.definition.type) @definition.type
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(extends_clause value: (identifier) @name.reference.inherit)
(implements_clause (type_identifier) @name.reference.inherit)
`,
  tsx: `${TS_COMMON}
(class_declaration name: (type_identifier) @name.definition.class) @definition.class
(abstract_class_declaration name: (type_identifier) @name.definition.class) @definition.class
(interface_declaration name: (type_identifier) @name.definition.interface) @definition.interface
(type_alias_declaration name: (type_identifier) @name.definition.type) @definition.type
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(extends_clause value: (identifier) @name.reference.inherit)
(implements_clause (type_identifier) @name.reference.inherit)
`,
  javascript: `${TS_COMMON}
(class_declaration name: (identifier) @name.definition.class) @definition.class
(class_heritage (identifier) @name.reference.inherit)
`,
  python: `
(function_definition name: (identifier) @name.definition.function) @definition.function
(class_definition name: (identifier) @name.definition.class) @definition.class
(call function: (identifier) @name.reference.call) @reference.call
(call function: (attribute attribute: (identifier) @name.reference.call)) @reference.call
(import_statement name: (dotted_name) @name.reference.import)
(import_from_statement module_name: (dotted_name) @name.reference.import)
(class_definition superclasses: (argument_list (identifier) @name.reference.inherit))
`,
  go: `
(function_declaration name: (identifier) @name.definition.function) @definition.function
(method_declaration name: (field_identifier) @name.definition.method) @definition.method
(type_declaration (type_spec name: (type_identifier) @name.definition.type)) @definition.type
(call_expression function: (identifier) @name.reference.call) @reference.call
(call_expression function: (selector_expression field: (field_identifier) @name.reference.call)) @reference.call
(import_spec path: (interpreted_string_literal) @name.reference.import)
`,
  rust: `
(function_item name: (identifier) @name.definition.function) @definition.function
(function_signature_item name: (identifier) @name.definition.function) @definition.function
(struct_item name: (type_identifier) @name.definition.class) @definition.class
(enum_item name: (type_identifier) @name.definition.class) @definition.class
(trait_item name: (type_identifier) @name.definition.interface) @definition.interface
(impl_item type: (type_identifier) @name.definition.implementation) @definition.implementation
(mod_item name: (identifier) @name.definition.module) @definition.module
(call_expression function: (identifier) @name.reference.call) @reference.call
(call_expression function: (scoped_identifier name: (identifier) @name.reference.call)) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name.reference.call)) @reference.call
(use_declaration argument: (_) @name.reference.import)
`,
  java: `
(class_declaration name: (identifier) @name.definition.class) @definition.class
(interface_declaration name: (identifier) @name.definition.interface) @definition.interface
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(record_declaration name: (identifier) @name.definition.class) @definition.class
(method_declaration name: (identifier) @name.definition.method) @definition.method
(constructor_declaration name: (identifier) @name.definition.method) @definition.method
(method_invocation name: (identifier) @name.reference.call) @reference.call
(object_creation_expression type: (type_identifier) @name.reference.class)
(import_declaration (scoped_identifier) @name.reference.import)
(superclass (type_identifier) @name.reference.inherit)
(super_interfaces (type_list (type_identifier) @name.reference.inherit))
`,
  c_sharp: `
(class_declaration name: (identifier) @name.definition.class) @definition.class
(interface_declaration name: (identifier) @name.definition.interface) @definition.interface
(struct_declaration name: (identifier) @name.definition.class) @definition.class
(record_declaration name: (identifier) @name.definition.class) @definition.class
(enum_declaration name: (identifier) @name.definition.enum) @definition.enum
(method_declaration name: (identifier) @name.definition.method) @definition.method
(constructor_declaration name: (identifier) @name.definition.method) @definition.method
(property_declaration name: (identifier) @name.definition.property) @definition.property
(namespace_declaration name: (_) @name.definition.module) @definition.module
(file_scoped_namespace_declaration name: (_) @name.definition.module)
(invocation_expression function: (identifier) @name.reference.call) @reference.call
(invocation_expression function: (member_access_expression name: (identifier) @name.reference.call)) @reference.call
(object_creation_expression type: (identifier) @name.reference.class)
(using_directive (_) @name.reference.import)
(base_list (identifier) @name.reference.inherit)
`,
  c: `
(function_definition declarator: (function_declarator declarator: (identifier) @name.definition.function)) @definition.function
(struct_specifier name: (type_identifier) @name.definition.class) @definition.class
(enum_specifier name: (type_identifier) @name.definition.enum) @definition.enum
(type_definition declarator: (type_identifier) @name.definition.type) @definition.type
(call_expression function: (identifier) @name.reference.call) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name.reference.call)) @reference.call
(preproc_include path: (_) @name.reference.import)
`,
  cpp: `
(function_definition declarator: (function_declarator declarator: (identifier) @name.definition.function)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (identifier) @name.definition.method))) @definition.method
(function_definition declarator: (function_declarator declarator: (field_identifier) @name.definition.method)) @definition.method
(struct_specifier name: (type_identifier) @name.definition.class) @definition.class
(class_specifier name: (type_identifier) @name.definition.class) @definition.class
(enum_specifier name: (type_identifier) @name.definition.enum) @definition.enum
(namespace_definition name: (namespace_identifier) @name.definition.module) @definition.module
(call_expression function: (identifier) @name.reference.call) @reference.call
(call_expression function: (qualified_identifier name: (identifier) @name.reference.call)) @reference.call
(call_expression function: (field_expression field: (field_identifier) @name.reference.call)) @reference.call
(preproc_include path: (_) @name.reference.import)
`,
  ruby: `
(method name: (identifier) @name.definition.method) @definition.method
(singleton_method name: (identifier) @name.definition.method) @definition.method
(class name: (constant) @name.definition.class) @definition.class
(module name: (constant) @name.definition.module) @definition.module
(call method: (identifier) @name.reference.call) @reference.call
(superclass (constant) @name.reference.inherit)
`,
  php: `
(function_definition name: (name) @name.definition.function) @definition.function
(method_declaration name: (name) @name.definition.method) @definition.method
(class_declaration name: (name) @name.definition.class) @definition.class
(interface_declaration name: (name) @name.definition.interface) @definition.interface
(trait_declaration name: (name) @name.definition.class) @definition.class
(function_call_expression function: (name) @name.reference.call) @reference.call
(member_call_expression name: (name) @name.reference.call) @reference.call
(object_creation_expression (name) @name.reference.class)
(base_clause (name) @name.reference.inherit)
`,
};
