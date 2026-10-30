import type { Preview } from "./preview";

export type LoadResult = { ok: true; preview: Preview } | { ok: false; error: string };

interface Entry {
	at: number;
	result: LoadResult;
}

/** Failures expire sooner so a fixed login or network shows up quickly. */
const ERROR_TTL_MS = 60_000;

/**
 * Caches provider results by URL, shares one run between concurrent requests
 * for the same URL, and caps how many provider processes run at once.
 */
export class PreviewCache {
	private readonly entries = new Map<string, Entry>();
	private readonly inflight = new Map<string, Promise<LoadResult>>();
	private readonly waiting: (() => void)[] = [];
	private readonly listeners = new Set<(key: string) => void>();
	private active = 0;

	constructor(
		private readonly ttlMs: () => number,
		private readonly maxConcurrent = 4,
		private readonly now: () => number = Date.now,
	) {}

	/** Returns a fresh cached result without starting a run. */
	peek(key: string): LoadResult | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		const ttl = entry.result.ok ? this.ttlMs() : Math.min(ERROR_TTL_MS, this.ttlMs());
		if (this.now() - entry.at > ttl) {
			this.entries.delete(key);
			return undefined;
		}
		return entry.result;
	}

	get(key: string, load: () => Promise<Preview>): Promise<LoadResult> {
		const cached = this.peek(key);
		if (cached) return Promise.resolve(cached);
		const running = this.inflight.get(key);
		if (running) return running;
		const promise: Promise<LoadResult> = this.limit(load)
			.then(
				(preview): LoadResult => ({ ok: true, preview }),
				(error: unknown): LoadResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
			)
			.then((result) => {
				if (this.inflight.get(key) === promise) {
					this.inflight.delete(key);
					this.store(key, result);
					return result;
				}
				// clear() or set() during the run superseded it: don't store the older result,
				// and hand waiters the replacement when there is one.
				return this.peek(key) ?? result;
			});
		this.inflight.set(key, promise);
		return promise;
	}

	/** Replaces the entry with a result obtained elsewhere, such as after an action. */
	set(key: string, result: LoadResult): void {
		this.inflight.delete(key);
		this.store(key, result);
	}

	clear(): void {
		this.entries.clear();
		this.inflight.clear();
		for (const listener of this.listeners) listener("");
	}

	/** Calls the listener with a URL when its result arrives, or with "" after clear(). */
	onUpdate(listener: (key: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private store(key: string, result: LoadResult): void {
		this.entries.set(key, { at: this.now(), result });
		for (const listener of this.listeners) listener(key);
	}

	private async limit<T>(task: () => Promise<T>): Promise<T> {
		// A finished task hands its slot straight to the next waiter, so the count never overshoots.
		if (this.active >= this.maxConcurrent) await new Promise<void>((resolve) => this.waiting.push(resolve));
		else this.active++;
		try {
			return await task();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
}
