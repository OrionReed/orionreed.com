---
title: 'Scoped Propagators'
---

Scoped propagators are ... canvas environment implementation ... liveness ... debugging ... quick DIY tools ... lorem pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris.

An early work-in-progress 

As you can see in the examples above, scoped propagators can be used to add interactivity (e.g. buttons and sliders), constrain behaviour (layout constraints), add dynamic behaviour (lerp smoothing), create small utilitites, like homebrewed tools, and can combine these abilities to create more complex systems (a shark game with score counter, on/off switch, constrained joystick controls, and follower behaviour) all with 9 quite terse arrows.

#### NOTES/PHRASES:
- liveness/interactivity
- diagrammatic specification
- pure functions
- without escape
- adding behaviour in-situ, with the same tools and affordances as the rest of the environment (its just arrows)
- bridging between systems (governance system example)

## Definition
A scoped propagator is formed of a function which takes a *source* and *target* node and returns an updated *target* node, and a scope which defines some subset of events to listen to. We could express this more succinctly, though just as informally:

$$
{
f(a, b) \mapsto b'
}
$$
$$
{
S \subseteq \text{Events}
}
$$

For debugging purposes to allow side effects in propagators, allowing arbitrary JS execution.

Below are the four event scopes which are currently implemented. While I found these appropriate and useful for adding liveness to a canvas environment, part of the value of *scopes* is that they can be domain-specific.

| Scope | Conditions |
|----------|----------|
| change   | Properties of the source node change   | 
| click | A source node is clicked   | 
| tick    | A tick (frame render) event fires   | 
| geo    | A node changes whose bounds overlap the target   | 

## Applications
...

#### Debugging
... inspection video

#### Automation
reducing repetetive tasks, etc.
... prop update tool, multiple versions DAG

## Prior Work
Scoped Propagators are related to [**propagator networks**](https://dspace.mit.edu/handle/1721.1/54635) but differ in three key ways: 
- propagation happens along *edges* instead of *nodes*
- stateful cells are replaced with schematised nodes, and
- propagation is limited to a subset of events.

Propagator networks have several advantages as a general-purpose model...

## Future Work & Open Questions
- function reuse, access to scope
- handling of side effects
- handling cycles
- SISO is easy, but what about MIMO?
- application to other graph-shaped systems, like graph databases

vids:
![intro](intro.mp4)
![buttons](buttons.mp4)
![constraints](constraints.mp4)
![lerp](lerp.mp4)
![tools](tools.mp4)
![inspection](inspection.mp4)
![game](game.mp4)
![bridging systems](bridging.mov)