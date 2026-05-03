---
title: QR Transfer Protocols
description: Offline data transfer using QR codes
date: 2025-07-12
---

Back in March, I was exploring the feasibility of doing WebRTC handshakes over _unusual but readily available transports_ as part of the [folkjs](https://folkjs.org) project. I explored [MQTT](https://en.wikipedia.org/wiki/MQTT), [BitTorrent](https://en.wikipedia.org/wiki/BitTorrent), audio, and QR Codes. The silliness of using QR codes for data transfer seemed to strike a chord with some [people on Twitter](https://x.com/OrionReedOne/status/1901383095648927881) so I figured I would write down how this worked and the improvements I found along the way.

I recently transitioned into [full-time research](https://bsky.app/profile/orionreed.com/post/3lt5jj4hfjc2j), so expect more posts as I get into the habit of writing things down.

## 1. Chunks, Headers, Acks

To establish a WebRTC connection we need to send up to 3 KB[^1] of [SDP](https://en.wikipedia.org/wiki/Session_Description_Protocol) data in both directions, more than is practical for a single QR code. This lead me to the following design:

[^1]: It is _possible_ to reduce the SDP size down to around ~150 bytes, but I didn't know this at the time. I hope to elaborate on this in a future post.

1. Device $A$ splits its message into QR-sized chunks
2. Device $B$ receives the first chunk and updates an acknowledgement hash (ack) in the QR header
3. Device $A$ sees the hash, compares it against its current chunk, and shows the next chunk

<md-qrtp-handshake chunks="5" speed="2000"></md-qrtp-handshake>

This process is _symmetric_ as neither device has a 'sender' or 'receiver' role and can both send data at any point and allows simple procedures like SDP exchange to be built on top. Each device shows a QR code with a small header to hold the ack hashes and chunk indices:

<md-codec width='20rem'>
'QRTP': a
chunk index: a
chunks total: a
'ack' hash: a
chunk data: 8
</md-codec>

After [extracting a small encoding utility](/posts/string-codec/) the QRTP protocol was a mere 80 lines of code. It was simple and worked well, but it was slow. Very slow. It also required some quite silly-looking setups.

![QRTP](qrtp.jpg)

## 2. Audio Backchannels

Next time I revisited QR codes was after exploring _audio_ as a transport, which gave me a new idea.

1. Device $A$ splits message into chunks and starts displaying them in rapid succession, not waiting for acknowledgement.
2. Device $B$ uses a video stream, splitting out frames and scanning their QR code, then backchannels confirmation of received chunks over audio
3. Device $A$ receives acknowledgement and skips these chunks on the next loop until all chunks are sent.

Here's that approach in action. **Careful of volume:**

![qrtpb](backchannel.mp4)

### Flood fill

The bandwidth of audio is _extremely limited_ (clocking in at around 7 bytes per second). With chunks being scanned at around 15fps, simply backchannelling a list of chunk indices would be a challenge, as the list of indices to send would rapidly outgrow the rate at which they could be sent. To solve this, I needed a way to compress the information as much as possible.

After some experimenting I landed on a 'circular flood fill' approach. As chunks were seen for a second time, we treat them as 'seeds' in a ring of chunks and periodically flood outward from those seed points to get the largest range of contiguous received chunks. We'd then send over pairs of indices to inform the sender which chunks it could skip. Because audio is an unreliable transport, the flood fill neatly minimizes the data needed while maximizing the utility of that data by always acknowledging as many chunks as possible.

You can see this process visually in the sketch below where each chunk has a 30% probability of being received: Green is a received chunk, orange is a re-received chunk.

In the first ring you can see how the last few chunks take a long time to get transmitted successfully, which gets worse as the number of chunks increases. In the second ring the flood fill process (blue) reduces redundant transmission and dramatically reduces overall transfer time.

<md-group>
  <md-qrtp-protocol>no backchannel</md-qrtp-protocol>
  <md-qrtp-protocol backchannel>with backchannel</md-qrtp-protocol>
</md-group>

## 3. Fountain Codes

The third variation I wanted to explore was _unidirectional_ transfer, getting data from one device to another as fast as possible without any backchannel. As seen with the previous approach, simply rotating round every chunk in a loop is not a scalable approach. The ideal case is some approach where we can continuously broadcast QR codes and not require that _specific_ QR codes are received.

One might think of **Error Correcting Codes (ECCs)** which allow the message to be reconstructed from malformed bytes or packets. However, in our case we have well-formed data but are _missing_ pieces of it. What we need is an [erasure code](https://en.wikipedia.org/wiki/Erasure_code) which assumes bit _erasures_, rather than bit _errors_.

**Errors:** You receive corrupted data (wrong bits) but don't know which bits are wrong <br/>
**Erasures:** You know exactly which data is missing (dropped packets, missing chunks)

This is where **fountain codes** (also known as _rateless erasure codes_) become invaluable. These erasure codes can generate unlimited encoded chunks from source chunks, where the original source can be recovered from any subset of chunks only slightly larger than the source size. Put simply: input $K$ chunks and get an infinite stream (a _fountain_) of new chunks where $\gtrsim K$ encoded chunks can reproduce the original data. [^2]

[^2]: The overhead for Luby Transforms is typically around 10% of $K$

The only erasure code I knew of at the time was the [Luby Transform](https://en.wikipedia.org/wiki/Luby_transform_code) which is also among the simplest. During my research I also discovered, unsurprisingly, that I was not the first to have this idea. I highly recommend [this post](https://divan.dev/posts/fountaincodes/) by Divan which takes a more in-depth look at using Luby Transform codes for QR code data transfer in Go.

<md-group>
  <md-luby-transform>
  </md-luby-transform>
</md-group>

Luby Transform codes (pictured above) work by creating encoded chunks which are the XOR-ed combination of 1 or more source chunks, where the number of chunks combined for each encoded chunk is chosen from a [carefully designed probability distribution](https://en.wikipedia.org/wiki/Soliton_distribution). During decoding, you start with any received encoded chunk that combines only one source chunk (degree-1), recover that source chunk immediately, then XOR it out of all other encoded chunks that used it — this process creates new degree-1 chunks in a cascading effect that continues until all source chunks are recovered.

![fountain](fountain.mp4)

Fountain codes have some great properties for one-way communication: Many devices can scan the codes at once, and it doesn't matter when each device starts scanning, only that they collect enough encoded chunks. At its highest I saw this approach achieve just over **30 KB/s** but it was usually much slower.

There is a lot more to explore and plenty of improvements left on the table including practical necessities like handling multiple connections and addressing failure modes. All the same, the results were quite evocative — the fact I can sit next to someone with another device and be entirely unable to pass data across if the internet goes down is an indictment of computing as it exists today. A more pluralistic computing in which all data transport options are available, including the slow or silly ones, is a world I would very much like to see.

> Thanks to [chee](https://chee.party/) for feedback on this post and to [Chris Shank](https://chrisshank.com/) for the discussions during these explorations.
