import { Tldraw, TLShape, TLUiComponents } from "@tldraw/tldraw";
import { SimController } from "../physics/PhysicsControls";
import { HTMLShapeUtil } from "../shapes/HTMLShapeUtil";

const components: TLUiComponents = {
  HelpMenu: null,
  StylePanel: null,
  PageMenu: null,
  NavigationPanel: null,
  DebugMenu: null,
  ContextMenu: null,
  ActionsMenu: null,
  QuickActions: null,
  MainMenu: null,
  MenuPanel: null,
  // ZoomMenu: null,
  // Minimap: null,
  // Toolbar: null,
  // KeyboardShortcutsDialog: null,
  // HelperButtons: null,
  // SharePanel: null,
  // TopPanel: null,
}

export function Canvas({ shapes }: { shapes: TLShape[]; }) {

  return (
    <div className="tldraw__editor">
      <Tldraw
        components={components}
        shapeUtils={[HTMLShapeUtil]}
      >
        <SimController shapes={shapes} />
      </Tldraw>
    </div>
  );
}
