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

This process is _symmetric_ as neither device has a 'sender' or 'receiver' role and can both send data at any point and allows simple procedures like SDP exchange to be built on top.

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
  <md-cell-circle cells='60' width='0.2' id="protocol-v1">
    no backchannel
  </md-cell-circle>
  <md-cell-circle cells='60' width='0.2' id="protocol-v2">
    with backchannel
  </md-cell-circle>
</md-group>

## 3. Fountain Codes

The third variation I wanted to explore was _unidirectional_ transfer, getting data from one device to another as fast as possible without any backchannel. As seen with the previous approach, simply rotating round every chunk in a loop is not a scalable approach. The ideal case is some approach where we can continuously broadcast QR codes and not require that _specific_ QR codes are received.

One might think of **Error Correcting Codes (ECCs)** which allow the message to be reconstructed from malformed bytes or packets. However, in our case we have well-formed data but are _missing_ pieces of it. What we need is an [erasure code](https://en.wikipedia.org/wiki/Erasure_code) which assumes bit _erasures_, rather than bit _errors_.

**Errors:** You receive corrupted data (wrong bits) but don't know which bits are wrong <br/>
**Erasures:** You know exactly which data is missing (dropped packets, missing chunks)

This is where **fountain codes** (also known as _rateless erasure codes_) become invaluable. These erasure codes can generate unlimited encoded chunks from source chunks, where the original source can be recovered from any subset of chunks only slightly larger than the source size. Put simply: input $K$ chunks and get an infinite stream (a _fountain_) of new chunks where any $K\approx K$ encoded chunks can reproduce the original data. [^2]

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

<script>
class QRTPProtocol {
  constructor(circle, options = {}) {
    this.circle = circle;
    this.cellCount = circle.cellCount;
    this.broadcastIndex = 0;
    this.receivedCells = new Set();
    this.retransmitCells = new Set();
    this.acknowledgedCells = new Set(); // Cells that have been flood-filled
    this.isRunning = false;
    this.isBroadcasting = false; // Flag to prevent concurrent broadcast loops
    this.lastBroadcastCell = -1;
    this.floodFillTimer = null;
    this.isFloodFilling = false;
    this.timeouts = new Set(); // Track timeouts for cleanup
    
    // Protocol options
    this.enableFloodFill = options.enableFloodFill !== false;
    this.skipAcknowledged = options.skipAcknowledged || false;
    
    // Protocol parameters
    this.receptionProbability = 0.35; // Lower probability for more realistic loss
    this.broadcastSpeed = 80; // ms per cell
    this.floodFillSpeed = 25; // Faster flood fill spread
    this.floodFillDelay = 800; // ms to wait before flood fill
  }

  // Get CSS variable colors for theme support (always fresh to handle theme changes)
  getColors() {
    const root = getComputedStyle(document.documentElement);
    return {
      broadcast: root.getPropertyValue('--color-black').trim(),
      received: root.getPropertyValue('--color-green').trim(),
      retransmit: root.getPropertyValue('--color-orange').trim(),
      floodFill: root.getPropertyValue('--color-blue').trim(),
      acknowledged: root.getPropertyValue('--color-gray').trim(),
      completion: root.getPropertyValue('--color-white').trim()
    };
  }

  // Refresh all visible cell colors (useful when theme changes)
  refreshAllColors() {
    if (!this.isRunning) return;
    
    for (let i = 0; i < this.cellCount; i++) {
      if (i === this.lastBroadcastCell) {
        // Keep broadcast cell as-is
        continue;
      }
      // Restore each cell to its proper color
      this.restoreCell(i);
    }
  }

  async sleep(ms) {
    return new Promise(resolve => {
      const timeoutId = setTimeout(resolve, ms);
      // Store timeout for cleanup
      if (!this.timeouts) this.timeouts = new Set();
      this.timeouts.add(timeoutId);
      // Remove from set when resolved
      setTimeout(() => this.timeouts?.delete(timeoutId), ms + 10);
    });
  }

  // Yield control to browser to prevent blocking
  async yield() {
    return new Promise(resolve => {
      requestAnimationFrame(() => {
        setTimeout(resolve, 0);
      });
    });
  }

  // Restore cell to its proper state (not black)
  restoreCell(cellIndex) {
    if (!this.isRunning) return; // Don't restore cells if not running
    
    const colors = this.getColors();
    
    if (this.acknowledgedCells.has(cellIndex)) {
      this.circle.setCell(cellIndex, colors.acknowledged); // Light grey for acknowledged
    } else if (this.retransmitCells.has(cellIndex)) {
      this.circle.setCell(cellIndex, colors.retransmit); // Orange for retransmit
    } else if (this.receivedCells.has(cellIndex)) {
      this.circle.setCell(cellIndex, colors.received); // Green for received
    } else {
      this.circle.clearCell(cellIndex); // Clear if not received
    }
  }

  // Continuous broadcast that keeps going around
  async continuousBroadcast() {
    // Prevent multiple concurrent broadcast loops
    if (this.isBroadcasting) {
      console.log('Broadcast already running, skipping');
      return;
    }
    
    this.isBroadcasting = true;
    
    try {
      while (this.isRunning) {
        // Yield control to browser every loop iteration
        await this.yield();
        
        // Check if still running before each operation
        if (!this.isRunning) break;
        
        // Clear previous broadcast cell
        if (this.lastBroadcastCell !== -1) {
          this.restoreCell(this.lastBroadcastCell);
        }
        
        // Check if still running
        if (!this.isRunning) break;
        
        // Skip acknowledged cells if enabled
        if (this.skipAcknowledged && this.acknowledgedCells.has(this.broadcastIndex)) {
          // Move to next cell without processing
          this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;
          continue;
        }
        
        // Set current broadcast cell to black
        const colors = this.getColors();
        this.circle.setCell(this.broadcastIndex, colors.broadcast); // Black for current broadcast
        this.lastBroadcastCell = this.broadcastIndex;
        
        // Handle reception logic for this cell
        this.handleReception(this.broadcastIndex);
        
        // Schedule flood fill if we have retransmissions (only if enabled)
        if (this.enableFloodFill) {
          this.scheduleFloodFill();
        }
        
        // Move to next cell
        this.broadcastIndex = (this.broadcastIndex + 1) % this.cellCount;
        
        // Check if all cells are received (complete cycle)
        // Check every iteration since we might skip cell 0 in skip mode
        if (this.receivedCells.size === this.cellCount) {
          await this.sleep(1000); // Pause to show completion
          this.isBroadcasting = false; // Clear flag before restart
          await this.showCompletionAndRestart();
          // Exit this loop - showCompletionAndRestart will start a new one
          return;
        }
        
        // Single sleep for broadcast speed
        await this.sleep(this.broadcastSpeed);
      }
    } finally {
      this.isBroadcasting = false;
    }
  }

  // Handle reception logic for a cell
  handleReception(cellIndex) {
    if (!this.isRunning) return;
    
    // Check if this cell was already received (retransmit)
    if (this.receivedCells.has(cellIndex)) {
      // Probabilistic retransmission detection (same probability as initial reception)
      if (Math.random() < this.receptionProbability) {
        this.retransmitCells.add(cellIndex);
      }
      return;
    }
    
    // Probabilistic initial reception
    if (Math.random() < this.receptionProbability) {
      this.receivedCells.add(cellIndex);
    }
  }

  // Schedule flood fill with debouncing
  scheduleFloodFill() {
    if (!this.isRunning || !this.enableFloodFill || this.retransmitCells.size === 0 || this.isFloodFilling) return;
    
    // Only schedule if not already scheduled and not currently flood filling
    if (!this.floodFillTimer) {
      this.floodFillTimer = setTimeout(() => {
        if (this.isRunning) { // Check if still running when timer fires
          this.startFloodFillCycle();
        }
      }, this.floodFillDelay);
    }
  }

  // Start repeating flood fill cycle
  async startFloodFillCycle() {
    this.floodFillTimer = null;
    this.isFloodFilling = true;
    
    while (this.isRunning && this.isFloodFilling && this.retransmitCells.size > 0) {
      // Yield control to browser
      await this.yield();
      
      const ackRanges = await this.floodFill();
      
      // Check if we should still continue after flood fill
      if (!this.isRunning || !this.isFloodFilling) break;
      
            // After flood fill, reset orange cells to green (ack sent, reset retransmit state)
      const floodColors = this.getColors();
      for (const cellIndex of this.retransmitCells) {
        if (cellIndex !== this.lastBroadcastCell) {
          this.circle.setCell(cellIndex, floodColors.received); // Back to green
        }
      }
      this.retransmitCells.clear(); // Clear retransmit state
      
      // Mark acknowledged cells if skip mode is enabled (do this AFTER resetting retransmit colors)
      if (this.skipAcknowledged && ackRanges) {
        for (const range of ackRanges) {
          for (const cellIndex of range) {
            this.acknowledgedCells.add(cellIndex);
            // Immediately show acknowledged cells as light grey
            if (cellIndex !== this.lastBroadcastCell) {
              this.circle.setCell(cellIndex, floodColors.acknowledged); // Light grey for acknowledged
            }
          }
        }
      }
      
      // Wait 2 seconds before next flood fill cycle
      await this.sleep(2000);
    }
    
    this.isFloodFilling = false;
  }

  // Flood fill algorithm across connected green cells
  async floodFill() {
    if (!this.isRunning || !this.isFloodFilling || this.retransmitCells.size === 0) return null;
    
    // Find all connected components of green cells
    const visited = new Set();
    const ackRanges = [];
    
    for (const retransmitCell of this.retransmitCells) {
      if (!this.isRunning || !this.isFloodFilling) return null;
      if (visited.has(retransmitCell)) continue;
      
      // Start flood fill from this retransmit cell
      const component = await this.floodFillFrom(retransmitCell, visited);
      if (component.length > 0) {
        ackRanges.push(component);
      }
    }
    
    if (!this.isRunning || !this.isFloodFilling) return null;
    
    // Visualize acknowledgement ranges (building the ack indices)
    const colors = this.getColors();
    for (const range of ackRanges) {
      for (const cellIndex of range) {
        if (!this.isRunning || !this.isFloodFilling) return null;
        if (cellIndex !== this.lastBroadcastCell) {
          this.circle.setCell(cellIndex, colors.floodFill); // Blue for ack range
        }
        await this.sleep(this.floodFillSpeed);
        // Yield control every few cells
        await this.yield();
      }
    }
    
    if (!this.isRunning || !this.isFloodFilling) return null;
    
    await this.sleep(1000); // Pause to show complete ack ranges
    
    if (!this.isRunning || !this.isFloodFilling) return null;
    
    // Clear blue ack visualization back to original states
    for (const range of ackRanges) {
      for (const cellIndex of range) {
        if (!this.isRunning || !this.isFloodFilling) return null;
        if (cellIndex !== this.lastBroadcastCell) {
          this.restoreCell(cellIndex);
        }
        // Yield control every few cells
        await this.yield();
      }
    }
    
    return ackRanges; // Return the ranges for potential acknowledgement tracking
  }

  async floodFillFrom(startCell, visited) {
    const component = [];
    const queue = [startCell];
    
    while (queue.length > 0) {
      const cell = queue.shift();
      if (visited.has(cell)) continue;
      
      visited.add(cell);
      component.push(cell);
      
      // Check neighbors (circular, so wrap around)
      const neighbors = [
        (cell - 1 + this.cellCount) % this.cellCount,
        (cell + 1) % this.cellCount
      ];
      
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor) && this.receivedCells.has(neighbor)) {
          queue.push(neighbor);
        }
      }
      
      // Yield control occasionally to prevent blocking
      if (component.length % 10 === 0) {
        await this.yield();
      }
    }
    
    return component;
  }

  // Show completion animation and restart after delay
  async showCompletionAndRestart() {
    // Immediately stop ALL operations
    this.isRunning = false; // Stop everything immediately
    this.isBroadcasting = false;
    this.isFloodFilling = false;
    
    if (this.floodFillTimer) {
      clearTimeout(this.floodFillTimer);
      this.floodFillTimer = null;
    }
    
    // Clean up all timeouts
    if (this.timeouts) {
      this.timeouts.forEach(id => clearTimeout(id));
      this.timeouts.clear();
    }
    
    // Give time for all operations to stop
    await this.yield();
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Show completion by clearing all cells
    for (let i = 0; i < this.cellCount; i++) {
      this.circle.clearCell(i); // Clear for completion
    }
    
    // Wait 3 seconds to show completion
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Clear everything and reset state
    this.receivedCells.clear();
    this.retransmitCells.clear();
    this.acknowledgedCells.clear();
    this.broadcastIndex = 0;
    this.lastBroadcastCell = -1;
    this.circle.clearAll(); // Clear all cells for fresh start
    
    // Schedule restart after a short delay to ensure cleanup
    setTimeout(() => {
      if (!this.isRunning && !this.isBroadcasting) { // Double check we're not already running
        this.isRunning = true;
        this.continuousBroadcast().catch(err => {
          console.error('Protocol error:', err);
          this.isRunning = false;
        });
      }
    }, 100);
  }

  // Reset protocol for new cycle (for stop/start functionality)
  async resetProtocol() {
    // Immediately stop ALL operations
    this.isRunning = false;
    this.isBroadcasting = false;
    this.isFloodFilling = false;
    
    if (this.floodFillTimer) {
      clearTimeout(this.floodFillTimer);
      this.floodFillTimer = null;
    }
    
    // Clean up all timeouts
    if (this.timeouts) {
      this.timeouts.forEach(id => clearTimeout(id));
      this.timeouts.clear();
    }
    
    // Clear everything and reset state
    this.receivedCells.clear();
    this.retransmitCells.clear();
    this.acknowledgedCells.clear();
    this.broadcastIndex = 0;
    this.lastBroadcastCell = -1;
    this.circle.clearAll(); // Clear all cells for fresh start
  }

  // Main protocol loop
  async runProtocol() {
    if (this.isRunning) return;
    this.isRunning = true;
    
    // Start continuous broadcast with error handling
    this.continuousBroadcast().catch(err => {
      console.error('Protocol error:', err);
      this.isRunning = false;
    });
  }

  stop() {
    this.isRunning = false;
    this.isBroadcasting = false;
    this.isFloodFilling = false;
    if (this.floodFillTimer) {
      clearTimeout(this.floodFillTimer);
      this.floodFillTimer = null;
    }
    
    // Clean up all timeouts
    if (this.timeouts) {
      this.timeouts.forEach(id => clearTimeout(id));
      this.timeouts.clear();
    }
  }
}

// Initialize both protocol versions
const circleV1 = document.querySelector('#protocol-v1');
const circleV2 = document.querySelector('#protocol-v2');

// Version 1: Basic retransmission (no flood fill)
const protocolV1 = new QRTPProtocol(circleV1, {
  enableFloodFill: false,
  skipAcknowledged: false
});

// Version 2: Flood fill with skip acknowledged cells
const protocolV2 = new QRTPProtocol(circleV2, {
  enableFloodFill: true,
  skipAcknowledged: true
});

// Start both protocol animations
protocolV1.runProtocol();
protocolV2.runProtocol();

</script>
