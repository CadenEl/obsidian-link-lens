import { Component, FileSystemAdapter, HoverPopover, type HoverParent, type MarkdownPostProcessorContext, MarkdownRenderChild, Plugin } from "obsidian";
import { type LoadResult, PreviewCache } from "./cache";
import { DEFAULT_SETTINGS, type LinkLensSettings, parseSettings } from "./config";
import { badgeExtension, editorLinkAt } from "./editor";
import type { Badge, Preview } from "./preview";
import { type ProviderMatch, ProviderSet, type RunContext, runProvider, writeProviderScripts } from "./providers";
import { type ActionDraft, createBadge, renderLoading, renderResult } from "./render";
import { LinkLensSettingTab } from "./settingsTab";

/** The scripts in providers/, by file name. esbuild.config.mjs fills this in at build time. */
declare const PROVIDER_SCRIPTS: Record<string, string>;

export default class LinkLensPlugin extends Plugin {
	settings: LinkLensSettings = DEFAULT_SETTINGS;
	readonly cache = new PreviewCache(() => this.settings.cacheMinutes * 60_000);
	private providers = new ProviderSet([]);
	private readonly hoverParent: HoverParent = { hoverPopover: null };
	private current: { el: HTMLElement; popover: HoverPopover; pending: boolean } | null = null;
	/** Whether the last preview was expanded; the next one opens the same way. */
	private expanded = false;
	/** URLs with an action running, so a second click or popover can't start another. */
	private readonly acting = new Set<string>();

	async onload() {
		this.settings = parseSettings(await this.loadData());
		await writeProviderScripts(this.runContext().pluginDir, PROVIDER_SCRIPTS);
		this.providers = new ProviderSet(this.settings.providers);
		this.addSettingTab(new LinkLensSettingTab(this.app, this));
		this.registerEditorExtension(
			badgeExtension({
				enabled: () => this.settings.showBadges,
				lookup: (url, load) => this.lookup(url, load),
				onUpdate: (listener) => this.cache.onUpdate(listener),
			}),
		);
		this.registerMarkdownPostProcessor((el, ctx) => this.addReadingBadges(el, ctx));
		this.watchHover(document);
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.watchHover(win.doc)));
	}

	/** Saves settings. Pass `invalidate` for changes that alter what providers return, which drops every cached result. */
	async saveSettings(invalidate = false): Promise<void> {
		await this.saveData(this.settings);
		if (!invalidate) return;
		this.providers = new ProviderSet(this.settings.providers);
		this.cache.clear();
	}

	match(url: string): ProviderMatch | null {
		return this.providers.match(url);
	}

	/** Runs a provider without the cache, for the settings test box. */
	run(match: ProviderMatch): Promise<Preview> {
		return runProvider(match, this.runContext());
	}

	/** Runs a provider action, then caches the refreshed preview so badges update too. */
	private async runAction(match: ProviderMatch, choice: string): Promise<LoadResult> {
		if (this.acting.has(match.key)) return { ok: false, error: "A change to this item is already running." };
		this.acting.add(match.key);
		try {
			const result: LoadResult = { ok: true, preview: await runProvider(match, this.runContext(), ["--action", choice]) };
			this.cache.set(match.key, result);
			return result;
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			this.acting.delete(match.key);
		}
	}

	private loadPreview(match: ProviderMatch): Promise<LoadResult> {
		return this.cache.get(match.key, () => this.run(match));
	}

	/**
	 * Returns the cache key for a URL a provider handles and its newest result, even an expired
	 * one, so a badge keeps showing while it reloads. With `load`, a stale or missing result starts a run.
	 */
	lookup(url: string, load: boolean): { key: string; result: LoadResult | undefined } | null {
		const match = this.match(url);
		if (!match) return null;
		if (load && !this.cache.peek(match.key)) void this.loadPreview(match);
		return { key: match.key, result: this.cache.last(match.key) };
	}

	private runContext(): RunContext {
		const adapter = this.app.vault.adapter;
		const vaultDir = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return { vaultDir, pluginDir: `${vaultDir}/${pluginDir}`, extraPath: this.settings.extraPath };
	}

	private addReadingBadges(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
		// Popover bodies render with no source path; skipping them keeps links inside a preview from fanning out.
		if (!ctx.sourcePath || !el.querySelector("a.external-link")) return;
		ctx.addChild(new ReadingBadges(el, this));
	}

	private watchHover(doc: Document): void {
		this.registerDomEvent(doc, "mouseover", (event) => this.onMouseOver(event));
	}

	private onMouseOver(event: MouseEvent): void {
		const target = event.target as Node | null;
		if (!target?.instanceOf(HTMLElement) || target.closest(".link-lens-popover")) return;
		let el: HTMLElement | null = null;
		let url: string | null = null;
		const anchor = target.closest("a.external-link");
		if (anchor?.instanceOf(HTMLElement)) {
			el = anchor;
			url = anchor.getAttribute("href");
		} else if (target.closest(".cm-content")) {
			url = editorLinkAt(target, event.clientX, event.clientY);
			el = lineChild(target);
		}
		const match = url ? this.match(url) : null;
		if (!el || !match || this.isShowingFor(el)) return;
		this.showPopover(el, match);
	}

	/** True while a popover for this element is waiting to appear or still on screen. */
	private isShowingFor(el: HTMLElement): boolean {
		const current = this.current;
		return !!current && current.el === el && (current.pending || current.popover.hoverEl.isConnected);
	}

	private showPopover(el: HTMLElement, match: ProviderMatch): void {
		const popover = new HoverPopover(this.hoverParent, el, this.settings.hoverDelayMs);
		const entry = { el, popover, pending: true };
		this.current = entry;
		// HoverPopover cancels itself when the mouse leaves before it appears. Track the same
		// exit so re-entering the link starts a new popover instead of waiting on a dead one.
		const onOut = (event: MouseEvent) => {
			const to = event.relatedTarget as Node | null;
			if (to && el.contains(to)) return;
			entry.pending = false;
			el.removeEventListener("mouseout", onOut);
		};
		el.addEventListener("mouseout", onOut);
		popover.hoverEl.addClass("link-lens-popover");
		const content = popover.hoverEl.createDiv({ cls: "link-lens-content" });
		const draft: ActionDraft = { choice: "", other: "", busy: false, error: "" };
		let rendered: LoadResult | null = null;
		const render = (result: LoadResult) => {
			rendered = result;
			renderResult(content, result, match.url, this.app, popover, {
				expanded: this.expanded,
				onToggle: (expanded) => (this.expanded = expanded),
				draft,
				runAction: (choice) => void act(choice),
			});
		};
		const act = async (choice: string) => {
			if (draft.busy) return;
			draft.busy = true;
			draft.error = "";
			if (rendered) render(rendered);
			const result = await this.runAction(match, choice);
			draft.busy = false;
			if (result.ok) {
				draft.choice = "";
				draft.other = "";
			} else draft.error = result.error;
			render(this.cache.peek(match.key) ?? rendered ?? result);
		};
		// Follows the cache once the popover is on screen, so an action elsewhere or a newer
		// lookup replaces what it shows. A child component loads and unloads with the popover,
		// and a popover cancelled before it appears never loads, so it never subscribes.
		popover.addChild(
			new CacheFollower(this.cache, match.key, () => {
				const next = this.cache.peek(match.key);
				if (next && next !== rendered && !draft.busy) render(next);
			}),
		);
		const cached = this.cache.peek(match.key);
		if (cached) {
			render(cached);
			return;
		}
		renderLoading(content, match.provider.name);
		void this.loadPreview(match).then((result) => {
			if (!rendered) render(result);
		});
	}
}

/**
 * The editor element to anchor a popover to: the line's child that contains
 * the target, so moving between a link's nested spans keeps one popover.
 */
function lineChild(target: HTMLElement): HTMLElement | null {
	const line = target.closest(".cm-line");
	if (!line) return null;
	let el = target;
	while (el.parentElement && el.parentElement !== line) el = el.parentElement;
	return el;
}

/**
 * Badges for one rendered Reading-view section. Loads its links when it renders and
 * after a settings change, and repaints when a result for one of its links arrives.
 */
class ReadingBadges extends MarkdownRenderChild {
	private keys = new Set<string>();
	/** The badge after each anchor, so a repaint only touches links whose status changed. */
	private readonly shown = new Map<Element, { el: HTMLElement; badge: Badge }>();

	constructor(
		containerEl: HTMLElement,
		private readonly plugin: LinkLensPlugin,
	) {
		super(containerEl);
	}

	onload(): void {
		this.render(true);
		this.register(
			this.plugin.cache.onUpdate((key) => {
				if (!key) this.render(true);
				else if (this.keys.has(key)) this.render(false);
			}),
		);
	}

	private render(load: boolean): void {
		this.keys = new Set();
		const enabled = this.plugin.settings.showBadges;
		for (const anchor of Array.from(this.containerEl.querySelectorAll("a.external-link"))) {
			const url = anchor.getAttribute("href");
			const found = enabled && url ? this.plugin.lookup(url, load) : null;
			if (found) this.keys.add(found.key);
			const badge = found?.result?.ok ? found.result.preview.badge : undefined;
			const shown = this.shown.get(anchor);
			if (shown && badge && shown.badge.text === badge.text && shown.badge.tone === badge.tone) continue;
			shown?.el.remove();
			this.shown.delete(anchor);
			if (!badge) continue;
			const el = createBadge(badge);
			anchor.after(el);
			this.shown.set(anchor, { el, badge });
		}
	}
}

/** Calls `refresh` while loaded: once on load, then whenever the cached result for `key` changes. */
class CacheFollower extends Component {
	constructor(
		private readonly cache: PreviewCache,
		private readonly key: string,
		private readonly refresh: () => void,
	) {
		super();
	}

	onload(): void {
		this.refresh();
		this.register(
			this.cache.onUpdate((key) => {
				if (key === this.key) this.refresh();
			}),
		);
	}
}
