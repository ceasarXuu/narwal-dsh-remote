const HOUR = 60 * 60 * 1_000
const CLOCK_SKEW = 5 * 60 * 1_000
const FRESHNESS = 30 * 1_000

const invalidWindow = () => Object.assign(new Error('Expected a current calendar-day window'), { code: 'gateway/bad-request' })
const unavailable = () => Object.assign(new Error('Daily token usage is unavailable'), { code: 'narwal/token-usage-unavailable' })

function dayWindow({ start, end }, now) {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
		|| end - start < 22 * HOUR || end - start > 26 * HOUR
		|| start > now + CLOCK_SKEW || end <= now - CLOCK_SKEW) throw invalidWindow()
	return { start, end }
}

function reportedUsage({ type, data }) {
	if (type === 'assistant/chunk') return data.chunk?.type === 'usage' ? data.chunk.usage : undefined
	if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined
	if (type === 'assistant/message' && data.usage !== undefined) return data.usage
	return data.stream?.findLast(record => record.type === 'chunk' && record.chunk.type === 'usage')?.chunk.usage
}

function tokenSum(usage) {
	const counts = [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
	if (!counts.every(count => Number.isSafeInteger(count) && count >= 0)) throw unavailable()
	return counts.reduce((total, count) => total + count, 0)
}

function usageInWindow(observation, { start, end }) {
	const { events, inheritedEventCount } = observation
	// A branch inherits the parent's journal, including usage the desktop already counted there.
	const offset = inheritedEventCount ?? (observation.header.isSeeded
		? events.findIndex(event => event.type === 'session/end-seed' && event.data.inherited === true) : 0)
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > events.length) throw unavailable()
	let total = 0
	let previous
	for (let index = offset; index < events.length; index++) {
		const event = events[index]
		const usage = reportedUsage(event)
		if (event.type !== 'llm/retry-started' && !usage) continue
		const { turn, step } = event.data
		const sameAttempt = previous?.turn === turn && previous?.step === step
		if (event.type === 'llm/retry-started') {
			if (sameAttempt) previous = undefined
			continue
		}
		// The finalized sample replaces an earlier report for the same attempt. A retry starts a new billed attempt.
		const tokens = event.time >= start && event.time < end ? tokenSum(usage) : 0
		total += tokens - (sameAttempt ? previous.tokens : 0)
		previous = { turn, step, tokens }
	}
	return total
}

/** Day totals are computed on the host and cached by the source snapshot revision. */
export class TodayTokenUsage {
	constructor(ctx) {
		this.ctx = ctx
		this.controller = new AbortController()
	}

	async read(args) {
		const now = Date.now()
		const window = dayWindow(args, now)
		if (this.pending) {
			if (window.start === this.cached.start && window.end === this.cached.end) return this.pending
			throw unavailable()
		}
		if (window.start !== this.cached?.start || window.end !== this.cached?.end) {
			this.cached = { ...window, cold: new Map(), live: new WeakMap() }
		}
		const cache = this.cached
		const age = now - cache.readAt
		if (age >= 0 && age < FRESHNESS) return cache.value
		this.pending = this.refresh(cache).then(totalTokens => {
			cache.value = { totalTokens }
			cache.readAt = Date.now()
			return cache.value
		}).finally(() => { this.pending = undefined })
		return this.pending
	}

	async refresh(cache) {
		const signal = this.controller.signal
		const query = this.ctx.get('sessionQuery')
		const persistence = this.ctx.get('sessionPersistence')
		const sessions = this.ctx.get('sessions')
		if (!query?.observeSession || (!persistence?.listSnapshots && !persistence?.list) || !sessions?.list) throw unavailable()
		try {
			const stored = typeof persistence.listSnapshots === 'function'
				? await persistence.listSnapshots(signal)
				: await persistence.list({ signal })
			const candidates = new Map(stored.map(snapshot => [snapshot.header.id, { snapshot }]))
			for (const live of sessions.list()) candidates.set(live.id, { live })
			const cold = new Map()
			let total = 0
			// Keep cold reads sequential, so only one additional decoded journal is retained here at a time.
			for (const [id, { snapshot, live }] of candidates) {
				signal.throwIfAborted()
				const seq = live?.seq
				const prior = live ? cache.live.get(live) : cache.cold.get(id)
				if (prior && (live ? prior.revision === seq : prior.revision === snapshot.revision)) {
					total += prior.tokens
					if (!live) cold.set(id, prior)
					continue
				}
				try {
					const observation = await query.observeSession(id, { signal, projectionMode: 'none' })
					try {
						const tokens = usageInWindow(observation, cache)
						total += tokens
						if (observation.source === 'prepared' && observation.revision !== undefined) {
							cold.set(id, { revision: observation.revision, tokens })
						} else if (live && observation.source === 'live' && observation.cursor === seq - 1) {
							cache.live.set(live, { revision: seq, tokens })
						}
					} finally {
						observation[Symbol.dispose]()
					}
				} catch (error) {
					if (error?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
				}
			}
			if (!Number.isSafeInteger(total) || total < 0) throw unavailable()
			cache.cold = cold
			return total
		} catch {
			throw unavailable()
		}
	}

	close() {
		this.controller.abort()
	}
}
