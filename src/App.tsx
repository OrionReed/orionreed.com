import { createShapeId, TLUiComponents } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import "./css/style.css"
import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { HTMLShape } from "./ts/shapes/HTMLShapeUtil";
import { Default } from "./ts/components/Default";
import { Canvas } from "./ts/components/Canvas";
import { Toggle } from "./ts/components/Toggle";
import { gatherElementsInfo } from "./utils";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

function App() {
	const [isPhysicsEnabled, setIsPhysicsEnabled] = useState(false);
	const [elementsInfo, setElementsInfo] = useState<any[]>([]);
	const [fadeClass, setFadeClass] = useState(''); // State to control the fade class

	useEffect(() => {
		const togglePhysics = async () => {
			if (!isPhysicsEnabled) {
				const info = await gatherElementsInfo();
				setElementsInfo(info);
				setIsPhysicsEnabled(true); // Enable physics only after gathering info
				setFadeClass('fade-out'); // Start fading out the Default component
				// setTimeout(() => setFadeClass('fade-in'), 500); // Wait for fade-out to complete before fading in Canvas
			} else {
				setIsPhysicsEnabled(false);
				setElementsInfo([]); // Reset elements info when disabling physics
				setFadeClass(''); // Reset fade class to show Default component normally
			}
		};

		window.addEventListener('togglePhysicsEvent', togglePhysics);

		return () => {
			window.removeEventListener('togglePhysicsEvent', togglePhysics);
		};
	}, [isPhysicsEnabled]);



	const shapes: HTMLShape[] = elementsInfo.map((element) => ({
		id: createShapeId(),
		type: 'html',
		x: element.x,
		y: element.y,
		props: {
			w: element.w,
			h: element.h,
			html: element.html,
		}
	}))

	shapes.push({
		id: createShapeId(),
		type: 'geo',
		x: 0,
		y: window.innerHeight,
		props: {
			w: window.innerWidth,
			h: 50,
			color: 'grey',
			fill: 'solid'
		},
		meta: {
			fixed: true
		}
	})

	return (
		<React.StrictMode>
			<Toggle />
			<div style={{ zIndex: 999999 }} className={`default-component ${fadeClass}`}>
				{<Default />}
			</div>
			{isPhysicsEnabled && elementsInfo.length > 0 ? <Canvas shapes={shapes} /> : null}
		</React.StrictMode>
	);
};


