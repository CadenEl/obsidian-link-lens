import { type App, ButtonComponent, type Component, DropdownComponent, MarkdownRenderer, setIcon, setTooltip, TextComponent } from "obsidian";
import type { LoadResult } from "./cache";
import type { Actions, Badge, Preview } from "./preview";

/** A status dot for notes. The status text is in its tooltip and accessible label. */
export function createBadge(badge: Badge): HTMLElement {
	const dot = createSpan({ cls: ["link-lens-badge", `link-lens-tone-${badge.tone}`], attr: { "aria-label": badge.text, role: "img" } });
	setTooltip(dot, badge.text);
	return dot;
}

/**
 * The action controls' state. It lives outside the rendered elements so a
 * re-render, such as a background refresh, keeps a half-made choice.
 */
export interface ActionDraft {
	/** Selected menu value, or "" for the first option. */
	choice: string;
	/** Text typed for "Other…". */
	other: string;
	busy: boolean;
	error: string;
}

export interface RenderOptions {
	expanded: boolean;
	onToggle(expanded: boolean): void;
	draft: ActionDraft;
	/** Starts one of the preview's actions. The caller updates the draft and re-renders. */
	runAction(choice: string): void;
}

export function renderLoading(el: HTMLElement, providerName: string): void {
	el.empty();
	el.createDiv({ cls: "link-lens-note", text: `Loading from ${providerName}…` });
}

export function renderResult(el: HTMLElement, result: LoadResult, url: string, app: App, component: Component, options: RenderOptions): void {
	el.empty();
	if (!result.ok) {
		el.createDiv({ cls: "link-lens-note link-lens-error", text: result.error });
		return;
	}
	const { preview } = result;
	// A fresh card per render, so its click listener goes away with it on the next render.
	const card = el.createDiv({ cls: "link-lens-card" });
	const head = card.createDiv({ cls: "link-lens-head" });
	// The link wraps only the title text, so the rest of the row stays clickable for the toggle.
	const title = head.createDiv({ cls: "link-lens-heading" }).createEl("a", { cls: "link-lens-title external-link", text: preview.title, href: url });
	title.setAttr("target", "_blank");
	title.setAttr("rel", "noopener");
	const line = card.createDiv({ cls: "link-lens-line" });
	if (preview.badge) line.createSpan({ cls: ["link-lens-status", `link-lens-tone-${preview.badge.tone}`], text: preview.badge.text });
	if (preview.subtitle) line.createSpan({ cls: "link-lens-subtitle", text: preview.subtitle });
	if (!preview.fields.length && !preview.body && !preview.actions) return;

	let expanded = options.expanded;
	card.addClass("is-collapsible");
	// The chevron is the keyboard-reachable control. It has no listener of its own:
	// its clicks, including Enter and Space, bubble to the card's.
	const toggle = head.createEl("button", { cls: "link-lens-toggle clickable-icon" });
	setIcon(toggle, "chevron-down");
	const details = card.createDiv({ cls: "link-lens-details" });
	let rendered = false;
	const show = () => {
		toggle.setAttr("aria-expanded", String(expanded));
		toggle.setAttr("aria-label", expanded ? "Hide details" : "Show details");
		details.toggle(expanded);
		// Details render on first expand, so collapsed previews skip Markdown rendering.
		if (expanded && !rendered) {
			rendered = true;
			renderDetails(details, preview, app, component, options);
		}
	};
	// A click anywhere in the box toggles, except on the link, inside the details, or when it
	// ends a text selection. The chevron always toggles, since Enter and Space on it click
	// while a selection may remain.
	card.addEventListener("click", (event) => {
		const target = event.target as Node | null;
		if (title.contains(target) || details.contains(target)) return;
		const selection = card.win.getSelection();
		if (!toggle.contains(target) && selection && !selection.isCollapsed && card.contains(selection.anchorNode)) return;
		expanded = !expanded;
		options.onToggle(expanded);
		show();
	});
	show();
}

function renderDetails(details: HTMLElement, preview: Preview, app: App, component: Component, options: RenderOptions): void {
	if (preview.fields.length) {
		const fields = details.createDiv({ cls: "link-lens-fields" });
		for (const field of preview.fields) {
			fields.createDiv({ cls: "link-lens-label", text: field.label });
			fields.createDiv({ cls: "link-lens-value", text: field.value });
		}
	}
	if (preview.body) {
		const body = details.createDiv({ cls: "link-lens-body markdown-rendered" });
		void MarkdownRenderer.render(app, preview.body, body, "", component);
	}
	if (preview.actions) renderActions(details, preview.actions, preview.badge?.text, options);
}

/** A value no choice can use, so "Other…" never collides with a real one. */
const OTHER = "\u0000other";

function renderActions(details: HTMLElement, actions: Actions, current: string | undefined, options: RenderOptions): void {
	const { draft } = options;
	const row = details.createDiv({ cls: "link-lens-actions" });
	row.createSpan({ cls: "link-lens-label", text: actions.label });
	const dropdown = new DropdownComponent(row);
	const values = actions.choices.filter((choice) => choice !== current);
	for (const choice of values) dropdown.addOption(choice, choice);
	if (actions.allowOther) {
		dropdown.addOption(OTHER, "Other…");
		values.push(OTHER);
	}
	if (values.includes(draft.choice)) dropdown.setValue(draft.choice);
	const other = new TextComponent(row).setPlaceholder("Name").setValue(draft.other);
	other.inputEl.addClass("link-lens-other");
	const button = new ButtonComponent(row).setCta();
	details.createDiv({ cls: "link-lens-note link-lens-error", text: draft.error });
	const chosen = () => (dropdown.getValue() === OTHER ? other.getValue().trim() : dropdown.getValue());
	const sync = () => {
		other.inputEl.toggle(dropdown.getValue() === OTHER);
		dropdown.setDisabled(draft.busy);
		other.setDisabled(draft.busy);
		button.setDisabled(draft.busy || !chosen()).setButtonText(draft.busy ? "Moving…" : "Move");
	};
	dropdown.onChange((value) => {
		draft.choice = value;
		sync();
	});
	other.onChange((value) => {
		draft.other = value;
		sync();
	});
	sync();
	button.onClick(() => {
		const choice = chosen();
		if (draft.busy || !choice) return;
		draft.choice = dropdown.getValue();
		options.runAction(choice);
	});
}
