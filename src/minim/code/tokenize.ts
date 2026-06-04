// Prism wrapper — tokenize source into a flat `(type, text)` list that
// concatenates back to the input verbatim. `type` is Prism's
// classification or `""` for plain text. Languages lazy-load into a
// shared singleton Prism instance.

import { Prism } from "prism-esm";
import { loader as CssLoader } from "prism-esm/components/prism-css.js";
import { loader as JsLoader } from "prism-esm/components/prism-javascript.js";
import { loader as TsLoader } from "prism-esm/components/prism-typescript.js";

const prism = new Prism();
JsLoader(prism);
TsLoader(prism);
CssLoader(prism);

export interface Token {
  /** Prism token type ("keyword", "string", …). `""` for plain text. */
  type: string;
  text: string;
}

interface PrismToken {
  type?: string;
  content: string | PrismToken[] | (PrismToken | string)[];
  length: number;
}

/** Flatten Prism's token tree; inner strings inherit the parent's type
 *  so a nested literal's quotes colour like its body. */
function flatten(t: PrismToken | string, inheritedType = ""): Token[] {
  if (typeof t === "string") {
    return t === "" ? [] : [{ type: inheritedType, text: t }];
  }
  const type = t.type ?? inheritedType;
  if (typeof t.content === "string") {
    return t.content === "" ? [] : [{ type, text: t.content }];
  }
  return (t.content as (PrismToken | string)[]).flatMap(c => flatten(c, type));
}

/** Split untyped runs on word/whitespace boundaries. Prism glues
 *  whitespace onto untyped identifiers, which would trap newlines inside
 *  a rename's diff span; splitting lets the diff align them correctly. */
function splitUntyped(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

/** Tokenize `source`; concatenating `tok.text` recovers the input.
 *  Unknown language → one untyped token over the whole source. */
export function tokenize(source: string, language = "typescript"): Token[] {
  const lang = prism.languages[language];
  if (!lang) return source === "" ? [] : [{ type: "", text: source }];
  const raw = prism.tokenize(source, lang) as (PrismToken | string)[];
  const flat = raw.flatMap(t => flatten(t));
  // Split untyped tokens on whitespace boundaries; typed tokens stay intact.
  const out: Token[] = [];
  for (const tok of flat) {
    if (tok.type !== "") {
      out.push(tok);
      continue;
    }
    for (const piece of splitUntyped(tok.text)) {
      out.push({ type: "", text: piece });
    }
  }
  return out;
}
