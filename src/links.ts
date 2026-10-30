export interface TextLink {
	/** Offset of the first character of the link source, including Markdown syntax. */
	from: number;
	/** Offset just past the link source. */
	to: number;
	url: string;
}

const MARKDOWN_LINK = /!?\[(?:[^\]\\]|\\.)*\]\((<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)/g;
const BARE_URL = /https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"]/g;

/** Finds Markdown links and bare URLs in a line of source text. Image links are skipped. */
export function findLinks(text: string, offset = 0): TextLink[] {
	const links: TextLink[] = [];
	const covered: [number, number][] = [];
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		const start = match.index;
		const end = start + match[0].length;
		covered.push([start, end]);
		if (match[0].startsWith("!")) continue;
		const target = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
		if (/^https?:\/\//.test(target)) links.push({ from: offset + start, to: offset + end, url: target });
	}
	for (const match of text.matchAll(BARE_URL)) {
		const start = match.index;
		if (covered.some(([from, to]) => start >= from && start < to)) continue;
		links.push({ from: offset + start, to: offset + start + match[0].length, url: match[0] });
	}
	return links.sort((a, b) => a.from - b.from);
}
