# minim

Generator-driven animated SVG diagrams. Signals for state, generator-based
animators for choreography, a small shape kit for SVG primitives, and
custom-element scaffolding for dropping diagrams into HTML/Markdown.

## Install

```sh
npm install @minim/minim
```

Optional runtime peers (pulled in automatically when you use the matching
module): [`temml`](https://temml.org) for `tex`, [`prism-esm`](https://github.com/orionhealthotago/prism-esm)
for `code`.

## Sketch

```ts
import { signal, effect } from "@minim/minim";
import { Diagram, circle } from "@minim/minim";

class Demo extends Diagram {
  scene() {
    const r = signal(40);
    effect(() => console.log("r =", r.value));
    return circle({ r });
  }
}
Demo.define();
```

```html
<demo-diagram view="-100 -100 200 200"></demo-diagram>
```

## Status

`0.x` — APIs are still moving. The package is a single bundle today;
sub-packages (`@minim/signals`, `@minim/core`, `@minim/shapes`, …) will
land once the surface settles.

## License

ISC
