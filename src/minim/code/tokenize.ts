// Prism wrapper — tokenize source into a flat list of `(type, text)`
// pairs that, when concatenated, reconstruct the input verbatim.
//
// Languages are lazy-loaded into a shared singleton Prism instance.
// Each token's `type` is Prism's classification ("keyword", "string",
// "function", …) or `""` for plain text / whitespace runs. Consumers
// render the tokens however they like — typically as `<span class="token
// $type">` spans inside a wrapper.

import {Prism} from "prism-esm";
import {loader as JsLoader} from "prism-esm/components/prism-javascript.js";
import {loader as TsLoader} from "prism-esm/components/prism-typescript.js";
import {loader as CssLoader} from "prism-esm/components/prism-css.js";

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

/** Flatten Prism's nested token tree into a linear sequence. Inner
 *  strings inherit their immediate parent's type so a nested string
 *  literal's quote characters are coloured the same as its body. */
function flatten(t: PrismToken | string, inheritedType = ""): Token[] {
  if (typeof t === "string") {
    return t === "" ? [] : [{type: inheritedType, text: t}];
  }
  const type = t.type ?? inheritedType;
  if (typeof t.content === "string") {
    return t.content === "" ? [] : [{type, text: t.content}];
  }
  return (t.content as (PrismToken | string)[]).flatMap((c) => flatten(c, type));
}

/** Tokenize `source` against `language`. Concatenating all `tok.text`
 *  recovers the original input. Unknown language → one untyped token
 *  spanning the whole source. */
export function tokenize(source: string, language = "typescript"): Token[] {
  const lang = prism.languages[language];
  if (!lang) return source === "" ? [] : [{type: "", text: source}];
  const raw = prism.tokenize(source, lang) as (PrismToken | string)[];
  return raw.flatMap((t) => flatten(t));
}
