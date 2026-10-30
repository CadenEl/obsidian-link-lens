import { describe, expect, it } from "vitest";
import { PreviewCache } from "../src/cache";

const preview = (title: string) => ({ title, fields: [] });
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
};

describe("PreviewCache", () => {
	it("shares one run between concurrent requests and caches the result", async () => {
		const cache = new PreviewCache(() => 1000);
		let runs = 0;
		const load = async () => (runs++, preview("a"));
		const [a, b] = await Promise.all([cache.get("u", load), cache.get("u", load)]);
		expect(a).toEqual({ ok: true, preview: preview("a") });
		expect(b).toBe(a);
		await cache.get("u", load);
		expect(runs).toBe(1);
		expect(cache.peek("u")).toEqual(a);
	});

	it("expires results after the TTL and errors after at most a minute", async () => {
		let now = 0;
		const cache = new PreviewCache(() => 10 * 60_000, 4, () => now);
		await cache.get("ok", async () => preview("a"));
		await cache.get("bad", async () => Promise.reject(new Error("boom")));
		expect(cache.peek("bad")).toEqual({ ok: false, error: "boom" });
		now = 61_000;
		expect(cache.peek("bad")).toBeUndefined();
		expect(cache.peek("ok")).toBeDefined();
		now = 10 * 60_000 + 1;
		expect(cache.peek("ok")).toBeUndefined();
	});

	it("never runs more than the limit at once", async () => {
		const cache = new PreviewCache(() => 1000, 2);
		let active = 0;
		let peak = 0;
		const gates = Array.from({ length: 5 }, () => deferred<void>());
		const results = gates.map((gate, i) =>
			cache.get(`u${i}`, async () => {
				active++;
				peak = Math.max(peak, active);
				await gate.promise;
				active--;
				return preview(String(i));
			}),
		);
		for (const gate of gates) {
			await new Promise((r) => setTimeout(r, 0));
			gate.resolve();
		}
		await Promise.all(results);
		expect(peak).toBe(2);
	});

	it("notifies listeners and drops results from before clear()", async () => {
		const cache = new PreviewCache(() => 1000);
		const seen: string[] = [];
		cache.onUpdate((key) => seen.push(key));
		const gate = deferred<void>();
		const stale = cache.get("u", async () => (await gate.promise, preview("old")));
		cache.clear();
		const fresh = cache.get("u", async () => preview("new"));
		gate.resolve();
		await Promise.all([stale, fresh]);
		expect(cache.peek("u")).toEqual({ ok: true, preview: preview("new") });
		expect(seen).toEqual(["", "u"]);
	});

	it("lets set() replace an entry and win over an older run in flight", async () => {
		const cache = new PreviewCache(() => 1000);
		const seen: string[] = [];
		cache.onUpdate((key) => seen.push(key));
		const gate = deferred<void>();
		const stale = cache.get("u", async () => (await gate.promise, preview("Open")));
		cache.set("u", { ok: true, preview: preview("Merged") });
		gate.resolve();
		// The superseded run's waiters get the replacement, not the older result.
		await expect(stale).resolves.toEqual({ ok: true, preview: preview("Merged") });
		expect(cache.peek("u")).toEqual({ ok: true, preview: preview("Merged") });
		expect(seen).toEqual(["u"]);
	});
});
