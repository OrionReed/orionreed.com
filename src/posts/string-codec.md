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

What I needed was a utility for _typed, debuggable, and compact string[^1] encodings_. Using `JSON.stringify` as a baseline, take the following string:

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
const codec = codec("QRTP&lt;index:num&gt;/&lt;total:num&gt;:&lt;ack:text&gt;");
```

The codec's `encode` and `decode` functions convert objects which match the schema to/from compact strings like "QRTP4/5:abc123".

To infer the types from the string took some work. Leading to this gnarly utility type.

```ts
type PatternType = 'text' | 'num' | 'bool' | 'list' | 'nums' | 'pairs' | 'numPairs' | 'enum';
type ExtractEnumValues&lt;T extends string&gt; = T extends `enum[${infer Values}]`
  ? Values extends string
    ? Values extends ''
      ? never
      : Values extends `${infer First},${infer Rest}`
        ? First | ExtractEnumValues&lt;`enum[${Rest}]`&gt;
        : Values
    : never
  : never;
type ParseType&lt;T extends string&gt; = T extends `${infer Base}-${string}`
  ? ParseType&lt;Base&gt;
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
              ? Array&lt;[string, string]&gt;
              : T extends 'numPairs'
                ? Array&lt;[number, number]&gt;
                : T extends `enum[${string}]`
                  ? ExtractEnumValues&lt;T&gt;
                  : string;
type ExtractFields&lt;T extends string&gt; = T extends `${string}&lt;${infer Field}:${infer Type}&gt;${infer Rest}`
  ? { [K in Field]: ParseType&lt;Type&gt; } &amp; ExtractFields&lt;Rest&gt;
  : T extends `${string}&lt;${infer Field}&gt;${infer Rest}`
    ? { [K in Field]: string } &amp; ExtractFields&lt;Rest&gt;
    : {};
type Expand&lt;T&gt; = T extends infer O ? { [K in keyof O]: O[K] } : never;

type CodecData&lt;T extends string&gt; = Expand&lt;
  ExtractFields&lt;T&gt; &amp; {
    payload?: string;
  }
&gt;;
```

And that's it, that's the whole post! Thank you for coming to my TED talk. The codec utility can be found [here](https://github.com/folk-js/folkjs/blob/main/packages/labs/src/utils/codecString.ts) though I wouldn't recommend it for anything too important at time of writing.
