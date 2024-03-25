export function Toggle() {
  return (
    <>
      <button id="toggle-physics" onClick={() => window.dispatchEvent(new CustomEvent('togglePhysicsEvent'))}>
        <img src="/gravity-button.svg" alt="Toggle Physics" />
      </button>
    </>
  );
}
