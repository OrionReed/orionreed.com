---
title: Foobar
date: 2023-10-30
location: Somewhere in England
---


## Reference Systems
The last essential component for our understanding of objects is to recognise that reference does not exist in relation to individual objects, but is encoded in *systems* which condition, prefigure, or otherwise shape *how one can refer.* Reference is an aspect of all systems, but while some systems use reference, other systems *provide* it. Filesystems, databases, the Unicode standard, programming languages, URL schemes, and other disparate systems, all provide ways to *refer.* Some of these (like Unicode) have a tightly controlled set of objects already defined (i.e. Unicode codepoints), while databases provide no predefined objects but control how one can refer and the structure of the objects referred to. We might view these systems as shaping *families of objects*, which may be more or less homogenous across a range of characteristics. Observing these systems collectively with all of their overlaps and interactions, a comprehensive picture of their interrelations becomes untenable. Much like software in the real world, these complex interactions and overlaps create something closer to ecologies of objects, rather than clearly delineated, singular systems. A broader *ecological* or *complex systems* analysis is out of scope for this paper, but would depend on foundation we are trying to develop here. As such, we will focus on individual systems of reference and not their complex interactions.

## Characterising Reference
Objecthood is not just a binary condition but a *spectrum* — while something is *an* object if we refer to it, the way in which we refer which shapes the nature of its objecthood. To compare, contrast and otherwise understand objects, we need richer language to understand reference and its role in shaping their existence. The following is a collection of 6 dimensions with which we can position objects and the systems that shape them, paired with illustrative examples. We can think of objects as occupying positions or ranges on these dimensions, and systems shaping upper or lower bounds in which objects are positioned. The goal of these is not formalisation, but to provide language with which we can compare, contrast, and articulate features of existing systems as well as systems which do not yet exist.

**1. Granular - Coarse:** Can the smallest objects be referred to? Or must one reference larger assemblages of these objects? 

> Example: A spreadsheet provides reference to individual cells which contain — often but not always — small quantities of information, whereas a traditional filesystem is very coarse, providing reference to arbitrarily large files and not their constituent parts. Note that granular referenceability does not preclude more coarse reference, but coarse reference *does* preclude (or necessitate fragile workarounds for) granularity.

**2. Open - Closed:** Can the objects be referred to from any system? or are objects contained *within* a system which excludes, limits, or otherwise controls referenceability?

> Example: An self-contained application with fully internal state and no APIs or means of reference is a fully closed system, a filesystem which provides the same means of reference as it gives to itself is an open system.

**3. Persistent - Transient:** Is reference assured over time?

> Example: File objects stored in a decentralised filesystem are highly persistent — existing for as long as any one person is using them. In contrast, webpages have an average half-life of just over 2 years and are far less persistent [@Fetterly_2003]. An extremely transient object would be one which exists for only moments, such as a value in a running program.

**4. Atemporal - Temporal:** Can the reference or referent change?

> Example: Content-addressed objects are atemporal — neither their reference or referent change. Unicode words are a mix — reference is fixed, but the referent can change through social means, i.e. the meaning of words can change. A file in a traditional filesystem is temporal — the reference (filename) can change and so can the referent (file content).

**5. Technical - Social:** Is the the relation between reference and referent maintained through technical or social means?

> Example: A file path or database ID is a technical reference, whereas a word or term in text (e.g. "Python") is a primarily social one, as the reference is connected to the referent only in the minds of readers.

**6. Public - Private:** Is power over reference held in common, or is this power held by a private organisation?

> Example: Text is public, you can freely use words or phrases across various systems with near ubiquity. On the other hand, Tweets are private, while Twitter lets you reference tweets via their URL, this is at the behest of the company and they are free to change or to remove this capacity at any time. Private objects range from songs on music apps, interface widgets in creative tools, messages in communication apps, and so on.

# The Role of Objects in Organisation
The organisational role of objects stems from the fact that objects are precisely the things which we can talk about and put into relation. Organisation can mean different things depending on the context, but we can identify two broad meanings of the term: 

1. *Organisation-as-object:* A collection of elements with with a given arrangement and structure. This usage emphasises the ways in which these elements or components *are* arranged, grouped, and interconnected.
2. *Organisation-as-process:* The process of arranging and structuring elements or components in a systematic and orderly way. This usage of organisation organisation emphasises the ways in which these elements or components *come to be* arranged, grouped, and interconnected to form a cohesive whole that functions according to certain principles or rules.

We take this combined meaning as a working definition of organisation: The way in which elements *are* or *come to be* arranged, structured, and interconnected. The role of objects here is hopefully clear, as to express or represent structure or relations between objects, these objects must first exist.[^4] This structuring is rarely independent of the systems which condition these objects; changes to the position of a file object in its hierarchy changes the reference itself because its reference is determined by its location in the hierarchical structure. Note that this does not mean a change in *referent*, a text file that is moved to a different place in the hierarchy retains its content (though a small change is often made to its metadata). We also see this coupling in filesystems through the enforcement of metadata.

[^4]: We often create structure for things which do not yet exist. However, to do this we still must use existing objects, it is just their role that is different (i.e. as stand-ins or "holes" which may or may not get replaced or filled later).

## Structural Characteristics of Reference
While reference provides objecthood, this is often entangled with the way in which objects are organised. For example, a reference to a file is derived from its position in a hierarchy, and a reference to a named class in a programs source code is dependent on there being only one class of the same name within some scope to which the class objects belong. I posit that provision of structure ought to be decoupled from provision of reference in information infrastructure, and that this decoupling key to enabling more pluralistic and flexible organisation of information.

**7. Independent - Dependent:** An independent reference refers to an object directly, whereas a dependent reference requires reference to another object.

> Example: A PDF file is an independent object, whereas the pages of that PDF are dependent.[^9]

[^9]: All objects involve *some* level of dependence, as objects cannot exist with complete independence from the systems that their existence is conditional upon.

**8. Primitive - Composite:** A primitive reference points to a unit of information which cannot be further divided into units with semantic value, whereas a composite reference points to some collection or arrangement of these primitives.

> Example: A text paragraph is a composite object because it is composed of characters, a character is a primitive because it cannot be decomposed further into semantically meaningful objects — known as a "seme" in semantics.

**9. Pointer - Token:** A pointer reference points to a well-defined referent, a token reference points to no referent or one that escapes delineation.

> Example: A content-addressed file is a pointer because it has a mechanised relation to its referent (a hash derived from data, i.e. its referent). A tag in a notes app is a token, because its through interrelations with other objects (notes for example), that it becomes useful.[^5]

[^5]: Note that by ignoring a referent we can treat a pointer as a token, but the reverse is not the case. It is common for a pointer object to be repurposed as a token, such as a note being used as a tag in graph-like notes systems such as Roam or Obsidian.

# Objects and Identity
Stateful objects present an interesting challenge for our account. State refers to the present condition of a system, a *stateful* system is thus one which *can have* a present condition — this is in contrast to a stateless system which does not have a present, i.e. has no relation to time [@Harris_2010]. A stateful *object* is therefore one that can have a present condition. While this is a true statement it is not a sufficient definition for objects, as it is non-obvious how we can distinguish between an object that has changed, and an object that has been replaced with a "different" object. We can articulate this more concretely as the problem of *identity*,[^6] which in philosophy is approximate to the question of "sameness” [@Noonan_2022]. While a stateful object has an identity — there is a way in which the object is the same *over time* — object identity is not limited to continuity over time. Identity can extend over space (such as two image objects on opposite sides of the world being "the same"), can have fuzzy boundaries (people can disagree on what objects are part of a meme), can split and recombine (an applications code repository can be forked creating two apps with new identities, and later recombined into a singular "canonical" app), and so on. Object identity depends on technical as well as social systems, and while some systems do treat identity as an essential design consideration [@Hickey_], it is most often a consequence of other decisions around system design, technical efficiency, or other factors. I argue we should *decouple* identity from reference, especially in key systems such as filesystems, databases, and other information infrastructure. I am skeptical that there is any singular *solution* to identity management, but new approaches which are not embedded inside existing systems are sorely needed.

[^6]: This philosophical concept of identity is distinct from the better-known notion of identity in psychology and the social sciences. The concept in the social sciences has to do with a person's self-conception, social presentation, and more generally, the aspects of a person that make them unique, or qualitatively different from others. Whereas in philosophy identity has to do with a relation between X and Y that holds only if X and Y are the same.

# Discussion
I'm going to switch modes for this last section. I've run out of steam for this draft, so let me just touch on some things I might like to discuss in colloquial language.

Identifying three key responsibilities or roles of "object systems", and arguing that the tight coupling of these responsibilities is detrimental to our information infrastructure. Decoupling these is key to enabling "better" objects:

1. *Reference*, which conditions the ways objects come to exist and several of their key properties.
2. *Structure*, which conditions how objects are or can be interrelated and the forms they must take. E.g. filesystems impose metadata on their objects, task manager apps impose ways that tasks can be organised, etc.
3. *Identity*, which conditions the ways objects can be considered the same. This is the least-explored part of the paper so far but is super important, I think there's a lot of under-explored ways we can manage identity, but currently this is left to the mutability rules of a system (e.g. file modification) or is implicit in the structure and use of objects (e.g. we consider an image in two formats to be the same). This topic is so big and interesting it may merit its own paper, and I do have one idea for a generalisable approach, which is to view identity as a kind of *governance.* That is to say, that identity comes first from the ways that *people* agree that something is the same. We could imagine identity systems that are highly pluralistic with many overlapping identities. This governance position is currently dominated by system designers such as those designing filesystems, but I think we could articulate a much more decentralised and participatory approach to identity.

Looking at the "wants from objects", what do different discourses want from the objects of concern in their discourse? Malleable software wants interface objects that can are independent of apps; Itemised systems want user-facing data objects to be independent of application boundaries and freely structurable (calendar events, notes, tasks, contacts, etc); post-document systems want the objects currently hidden inside documents to be decoupled from the documents; and so on... One running theme through a lot of these wants is that objects should be robustly referenceable and independent, and that we need to *disaggregate* key objects into smaller referenceable parts. I'd like to expand and articulate these wants through the dimensions laid out earlier in the paper. And I'd like to argue that these discourses should be articulating demands of information *infrastructure* to enable success with these efforts, and recognise the limits of building isolated systems or new platforms — though this can be an effective way of exploring their goals.

I'd like to explore the predictive and explanatory power of this work. If it is a truly *robust* theory, which I think it could become, this needs to be proved out more empirically. Part of this would involve expanding approaches to analysis, while the dimensions are a nice start I would like to do a more systemic analysis of objects "in the wild" and explore the possibilities of formalising some of this work.

While individual systems have been explored, in practice these systems overlap and interconnect in many ways. Characterising interrelationships among multiple systems is a key point to expand on. E.g. the relation between an interface element and the "code" objects that underly it. There's lots of work that cares about these relationships and tries to do things with them, such as bidirectional lenses, linking languages, or linked data protocols. An empirical analysis would need to consider the many systems in seemingly "singular" objects: a JSON file, for example, involves file objects, unicode objects, named ontology elements, and these all interact nontrivially, such as the way that hierarchical structure is encoded in a linear structure of unicode objects.

There's a lot that could be said about expressibility, user agency, and the role of objects in  "digital language" — as through reference we create new “words" to speak *with* and new objects to speak *about.*

I'd like to explore implications for infrastructure design, and this is probably a theme that needs to run through the rest of the paper...

There's a political-economic dimension, mentioned in the "public-private" dimension, that's worth expanding on. Referenceability is one way that companies can obstruct more open, decentralised, and I think generally "better" systems from emerging. One could argue that some companies benefit from a "monopoly on referenceability" and that this is something we should try and escape, a fun idea here is to borrow the notion of "adversarial interoperability" and advocate for a kind of "adversarial referenceability" as a political/economic demand [@Doctorow_2019a].

Through this work it became clear that certain roles of objects are poorly supported: 

1. *semantic objects* — which gain usefulness through being stable tokens around which semantic structure can emerge — are poorly supported in our systems. Unicode words or phrases are nice tokens, but are highly dependent on files and are not independent in the way we'd like. Files (especially content-addressed ones) are stable and independent but are primarily *pointers* and have too much imposed structure to be good semantic objects. Imagining the best of both worlds is interesting to me: objects that are robust, atemporal, independent, tokens. Imagine if a phrase like "graph databases" could be its own object with a robust reference like a hash, which could be freely linked to, put into relation with other objects and be used in many contexts and places and not tied to a specific system (as files tend to be, but words do not)...
2. *relational objects* — which gain usefulness through expressing relations *between* objects — are also poorly served, as most relations are implicitly embedded in systems and have no independent representation. Research to address this often imposes *a ton* of assumptions and conditions, such as RDF or other semantic web efforts. I'm interested to explore what can be done here and am working on one approach for content-addressed systems with *content-addressed relations*, these do not impose (but can support the representation of) structure — no ordering of relata, no types/labels, no set arity, etc. These relational objects are compelling to me because they can be stable, independent, atemporal, and granular. One could imagine an ambient graph-like network emerging not through some decentralised database or protocol, but as a side effect of creating these kinds of relational objects in many different contexts.

I've focused on limited kinds of objects, things like files, words, PDFs, reminders, etc. Objects that are mostly referenced through *addressing systems.* The choice of examples in this paper need to be interrogated a lot more and there are other kinds of objects which I barely addressed at all, like the artefacts of HCI research: buttons, widgets, etc. Grappling with the wider existence of objects feels out of scope but is pretty important if this theory is to stand up to scrutiny.

Lastly, an obvious omission to this paper and discussion is a deeper exploration of the *usefulness* of this work to *specific* research efforts, this needs to change but I am still figuring out which discourses and specific research work I want to give the most attention in this paper. Feedback on this is *incredibly welcome*!

There's much more to do! And much to do that I *do not know about yet*! If you can help me figure out *any* of this I will be eternally grateful!

# References {.unnumbered}