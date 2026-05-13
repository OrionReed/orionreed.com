---
title: String Codecs
description: A tiny utility for typed, debuggable, and compact string encodings.
date: 2025-07-12
---

While working on the ["QR Transfer Protocol"](/posts/qrtp/) I was running into frequent bugs and annoyances developing compact representations for the QR code data payload.

<md-codec width='20rem'>
'QRTP': a
chunk index: a
chunks total: a
'ack' hash: a
chunk data: 8
</md-codec>

What I needed was a utility for _typed, debuggable, and compact string[^1] encodings_.

Using `JSON.stringify` as a baseline, take the following string:

[^1]: I wanted a string which I could feasibly debug just by looking at it with my eyes, which ruled out options like [Protobuf](https://en.wikipedia.org/wiki/Protocol_Buffers).

```
{"foobar":true,"zabzob":false,"hash":"abc123","value":1.56}
```

Compare this to a hand-crafted encoding which takes advantage of the known schema, where redundant keys, symbols, and delimiters are removed:

```
10abc123|1.56
```

Writing these optimized encodings by hand can be a pain when the layout keeps changing, so I wrote a small `codec.ts` utility with a tiny DSL which infers types and compacts the data as much as possible, removing redundant delimiters, creating smaller alphabets for enums and so on…

```ts
const codec = codec("QRTP<index:num>/<total:num>:<ack:text>");
```

The codec's `encode` and `decode` functions convert objects which match the schema to/from compact strings like "QRTP4/5:abc123".

To infer the types from the string took some work. Leading to this gnarly utility type.

```ts
type PatternType = 'text' | 'num' | 'bool' | 'list' | 'nums' | 'pairs' | 'numPairs' | 'enum';
type ExtractEnumValues<T extends string> = T extends `enum[${infer Values}]`
  ? Values extends string
    ? Values extends ''
      ? never
      : Values extends `${infer First},${infer Rest}`
        ? First | ExtractEnumValues<`enum[${Rest}]`>
        : Values
    : never
  : never;
type ParseType<T extends string> = T extends `${infer Base}-${string}`
  ? ParseType<Base>
  : T extends 'text'
    ? string
    : T extends 'num'
      ? number
      : T extends 'bool'
        ? boolean
        : T extends 'list'
          ? string[]
          : T extends 'nums'
            ? number[]
            : T extends 'pairs'
              ? Array<[string, string]>
              : T extends 'numPairs'
                ? Array<[number, number]>
                : T extends `enum[${string}]`
                  ? ExtractEnumValues<T>
                  : string;
type ExtractFields<T extends string> = T extends `${string}<${infer Field}:${infer Type}>${infer Rest}`
  ? { [K in Field]: ParseType<Type> } & ExtractFields<Rest>
  : T extends `${string}<${infer Field}>${infer Rest}`
    ? { [K in Field]: string } & ExtractFields<Rest>
    : {};
type Expand<T> = T extends infer O ? { [K in keyof O]: O[K] } : never;

type CodecData<T extends string> = Expand<
  ExtractFields<T> & {
    payload?: string;
  }
>;
```

And that's it, that's the whole post! Thank you for coming to my TED talk. The codec utility can be found [here](https://github.com/folk-js/folkjs/blob/main/packages/labs/src/utils/codecString.ts) though I wouldn't recommend it for anything too important at time of writing.
