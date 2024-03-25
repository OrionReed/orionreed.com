import { TLUnknownShape, useEditor } from "@tldraw/tldraw";
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
					console.log('destroy');
					destroy();
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
