export const TONES = ["neutral", "blue", "green", "yellow", "red", "purple"] as const;
export type Tone = (typeof TONES)[number];

export interface Badge {
	text: string;
	tone: Tone;
}

export interface Field {
	label: string;
	value: string;
}

/**
 * Changes a provider can make, such as moving a Jira issue to another status.
 * Choosing one reruns the provider with `--action <choice>` appended; it must
 * make the change and print the refreshed preview.
 */
export interface Actions {
	label: string;
	choices: string[];
	/** Also offer a text box for a choice that isn't listed. */
	allowOther: boolean;
}

/** What a provider prints on stdout. See README.md for the contract. */
export interface Preview {
	title: string;
	subtitle?: string;
	badge?: Badge;
	fields: Field[];
	/** Markdown rendered below the fields. */
	body?: string;
	actions?: Actions;
}

/**
 * Parses a provider's stdout. JSON output must follow the preview contract;
 * any other output becomes the Markdown body, so a provider can be a plain
 * CLI that prints text.
 */
export function parsePreview(stdout: string, fallbackTitle: string): Preview {
	const text = stdout.trim();
	if (!text) throw new Error("The provider printed nothing.");
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return { title: fallbackTitle, fields: [], body: text };
	}
	return toPreview(data);
}

function toPreview(data: unknown): Preview {
	if (!isRecord(data)) throw new Error("Provider JSON must be an object.");
	const { title, subtitle, badge, fields, body, actions } = data;
	if (typeof title !== "string" || !title.trim()) throw new Error("Provider JSON needs a non-empty \"title\".");
	return {
		title,
		subtitle: optionalString(subtitle, "subtitle"),
		badge: badge === undefined || badge === null ? undefined : toBadge(badge),
		fields: fields === undefined || fields === null ? [] : toFields(fields),
		body: optionalString(body, "body"),
		actions: actions === undefined || actions === null ? undefined : toActions(actions),
	};
}

function toActions(value: unknown): Actions {
	if (!isRecord(value)) throw new Error("Provider \"actions\" must be an object.");
	const { label, choices, allowOther } = value;
	if (choices !== undefined && !isChoiceList(choices)) throw new Error("Provider actions \"choices\" must be an array of non-empty strings.");
	if (allowOther !== undefined && typeof allowOther !== "boolean") throw new Error("Provider actions \"allowOther\" must be true or false.");
	const result = { label: optionalString(label, "actions.label") ?? "Change to", choices: choices ?? [], allowOther: allowOther ?? false };
	if (!result.choices.length && !result.allowOther) throw new Error("Provider \"actions\" needs choices or allowOther.");
	return result;
}

function toBadge(value: unknown): Badge {
	if (!isRecord(value) || typeof value.text !== "string" || !value.text.trim()) {
		throw new Error("Provider \"badge\" needs a non-empty \"text\".");
	}
	const tone = value.tone ?? "neutral";
	if (!isTone(tone)) throw new Error(`Provider badge "tone" must be one of: ${TONES.join(", ")}.`);
	return { text: value.text, tone };
}

function toFields(value: unknown): Field[] {
	if (!Array.isArray(value)) throw new Error("Provider \"fields\" must be an array.");
	return value.map((field, index) => {
		if (!isRecord(field) || typeof field.label !== "string" || typeof field.value !== "string") {
			throw new Error(`Provider field ${index + 1} needs string "label" and "value".`);
		}
		return { label: field.label, value: field.value };
	});
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`Provider "${name}" must be a string.`);
	return value;
}

function isChoiceList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((choice) => typeof choice === "string" && choice.trim() !== "");
}

function isTone(value: unknown): value is Tone {
	return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
