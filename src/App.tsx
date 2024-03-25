import "@tldraw/tldraw/tldraw.css";
import "@/css/style.css"
import React, { } from "react";
import ReactDOM from "react-dom/client";
import { Default } from "@/ts/components/Default";
import { Canvas } from "@/ts/components/Canvas";
import { Toggle } from "@/ts/components/Toggle";
import { usePhysics } from "@/ts/hooks/usePhysics.ts"
import { createShapes } from "@/utils";
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { Contact } from "@/ts/components/Contact.tsx";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

function App() {


	return (
		<React.StrictMode>
			<BrowserRouter>
				<Routes>
					<Route path="/" element={<Home />} />
					<Route path="/card/contact" element={<Contact />} />
				</Routes>
			</BrowserRouter>
		</React.StrictMode>
	);
};

function Home() {
	const { isPhysicsEnabled, elementsInfo, fadeClass } = usePhysics();
	const shapes = createShapes(elementsInfo)
	return (
		<><Toggle />
			<div style={{ zIndex: 999999 }} className={`default-component ${fadeClass}`}>
				{<Default />}
			</div>
			{isPhysicsEnabled && elementsInfo.length > 0 ? <Canvas shapes={shapes} /> : null}</>)
}