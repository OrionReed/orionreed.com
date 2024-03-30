import { Editor, TLUnknownShape, createShapeId, useEditor } from "@tldraw/tldraw";
import { useEffect, useState } from "react";
import { usePhysicsSimulation } from "./simulation";

export const SimController = ({ shapes }: { shapes: TLUnknownShape[] }) => {
	const editor = useEditor();
	const [isPhysicsActive, setIsPhysicsActive] = useState(false);
	const { addShapes, destroy } = usePhysicsSimulation(editor);

	useEffect(() => {
		editor.createShapes(shapes)
		return () => { editor.deleteShapes(editor.getCurrentPageShapes()) }
	}, []);

	useEffect(() => {
		const togglePhysics = () => {
			setIsPhysicsActive((currentIsPhysicsActive) => {
				if (currentIsPhysicsActive) {
					destroy();
					return false;
				}
				createFloor(editor);
				return true;
			});
		};

		// Listen for the togglePhysicsEvent to enable/disable physics simulation
		window.addEventListener('togglePhysicsEvent', togglePhysics);

		return () => {
			window.removeEventListener('togglePhysicsEvent', togglePhysics);
		};
	}, []);

	useEffect(() => {
		if (isPhysicsActive) {
			addShapes(editor.getCurrentPageShapes()); // Activate physics simulation
		} else {
			destroy(); // Deactivate physics simulation
		}
	}, [isPhysicsActive, addShapes, shapes]);

	return (<></>);
};

function createFloor(editor: Editor) {

	const viewBounds = editor.getViewportPageBounds();

	editor.createShape({
		id: createShapeId(),
		type: 'geo',
		x: viewBounds.minX,
		y: viewBounds.maxY,
		props: {
			w: viewBounds.width,
			h: 50,
			color: 'grey',
			fill: 'solid'
		},
		meta: {
			fixed: true
		}
	});
}

