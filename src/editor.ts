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
	/** Returns the cached result for a URL a provider handles, starting a load when nothing is cached. */
	lookup(url: string): LoadResult | "loading" | null;
	onUpdate(listener: (url: string) => void): () => void;
}

const refresh = StateEffect.define<null>();

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
			/** Link URLs in the current viewport, loaded or loading. */
			private urls = new Set<string>();
			private readonly unsubscribe: () => void;

			constructor(readonly view: EditorView) {
				this.decorations = this.build();
				this.unsubscribe = source.onUpdate((url) => {
					if (url && !this.urls.has(url)) return;
					// Results arrive outside CodeMirror's update cycle, so a dispatch here is safe.
					this.view.dispatch({ effects: refresh.of(null) });
				});
			}

			update(update: ViewUpdate) {
				const refreshed = update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refresh)));
				const modeChanged = update.startState.field(editorLivePreviewField) !== update.state.field(editorLivePreviewField);
				if (update.docChanged || update.viewportChanged || refreshed || modeChanged) this.decorations = this.build();
			}

			destroy() {
				this.unsubscribe();
			}

			private build(): DecorationSet {
				this.urls = new Set();
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
							const result = source.lookup(link.url);
							if (result) this.urls.add(link.url);
							if (result && result !== "loading" && result.ok && result.preview.badge) {
								widgets.push(Decoration.widget({ widget: new BadgeWidget(result.preview.badge), side: 1 }).range(link.to));
							}
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
