import { TLUnknownShape, useEditor } from "@tldraw/tldraw";
import { useEffect, useState } from "react";
import { usePhysicsSimulation } from "./simulation";

export const SimController = ({ shapes }: { shapes: TLUnknownShape[] }) => {
	const editor = useEditor();
	const [isPhysicsActive, setIsPhysicsActive] = useState(false);
	const { addShapes, destroy } = usePhysicsSimulation(editor);

	const morphShapesDOM = () => {
		const cam = editor.getCamera()
		editor.setCamera({ x: cam.x, y: cam.y, z: 1 }, { duration: 200, easing: (t) => t * t })
		for (const shape of editor.getCurrentPageShapes()) {
			if (!shape.meta.DOMOrigin) continue;
			const x = shape.meta.DOMOrigin.x - cam.x;
			const y = shape.meta.DOMOrigin.y - cam.y;
			editor.animateShape({ id: shape.id, type: shape.type, x: x, y: y, rotation: 0 }, { duration: 200, easing: (t: number) => { return -(Math.cos(Math.PI * t) - 1) / 2; } })
		}
	}

	useEffect(() => {
		editor.createShapes(shapes)
		return () => { editor.deleteShapes(editor.getCurrentPageShapes()) }
	}, []);

	useEffect(() => {
		const togglePhysics = () => {
			setIsPhysicsActive((currentIsPhysicsActive) => {
				if (currentIsPhysicsActive) {
					console.log('destroy');
					destroy();
					morphShapesDOM()
					return false;
				} else {
					console.log('activate');
					return true;
				}
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
			console.log('adding shapes');

			addShapes(editor.getCurrentPageShapes()); // Activate physics simulation
		} else {
			destroy(); // Deactivate physics simulation
		}
	}, [isPhysicsActive, addShapes, shapes]);

	return (<></>);
};
