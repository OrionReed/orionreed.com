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

Here's some more text for testing and now here is a codec

<md-codec width='20rem'>
'QRTP': a
chunk index: a
chunks total: a
'ack' hash: a
chunk data: 8
</md-codec>

Esse aute laborum reprehenderit mollit proident labore duis aliquip laboris est. Magna laboris officia exercitation id culpa proident deserunt elit fugiat anim elit voluptate enim tempor incididunt. Sunt adipisicing velit quis qui duis. Voluptate ipsum in aute anim esse ipsum.

<div style="display: flex; gap: 2rem; align-items: center; justify-content: center; flex-wrap: wrap;">
  <div style="text-align: center;">
    <md-cell-circle cells='60' width='0.2' id="protocol-v1">
      no backchannel
    </md-cell-circle>
  </div>
  <div style="text-align: center;">
    <md-cell-circle cells='60' width='0.2' id="protocol-v2">
      with backchannel
    </md-cell-circle>
  </div>
</div>

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

// Listen for theme changes to refresh colors immediately
const observer = new MutationObserver(() => {
  protocolV1.refreshAllColors();
  protocolV2.refreshAllColors();
});

// Watch for changes to the data-theme attribute
observer.observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme']
});
</script>

## Chunks, Headers, Acks (QRTP-A)

QR transfer with chunks and acks, bidirectional between 2 devices

### A codec tangent

the little ts codec util and the mess of doing it by hand

## Backchannels & Flood Fill (QRTB-B)

QR transfer with audio backchannel

## Fountain Codes (QRTB-C)

QR transfer with luby transform fountain codes
