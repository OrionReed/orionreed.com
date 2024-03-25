import { TLUnknownShape, useEditor } from "@tldraw/tldraw";
import { useEffect } from "react";
import { usePhysicsSimulation } from "./simulation";

export const SimController = ({ shapes }: { shapes: TLUnknownShape[] }) => {
	const editor = useEditor();

	useEffect(() => {
		editor.createShapes(shapes)
		return () => { editor.deleteShapes(editor.getCurrentPageShapes()) }
	}, []);


	const { addShapes } = usePhysicsSimulation(editor, true);

	return (<></>);
};
