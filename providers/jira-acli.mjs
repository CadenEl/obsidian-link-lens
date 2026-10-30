#!/usr/bin/env node
// Link Lens provider: previews a Jira work item with the Atlassian CLI (acli), and can move it to another status.
// Usage: node jira-acli.mjs <site-host> <ISSUE-KEY> [--status NAME]... [--action STATUS]
//   --status   a status to offer in the preview's "Move to" menu (repeat it; order is kept)
//   --action   move the issue to STATUS, then print the refreshed preview
// acli is signed in to one site, so links to any other site are refused rather than
// shown with that site's issue of the same key.
// Prints preview JSON on stdout. Errors go to stderr with exit code 1.
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const FIELDS = "summary,status,assignee,issuetype,parent,priority,description,updated";
const CATEGORY_TONES = { new: "neutral", indeterminate: "blue", done: "green" };
const BODY_LIMIT = 600;
const KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const USAGE = "Usage: jira-acli.mjs <site-host> <ISSUE-KEY> [--status NAME]... [--action STATUS]";

export function parseArgs(argv) {
	const [site, key, ...rest] = argv;
	if (!site || !KEY.test(key ?? "")) throw new Error(USAGE);
	const statuses = [];
	let action = null;
	for (let i = 0; i < rest.length; i += 2) {
		const [flag, value] = [rest[i], rest[i + 1]];
		if (!value?.trim()) throw new Error(`${flag} needs a value. ${USAGE}`);
		if (flag === "--status") statuses.push(value);
		else if (flag === "--action") action = value;
		else throw new Error(`Unknown option ${flag}. ${USAGE}`);
	}
	return { site, key, statuses, action };
}

/** Flattens Atlassian Document Format into short Markdown blocks. */
export function adfToBlocks(node) {
	if (!node || typeof node !== "object") return [];
	const text = (n) => (n.type === "text" ? (n.text ?? "") : n.type === "hardBreak" ? " " : (n.content ?? []).map(text).join(""));
	switch (node.type) {
		case "doc":
		case "blockquote":
		case "panel":
			return (node.content ?? []).flatMap(adfToBlocks);
		case "heading":
			return [`**${text(node).trim()}**`];
		case "paragraph":
			return [text(node).trim()].filter(Boolean);
		case "bulletList":
		case "orderedList":
			return [(node.content ?? []).map((item, i) => `${node.type === "orderedList" ? `${i + 1}.` : "-"} ${text(item).trim()}`).join("\n")];
		case "codeBlock":
			return [`\`\`\`\n${text(node)}\n\`\`\``];
		default:
			return [];
	}
}

/** Joins whole blocks up to the limit, so the excerpt never ends mid-sentence. */
export function excerpt(blocks, limit = BODY_LIMIT) {
	const kept = [];
	let length = 0;
	for (const block of blocks) {
		if (kept.length && length + block.length > limit) {
			kept.push("…");
			break;
		}
		kept.push(block.length > limit ? `${block.slice(0, limit).trimEnd()}…` : block);
		length += block.length;
	}
	return kept.join("\n\n");
}

/** Throws unless `acli jira auth status` output names the expected site. */
export function checkSite(expected, statusText) {
	const signedIn = /Site:\s*(\S+)/.exec(statusText)?.[1];
	if (!signedIn) throw new Error("Could not tell which Jira site acli is signed in to. Run: acli jira auth status");
	if (signedIn.toLowerCase() !== expected.toLowerCase()) {
		throw new Error(`acli is signed in to ${signedIn}, not ${expected}. Sign acli in to that site to preview its links.`);
	}
}

export function toPreview(key, issue, statuses = []) {
	const f = issue.fields ?? {};
	const fields = [];
	if (f.parent) fields.push({ label: "Parent", value: `${f.parent.key} ${f.parent.fields?.summary ?? ""}`.trim() });
	if (f.priority?.name) fields.push({ label: "Priority", value: f.priority.name });
	if (f.updated) fields.push({ label: "Updated", value: f.updated.slice(0, 10) });
	const body = excerpt(adfToBlocks(f.description));
	return {
		title: f.summary || key,
		// The assignee rides in the subtitle so the collapsed preview shows who has it.
		subtitle: [key, f.issuetype?.name, f.assignee?.displayName ?? "Unassigned"].filter(Boolean).join(" · "),
		badge: f.status?.name ? { text: f.status.name, tone: CATEGORY_TONES[f.status.statusCategory?.key] ?? "neutral" } : undefined,
		fields,
		body: body || undefined,
		// Every status is offered; Jira's workflow decides whether a move is allowed.
		actions: { label: "Move to", choices: statuses, allowOther: true },
	};
}

/**
 * Checks the signed-in site and fetches the issue at the same time, so the check adds no wait.
 * Both calls finish before this settles, so a failed check never leaves the lookup running.
 * @param {string} site
 * @param {string} key
 * @param {string[]} statuses
 * @param {Run} [run]
 */
export async function lookup(site, key, statuses, run = promisify(execFile)) {
	const [status, view] = await Promise.allSettled([
		run("acli", ["jira", "auth", "status"]),
		run("acli", ["jira", "workitem", "view", key, "--fields", FIELDS, "--json"], { maxBuffer: 8 * 1024 * 1024 }),
	]);
	if (status.status === "rejected") throw status.reason;
	checkSite(site, status.value.stdout);
	if (view.status === "rejected") throw view.reason;
	return toPreview(key, JSON.parse(view.value.stdout), statuses);
}

/**
 * Moves the issue, then re-reads it to confirm, since a transition Jira's workflow
 * doesn't allow can leave the status unchanged. The site is checked before anything changes.
 * @param {string} site
 * @param {string} key
 * @param {string} status
 * @param {string[]} statuses
 * @param {Run} [run]
 */
export async function move(site, key, status, statuses, run = promisify(execFile)) {
	checkSite(site, (await run("acli", ["jira", "auth", "status"])).stdout);
	await run("acli", ["jira", "workitem", "transition", "--key", key, "--status", status, "--yes"]);
	const preview = await lookup(site, key, statuses, run);
	const now = preview.badge?.text ?? "";
	if (now.toLowerCase() !== status.toLowerCase()) {
		throw new Error(`${key} is still ${now || "in its old status"}. Jira may not allow moving it to "${status}" from there.`);
	}
	return preview;
}

/** @typedef {(file: string, args: string[], options?: object) => Promise<{ stdout: string }>} Run */

async function main() {
	const { site, key, statuses, action } = parseArgs(process.argv.slice(2));
	const preview = action ? await move(site, key, action, statuses) : await lookup(site, key, statuses);
	process.stdout.write(JSON.stringify(preview));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`${(error.stderr || error.message || String(error)).trim()}\n`);
		process.exit(1);
	});
}
