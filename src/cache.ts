import type { Preview } from "./preview";

export type LoadResult = { ok: true; preview: Preview } | { ok: false; error: string };

interface Entry {
	at: number;
	result: LoadResult;
}

/** Failures expire sooner so a fixed login or network shows up quickly. */
const ERROR_TTL_MS = 60_000;

/**
 * Caches provider results by key, shares one run between concurrent requests
 * for the same key, and caps how many provider processes run at once.
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
		return this.now() - entry.at > ttl ? undefined : entry.result;
	}

	/** Returns the newest result even after it expires, so a badge keeps showing until a reload replaces it. */
	last(key: string): LoadResult | undefined {
		return this.entries.get(key)?.result;
	}

	get(key: string, load: () => Promise<Preview>): Promise<LoadResult> {
		const cached = this.peek(key);
		if (cached) return Promise.resolve(cached);
		const running = this.inflight.get(key);
		if (running) return running;
		const promise: Promise<LoadResult> = this.limit(load, () => this.inflight.get(key) === promise)
			.then(
				(preview): LoadResult | undefined => (preview ? { ok: true, preview } : undefined),
				(error: unknown): LoadResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
			)
			.then((result) => {
				// Skipped because clear() or set() superseded it while it waited for a slot.
				if (!result) return this.get(key, load);
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
		this.notifyAll();
	}

	/** Tells every listener that any result may have changed, as clear() does, but keeps the results. */
	notifyAll(): void {
		for (const listener of this.listeners) listener("");
	}

	/** Calls the listener with a key when its result arrives, or with "" after clear() or notifyAll(). */
	onUpdate(listener: (key: string) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private store(key: string, result: LoadResult): void {
		this.entries.set(key, { at: this.now(), result });
		for (const listener of this.listeners) listener(key);
	}

	/** Runs `task` once a slot is free. Returns undefined without running it if it's no longer `wanted` by then. */
	private async limit<T>(task: () => Promise<T>, wanted: () => boolean): Promise<T | undefined> {
		// A task that gets a slot right away can't have been superseded yet.
		if (this.active < this.maxConcurrent) this.active++;
		else {
			// A finished task hands its slot straight to the next waiter, so the count never overshoots.
			await new Promise<void>((resolve) => this.waiting.push(resolve));
			if (!wanted()) {
				this.release();
				return undefined;
			}
		}
		try {
			return await task();
		} finally {
			this.release();
		}
	}

	private release(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.active--;
	}
}
