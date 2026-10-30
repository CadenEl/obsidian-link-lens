import { describe, expect, it } from "vitest";
import { parsePreview } from "../src/preview";

describe("parsePreview", () => {
	it("reads the full JSON contract", () => {
		const preview = parsePreview(
			JSON.stringify({ title: "T", subtitle: "S", badge: { text: "Open", tone: "green" }, fields: [{ label: "A", value: "B" }], body: "**x**" }),
			"fallback",
		);
		expect(preview).toEqual({ title: "T", subtitle: "S", badge: { text: "Open", tone: "green" }, fields: [{ label: "A", value: "B" }], body: "**x**" });
	});

	it("defaults the badge tone and fields", () => {
		expect(parsePreview('{"title":"T","badge":{"text":"Done"}}', "f")).toEqual({ title: "T", subtitle: undefined, badge: { text: "Done", tone: "neutral" }, fields: [], body: undefined });
	});

	it("treats non-JSON output as a Markdown body", () => {
		expect(parsePreview("  # Hello\nworld \n", "https://x")).toEqual({ title: "https://x", fields: [], body: "# Hello\nworld" });
	});

	it.each([
		["[]", "must be an object"],
		['{"title":""}', "non-empty \"title\""],
		['{"title":"T","badge":{"text":"x","tone":"pink"}}', "tone"],
		['{"title":"T","fields":[{"label":"a"}]}', "field 1"],
		['{"title":"T","body":3}', "\"body\" must be a string"],
	])("rejects %s", (stdout, message) => {
		expect(() => parsePreview(stdout, "f")).toThrow(message);
	});

	it("reads actions with defaults", () => {
		expect(parsePreview('{"title":"T","actions":{"choices":["Done"]}}', "f").actions).toEqual({ label: "Change to", choices: ["Done"], allowOther: false });
		expect(parsePreview('{"title":"T","actions":{"label":"Move to","allowOther":true}}', "f").actions).toEqual({ label: "Move to", choices: [], allowOther: true });
	});

	it.each([
		['{"title":"T","actions":[]}', "must be an object"],
		['{"title":"T","actions":{"choices":["", "x"]}}', "non-empty strings"],
		['{"title":"T","actions":{"choices":["x"],"allowOther":"yes"}}', "true or false"],
		['{"title":"T","actions":{}}', "needs choices or allowOther"],
	])("rejects actions %s", (stdout, message) => {
		expect(() => parsePreview(stdout, "f")).toThrow(message);
	});

	it("rejects empty output", () => {
		expect(() => parsePreview(" \n", "f")).toThrow("printed nothing");
	});
});
