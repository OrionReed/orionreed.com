---
title: How To Center a Div
---

> Many have tried, many have failed, to center a \<div\> on the web.<br/><br/>
> Some say it is impossible.<br/><br/>
> Little do they know I have been training for months, consumed a dozen academic papers spanning 100 years, and collected an arsenal of mathematical tools to finally align one shape inside another.

<span class="dinkus">\*\*\*</span>

When we talk of centering a shape as programmers, we might think of how to express "center" in a language like CSS:

```css
display: flex;
justify-content: center;
align-items: center;
```

or an equation which computes the coordinates needed to position a shape at a center point.

$$(x_{center}, y_{center}) = \left(\frac{W_{container} - W_{element}}{2}, \frac{H_{container} - H_{element}}{2}\right)$$
This is the essence of "centered" in almost every programming language and user interface library. This black box is perfectly centered in another box.

<svg xmlns="http://www.w3.org/2000/svg" direction="ltr" width="296" height="196" viewBox="423.1015080213547 275.1101046204567 296 196" stroke-linecap="round" stroke-linejoin="round" data-color-mode="light" class="tl-container tl-theme__force-sRGB tl-theme__light" style="background-color: rgb(249, 250, 251);"><defs/><g transform="matrix(1, 0, 0, 1, 455.1015, 307.1101)" opacity="1"><path stroke-width="3.5" d="M 0 0 L 232 0 L 232 132 L 0 132 Z" fill="none" stroke="#1d1d1d"/></g><g transform="matrix(1, 0, 0, 1, 546.1015, 348.6101)" opacity="1"><path fill="#1d1d1d" d="M 0 0 L 50 0 L 50 49 L 0 49 Z"/><path stroke-width="3.5" d="M 0 0 L 50 0 L 50 49 L 0 49 Z" fill="none" stroke="#1d1d1d"/></g></svg>

but if you've ever tried to center other shapes, you will have quickly discovered some major shortcomings.

<svg xmlns="http://www.w3.org/2000/svg" direction="ltr" width="383.12867844463267" height="275.0254066653001" viewBox="830.5357978672616 393.5502435212187 383.12867844463267 275.0254066653001" stroke-linecap="round" stroke-linejoin="round" data-color-mode="light" class="tl-container tl-theme__force-sRGB tl-theme__light" style="background-color: rgb(249, 250, 251);"><defs/><g transform="matrix(0, -1, 1, 0, 862.5358, 636.5757)" opacity="1"><path fill="#fcfffe" d="M 105.5127 0 L 211.0254 319.1287 L 0 319.1287 Z"/><path stroke-width="3.5" d="M 105.5127 0 L 211.0254 319.1287 L 0 319.1287 Z" fill="none" stroke="#1d1d1d"/></g><g transform="matrix(1, 0, 0, 1, 1001.245, 512.0317)" opacity="1"><path fill="#1d1d1d" d="M 0 0 L 41.7103 0 L 41.7103 38.0625 L 0 38.0625 Z"/><path stroke-width="3.5" d="M 0 0 L 41.7103 0 L 41.7103 38.0625 L 0 38.0625 Z" fill="none" stroke="#1d1d1d"/></g></svg>

(this square is also perfectly centered acorrding to our CSS rule and equation above)

The problem with our approach is that we have failed to capture the essence of "center" in our abstraction. What we have captured is a notion of center for _axis-aligned boxes_. This is the same center you can calculate as the middle of two points on a number line.

Designers and artists have known for thousands of years that the _perceptual center_ of a shape is not simply derived from its width and height. There are in fact many [optical effects in user interfaces](https://medium.com/design-bridges/optical-effects-9fca82b4cd9a) which are not captured in our programming languages or libraries and which are left to designers to account for.

This is a large part of the value of _icon libraries_ which have been painstakingly designed to feel balanced and consistent in alignment, size, and other attributes.

But this state of affairs has its own problems:

1. tweaks from designers may be hard to represent in the languages and primitives available (SVG box appropriation)
2. Codebases accumulate brittle magic numbers and case-by-case positioning hacks to compensate for perceptual centering issues
3. Centuries of hard-won understanding about visual balance from typography and fine arts remain locked away in design theory rather than being encoded into our programming tools.

---

Can we capture the essence of these optical effects programmatically? If so, how can we integrate these effects into our languages, libraries, standards, and representations?

---

As it turns out, we have a pool of academic research on this very specific topic. Here is one excerpt from [...] which shows that humans are actually quite consistent with their estimation of a shapes center. In the case of flat polygons, the perceptual center is (empirically) very close to the _centroid_ of the shape, which is the mean/average position of all points inside the shape. This is also the "center of mass" assuming uniform density, meaning that we perceive the center of a 2D polygon to be very close to where you could balance it on your finger.
![[Pasted image 20250613091651.png]]

[insert section on calculating centroid for SVG]

This is not quite the whole picture though, one aspect of our perception here is the orientation — not the orientation of the file, but the perceived axes.

![[Pasted image 20250613093200.png]]

These axes intersect at the centroid, and their angle is based

#### scratch notes

- pick a single term that's clear. optical effects, perceptual center/effects, etc
