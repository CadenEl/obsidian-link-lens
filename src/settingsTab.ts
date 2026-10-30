import { type App, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_PROVIDERS, parseProviders } from "./config";
import type LinkLensPlugin from "./main";

export class LinkLensSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: LinkLensPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const { settings } = this.plugin;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Status badges")
			.setDesc("Show each linked item's status after the link.")
			.addToggle((toggle) =>
				toggle.setValue(settings.showBadges).onChange(async (value) => {
					settings.showBadges = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Hover delay")
			.setDesc("Milliseconds to wait before showing a preview.")
			.addText((text) =>
				text.setValue(String(settings.hoverDelayMs)).onChange(async (value) => {
					const delay = Number(value);
					if (!Number.isFinite(delay) || delay < 0) return;
					settings.hoverDelayMs = delay;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Cache minutes")
			.setDesc("How long a preview is reused before its provider runs again.")
			.addText((text) =>
				text.setValue(String(settings.cacheMinutes)).onChange(async (value) => {
					const minutes = Number(value);
					if (!Number.isFinite(minutes) || minutes <= 0) return;
					settings.cacheMinutes = minutes;
					await this.plugin.saveSettings();
				}),
			)
			.addButton((button) => button.setButtonText("Clear cache").onClick(() => this.plugin.cache.clear()));

		new Setting(containerEl)
			.setName("PATH additions")
			.setDesc("Folders searched for provider programs before the app's PATH. Separate them with : on macOS and Linux, or ; on Windows.")
			.addText((text) =>
				text.setValue(settings.extraPath).onChange(async (value) => {
					settings.extraPath = value.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("Providers").setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Each provider matches link URLs with a regular expression and runs a command that prints a preview. The first enabled match wins. See the README for the output format.",
		});
		const editor = containerEl.createEl("textarea", { cls: "link-lens-providers" });
		editor.value = JSON.stringify(settings.providers, null, 2);
		editor.spellcheck = false;
		const status = containerEl.createDiv({ cls: "link-lens-providers-status" });
		editor.addEventListener("change", async () => {
			try {
				settings.providers = parseProviders(JSON.parse(editor.value));
			} catch (error) {
				status.setText(`Not saved: ${(error as Error).message}`);
				status.addClass("link-lens-error");
				return;
			}
			await this.plugin.saveSettings();
			status.setText("Saved.");
			status.removeClass("link-lens-error");
		});
		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Restore default providers").onClick(async () => {
				settings.providers = structuredClone(DEFAULT_PROVIDERS);
				await this.plugin.saveSettings();
				this.display();
			}),
		);

		new Setting(containerEl).setName("Test a link").setHeading();
		let testUrl = "";
		let output: HTMLElement;
		new Setting(containerEl)
			.setDesc("Runs the matching provider without the cache and shows its parsed output.")
			.addText((text) => text.setPlaceholder("https://…").onChange((value) => (testUrl = value.trim())))
			.addButton((button) =>
				button.setButtonText("Test").onClick(async () => {
					const match = this.plugin.match(testUrl);
					if (!match) {
						output.setText("No enabled provider matches this URL.");
						return;
					}
					output.setText(`Running ${match.provider.name}…`);
					try {
						output.setText(JSON.stringify({ provider: match.provider.id, groups: match.groups, preview: await this.plugin.run(match) }, null, 2));
					} catch (error) {
						output.setText(`Error: ${(error as Error).message}`);
					}
				}),
			);
		output = containerEl.createEl("pre", { cls: "link-lens-test-output" });
	}
}
