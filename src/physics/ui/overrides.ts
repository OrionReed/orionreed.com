import {
	TLUiEventSource,
	TLUiOverrides,
	TLUiTranslationKey,
} from "@tldraw/tldraw";

// In order to see select our custom shape tool, we need to add it to the ui.
export const uiOverrides: TLUiOverrides = {
	actions(_editor, actions) {
		actions['toggle-physics'] = {
			id: 'toggle-physics',
			label: 'Toggle Physics' as TLUiTranslationKey,
			readonlyOk: true,
			kbd: 'p',
			onSelect(_source: TLUiEventSource) {
				const event = new CustomEvent('togglePhysicsEvent');
				window.dispatchEvent(event);
			},
		}
		return actions
	},
}