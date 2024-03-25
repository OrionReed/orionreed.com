import { atom, createShapeId, createTLUser, setUserPreferences, StoreSnapshot, Tldraw, TLGeoShape, TLInstance, TLRecord, TLShape, TLUiComponents, TLUnknownShape, TLUserPreferences, track, useEditor } from "@tldraw/tldraw";
import "@tldraw/tldraw/tldraw.css";
import { SimControls } from "./physics/ui/PhysicsControls";
import { uiOverrides } from "./physics/ui/overrides";
import { Helmet, HelmetProvider } from "react-helmet-async";
import React, { Suspense, useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

const components: TLUiComponents = {
	HelpMenu: null,
	StylePanel: null,
	PageMenu: null,
	NavigationPanel: null,
	DebugMenu: null,
	MenuPanel: null,
	// ContextMenu: null,
	// ActionsMenu: null,
	// ZoomMenu: null,
	// MainMenu: null,
	// Minimap: null,
	// Toolbar: null,
	// KeyboardShortcutsDialog: null,
	// QuickActions: null,
	// HelperButtons: null,
	// SharePanel: null,
	// TopPanel: null,
}

function App() {
	const [isPhysicsEnabled, setIsPhysicsEnabled] = useState(false);
	const [elementsInfo, setElementsInfo] = useState<any[]>([]);

	useEffect(() => {
		const togglePhysics = async () => {
			if (!isPhysicsEnabled) {
				const info = await gatherElementsInfo();
				setElementsInfo(info);
				setIsPhysicsEnabled(true); // Enable physics only after gathering info
			} else {
				setIsPhysicsEnabled(false);
				setElementsInfo([]); // Reset elements info when disabling physics
			}
		};

		window.addEventListener('togglePhysicsEvent', togglePhysics);

		return () => {
			window.removeEventListener('togglePhysicsEvent', togglePhysics);
		};
	}, [isPhysicsEnabled]);

	// Function to gather elements info asynchronously
	async function gatherElementsInfo() {
		const rootElement = document.getElementById('root');
		const info: any[] = [];
		if (rootElement) {
			for (const child of rootElement.children) {
				const rect = child.getBoundingClientRect();
				let w = rect.width
				if (!['P', 'UL'].includes(child.tagName)) {
					w = measureElementTextWidth(child);
				}
				console.log(w)
				info.push({
					tagName: child.tagName,
					position: { x: rect.left, y: rect.top },
					dimensions: { width: w, height: rect.height },
				});
			};
		}
		// Example usage
		// const element = document.getElementById('yourElementId'); // Replace 'yourElementId' with the actual ID
		// if (element) {
		// 	console.log(`Text width: ${textWidth}px`);
		// }
		// console.log(info.length);
		// console.log(info);

		return info;
	}

	const shapes: TLGeoShape[] = elementsInfo.map((element, index) => ({
		id: createShapeId(),
		type: 'geo',
		x: element.position.x,
		y: element.position.y,
		props: {
			geo: "rectangle",
			w: element.dimensions.width,
			h: element.dimensions.height,
			fill: 'solid',
			color: 'green'
		}
	}))

	shapes.push({
		id: createShapeId(),
		type: 'geo',
		x: 0,
		y: window.innerHeight,
		props: {
			geo: "rectangle",
			w: window.innerWidth,
			h: 20,
			fill: 'solid'
		}
	})

	return (
		<React.StrictMode>
			<HelmetProvider>
				<Toggle />
				{isPhysicsEnabled && elementsInfo.length > 0 ? <Canvas shapes={shapes} /> : <Default />}
			</HelmetProvider>
		</React.StrictMode>
	);
};

function Default() {
	return (
		<>
			<Helmet>
				<link rel="stylesheet" href="src/css/default.css" />
			</Helmet>
			<header>
				Orion Reed
			</header>
			<h1>Hello! 👋</h1>
			<p>
				My research investigates the intersection of computing, human-system
				interfaces, and emancipatory politics. I am interested in the
				potential of computing as a medium for thought, as a tool for
				collective action, and as a means of emancipation.
			</p>

			<p>
				My current focus is basic research into the nature of digital
				organisation, developing theoretical toolkits to improve shared
				infrastructure, and applying this research to the design of new
				systems and protocols which support the self-organisation of knowledge
				and computational artifacts.
			</p>

			<h1>My work</h1>
			<p>
				Alongside my independent work I am a researcher at <a href="https://block.science/">Block Science</a> building
				<i>knowledge organisation infrastructure</i> and at <a href="https://economicspace.agency/">ECSA</a> working on
				<i>computational media</i>. I am also part of the nascent <a href="https://libcomp.org/">Liberatory Computing</a>
				collective and a co-organiser of the <a href="https://canvasprotocol.org/">OCWG</a>.
			</p>

			<h1>Get in touch</h1>
			<p>
				I am on Twitter as <a href="https://twitter.com/OrionReedOne">@OrionReedOne</a> and on
				Mastodon as <a href="https://hci.social/@orion">@orion@hci.social</a>. The best way to reach me is
				through Twitter or my email, <a href="mailto:me@orionreed.com">me@orionreed.com</a>
			</p>

			<span className="dinkus">***</span>

			<h1>Talks</h1>
			<ul>
				<li><a
					href="objects/causal-islands-integration-domain.pdf">Spatial
					Canvases: Towards an Integration Domain for HCI @ Causal Islands LA</a></li>
				<li><a
					href="https://www.youtube.com/watch?v=-q-kk-NMFbA">Knowledge Organisation Infrastructure Demo @ NPC
					Denver</a></li>
			</ul>
			<h1>Writing</h1>
			<ul>
				<li><a
					href="https://blog.block.science/objects-as-reference-toward-robust-first-principles-of-digital-organization/">Objects
					as Reference: Toward Robust First Principles of Digital Organization</a></li>
			</ul>
		</>
	);
}

function Canvas({ shapes }: { shapes: TLShape[] }) {

	return (
		<div className="tldraw__editor">
			<Helmet>
				<link rel="stylesheet" href="src/css/tldraw.css" />
			</Helmet>
			<Tldraw
				overrides={uiOverrides}
				components={components}
			>
				<SimControls shapes={shapes} />
			</Tldraw>
		</div>
	);
}

function Toggle() {
	return (
		<>
			<Helmet>
				<link rel="stylesheet" href="src/css/toggle.css" />
			</Helmet>
			<button id="toggle-physics" onClick={() => window.dispatchEvent(new CustomEvent('togglePhysicsEvent'))}>
				<img src="src/assets/gravity.svg" alt="Toggle Physics" />
			</button>
		</>
	);
}

function Contact() {
	return (
		<div>
			<h1>Contact</h1>
			<p>Twitter: <a href="https://twitter.com/OrionReedOne">@OrionReedOne</a></p>
			<p>Mastodon: <a href="https://hci.social/@orion">orion@hci.social</a></p>
			<p>Email: <a href="mailto:me@orionreed.com">me@orionreed.com</a></p>
			<p>GitHub: <a href="https://github.com/orionreed">OrionReed</a></p>
		</div>

	)
}

function measureElementTextWidth(element: Element) {
	// Create a temporary span element
	const tempElement = document.createElement('span');
	// Get the text content from the passed element
	tempElement.textContent = element.textContent || element.innerText;
	// Get the computed style of the passed element
	const computedStyle = window.getComputedStyle(element);
	// Apply relevant styles to the temporary element
	tempElement.style.font = computedStyle.font;
	tempElement.style.fontWeight = computedStyle.fontWeight;
	tempElement.style.fontSize = computedStyle.fontSize;
	tempElement.style.fontFamily = computedStyle.fontFamily;
	tempElement.style.letterSpacing = computedStyle.letterSpacing;
	// Ensure the temporary element is not visible in the viewport
	tempElement.style.position = 'absolute';
	tempElement.style.visibility = 'hidden';
	tempElement.style.whiteSpace = 'nowrap'; // Prevent text from wrapping
	// Append to the body to make measurements possible
	document.body.appendChild(tempElement);
	// Measure the width
	const width = tempElement.getBoundingClientRect().width;
	// Remove the temporary element from the document
	document.body.removeChild(tempElement);
	// Return the measured width
	return width === 0 ? 10 : width;
}