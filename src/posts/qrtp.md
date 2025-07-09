---
title: QR Transfer Protocols
date: 2025-07-08
---

## Introduction

Back in March I was exploring the feasability of doing WebRTC handshakes over less common but readily available transports. I explored MQTT, BitTorrent, Audio, and QR Codes. The silliness of using QR codes for data transfer seemed to strike a chord with some [people on Twitter](https://x.com/OrionReedOne/status/1901383095648927881) so I figured I should write down how this worked and the improvements I found along the way.

This post is also part of my recent transition into [full-time applied & independent research](https://bsky.app/profile/orionreed.com/post/3lt5jj4hfjc2j), so expect to see more posts in the future!

<md-quote source="Mark Fisher, Capitalist Realism" href="foo.com">In one of the key scenes in Alfonso Cuaron's 2006 film Children of
Men, Clive Owen's character, Theo, visits a friend at **Battersea
Power Station**, which is now some combination of government
building and private _collection_. Cultural treasures
Michelangelo's David, Picasso's Guernica, Pink Floyd's inflatable
pig - are preserved in a building that is itself a refurbished
heritage artifact
</md-quote>

## Chunks, Headers, Acks (QRTP-A)

QR transfer with chunks and acks, bidirectional between 2 devices

### A codec tangent

the little ts codec util and the mess of doing it by hand

## Backchannels & Flood Fill (QRTB-B)

QR transfer with audio backchannel

## Fountain Codes (QRTB-C)

QR transfer with luby transform fountain codes
