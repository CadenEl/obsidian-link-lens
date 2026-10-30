import { describe, expect, it } from "vitest";
import { findLinks } from "../src/links";

describe("findLinks", () => {
	it("finds Markdown links with their full source range", () => {
		const text = "- [ ] [PROJ-123](https://j/browse/PROJ-123): Follow up";
		const [link] = findLinks(text, 100);
		expect(link).toEqual({ from: 106, to: 106 + "[PROJ-123](https://j/browse/PROJ-123)".length, url: "https://j/browse/PROJ-123" });
	});

	it("finds bare URLs and trims trailing punctuation", () => {
		expect(findLinks("See https://github.com/o/r/pull/1. Then (https://x.dev/a).")).toEqual([
			{ from: 4, to: 33, url: "https://github.com/o/r/pull/1" },
			{ from: 41, to: 56, url: "https://x.dev/a" },
		]);
	});

	it("does not double count the URL inside a Markdown link", () => {
		expect(findLinks("[a](https://x.dev/1) and [b](<https://x.dev/2 3>)").map((l) => l.url)).toEqual(["https://x.dev/1", "https://x.dev/2 3"]);
	});

	it("skips images, internal targets, and titles", () => {
		expect(findLinks('![img](https://x.dev/i.png) [n](note.md) [t](https://x.dev/t "Title")').map((l) => l.url)).toEqual(["https://x.dev/t"]);
	});

	it("handles escaped brackets in link text", () => {
		expect(findLinks("[a \\] b](https://x.dev/e)").map((l) => l.url)).toEqual(["https://x.dev/e"]);
	});
});
