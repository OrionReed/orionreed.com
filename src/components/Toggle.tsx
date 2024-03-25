export function Toggle() {
  return (
    <>
      <button id="toggle-canvas" onClick={() => window.dispatchEvent(new CustomEvent('toggleCanvasEvent'))}>
        <img src="/canvas-button.svg" alt="Toggle Canvas" />
      </button>
      <button id="toggle-physics" className="hidden" onClick={() => window.dispatchEvent(new CustomEvent('togglePhysicsEvent'))}>
        <img src="/gravity-button.svg" alt="Toggle Physics" />
      </button>
    </>
  );
}
