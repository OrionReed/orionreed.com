import React from "react";

export function Toggle() {
  return (
    <>
      <button id="toggle-physics" onClick={() => window.dispatchEvent(new CustomEvent('togglePhysicsEvent'))}>
        <img src="src/assets/gravity.svg" alt="Toggle Physics" />
      </button>
    </>
  );
}
