// Lazy tree-sitter loader. web-tree-sitter (WASM runtime) + the prebuilt
// grammars from tree-sitter-wasms: no native builds, one grammar loaded per
// language on first use, one parser per language reused after that.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import Parser from 'web-tree-sitter';
import { TAG_QUERIES, type LanguageId } from './languages.js';
import { traced } from '../util/trace.js';

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const languages = new Map<LanguageId, Promise<LoadedLanguage>>();

export interface LoadedLanguage {
  id: LanguageId;
  language: Parser.Language;
  parser: Parser;
  query: Parser.Query;
}

function wasmDir(): string {
  const pkg = require.resolve('tree-sitter-wasms/package.json');
  return join(dirname(pkg), 'out');
}

async function init(): Promise<void> {
  if (!initPromise) initPromise = traced('tree-sitter.init', () => Parser.init());
  await initPromise;
}

/** True when the grammar for `id` ships in tree-sitter-wasms. */
export function hasGrammar(id: LanguageId): boolean {
  try {
    return existsSync(join(wasmDir(), `tree-sitter-${id}.wasm`));
  } catch {
    return false;
  }
}

export function loadLanguage(id: LanguageId): Promise<LoadedLanguage> {
  let p = languages.get(id);
  if (!p) {
    p = (async () => {
      await init();
      const language = await traced(`tree-sitter.load ${id}`, () => Parser.Language.load(join(wasmDir(), `tree-sitter-${id}.wasm`)));
      const parser = new Parser();
      parser.setLanguage(language);
      const query = language.query(TAG_QUERIES[id]);
      return { id, language, parser, query };
    })();
    languages.set(id, p);
  }
  return p;
}

/** Parse a file; the tree must be `delete()`d by the caller when done. */
export async function parse(id: LanguageId, text: string): Promise<{ loaded: LoadedLanguage; tree: Parser.Tree }> {
  const loaded = await loadLanguage(id);
  // A parser holds state across parses; one parser per language is enough
  // because extraction is sequential per language.
  const tree = loaded.parser.parse(text);
  return { loaded, tree };
}
