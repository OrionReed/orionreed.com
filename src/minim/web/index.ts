// Web — DOM scaffold for embedding minim diagrams as custom elements.
//
//   diagram    `Diagram` base class — SVG host, viewBox, Anim lifecycle,
//              attribute reactivity, the `scene(s: Mount)` authoring hook
//   attr       `@attr.{str,num,bool}` decorators — observed HTML attrs
//              mapped to reactive cells on the host element
//   viewport   shared `viewport()` signal — one lazy resize listener
//   md-tex     <md-tex> custom element — inline math via Temml, with
//              optional prose-linking via the marker registry
//   md-marker  <md-marker> custom element — non-math prose linker

export { Diagram, attachRaf, css, type Padding } from "./diagram";
export { attr, observedAttributesOf, syncAttrSignal } from "./attr";
export { viewport } from "./viewport";
export { MdTex } from "./md-tex";
export { MdMarker } from "./md-marker";
