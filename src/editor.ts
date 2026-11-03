import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { editorLivePreviewField } from "obsidian";
import type { LoadResult } from "./cache";
import { findLinks } from "./links";
import type { Badge } from "./preview";
import { createBadge } from "./render";

/** What the editor extension needs from the plugin. */
export interface BadgeSource {
	enabled(): boolean;
	/**
	 * Returns the cache key for a URL a provider handles and its newest result, even an expired one.
	 * With `load`, also starts a run when nothing fresh is cached.
	 */
	lookup(url: string, load: boolean): { key: string; result: LoadResult | undefined } | null;
	onUpdate(listener: (key: string) => void): () => void;
}

/** Rebuilds the badges. The value says whether to start runs for links with nothing fresh cached. */
const refresh = StateEffect.define<boolean>();

/** How long typing or scrolling must pause before new links load, so a URL isn't looked up on every keystroke. */
const SETTLE_MS = 400;

class BadgeWidget extends WidgetType {
	constructor(private readonly badge: Badge) {
		super();
	}

	eq(other: BadgeWidget): boolean {
		return other.badge.text === this.badge.text && other.badge.tone === this.badge.tone;
	}

	toDOM(): HTMLElement {
		return createBadge(this.badge);
	}
}

/** Shows provider badges after links in Live Preview. */
export function badgeExtension(source: BadgeSource) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			/** Cache keys of provider links in the current viewport. */
			private keys = new Set<string>();
			private readonly unsubscribe: () => void;
			private settleTimer: ReturnType<typeof setTimeout> | undefined;

			constructor(readonly view: EditorView) {
				this.decorations = this.build(true);
				this.unsubscribe = source.onUpdate((key) => {
					if (key && !this.keys.has(key)) return;
					// A result only repaints. Loading here would refetch every expired link on screen
					// each time one finishes. "" comes after clear(), when everything needs loading again.
					// Results arrive outside CodeMirror's update cycle, so dispatching here is safe.
					this.view.dispatch({ effects: refresh.of(!key) });
				});
			}

			update(update: ViewUpdate) {
				let load = update.startState.field(editorLivePreviewField) !== update.state.field(editorLivePreviewField);
				let rebuild = load;
				for (const tr of update.transactions) {
					for (const effect of tr.effects) {
						if (!effect.is(refresh)) continue;
						rebuild = true;
						load ||= effect.value;
					}
				}
				if (update.docChanged || update.viewportChanged) {
					rebuild = true;
					clearTimeout(this.settleTimer);
					this.settleTimer = setTimeout(() => this.view.dispatch({ effects: refresh.of(true) }), SETTLE_MS);
				}
				if (rebuild) this.decorations = this.build(load);
			}

			destroy() {
				clearTimeout(this.settleTimer);
				this.unsubscribe();
			}

			private build(load: boolean): DecorationSet {
				this.keys = new Set();
				const { state } = this.view;
				if (!source.enabled() || !state.field(editorLivePreviewField)) return Decoration.none;
				const widgets: Range<Decoration>[] = [];
				// Folds and replaced content can split one line across visible ranges; scan each line once.
				let lastLine = 0;
				for (const { from, to } of this.view.visibleRanges) {
					for (let pos = from; pos <= to; ) {
						const line = state.doc.lineAt(pos);
						pos = line.to + 1;
						if (line.number <= lastLine) continue;
						lastLine = line.number;
						for (const link of findLinks(line.text, line.from)) {
							if (inCode(state, link.from)) continue;
							const found = source.lookup(link.url, load);
							if (!found) continue;
							this.keys.add(found.key);
							const badge = found.result?.ok ? found.result.preview.badge : undefined;
							if (badge) widgets.push(Decoration.widget({ widget: new BadgeWidget(badge), side: 1 }).range(link.to));
						}
					}
				}
				return Decoration.set(widgets, true);
			}
		},
		{ decorations: (plugin) => plugin.decorations },
	);
}

function inCode(state: EditorState, pos: number): boolean {
	for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
		if (/code/i.test(node.type.name)) return true;
	}
	return false;
}

/**
 * Finds the link URL under the mouse in an editor. Returns null when the
 * pointer is over plain text or the empty space after a line.
 */
export function editorLinkAt(target: HTMLElement, x: number, y: number): string | null {
	const lineEl = target.closest(".cm-line");
	if (!lineEl || lineEl === target) return null;
	const view = EditorView.findFromDOM(target);
	if (!view) return null;
	const pos = view.posAtCoords({ x, y });
	if (pos === null) return null;
	const line = view.state.doc.lineAt(pos);
	return findLinks(line.text, line.from).find((link) => pos >= link.from && pos < link.to)?.url ?? null;
}
