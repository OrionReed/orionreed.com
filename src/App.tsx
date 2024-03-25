import { Tldraw, track, useEditor } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { SimControls } from "./physics/ui/PhysicsControls";
import { uiOverrides } from "./physics/ui/overrides";

export default function Canvas() {

	return (
		<div className="tldraw__editor">
			<Tldraw
				overrides={uiOverrides}
			>
				<SimControls />
			</Tldraw>
		</div>
	);
}
