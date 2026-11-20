const MAX_ACTIVITY_AGE = 8 * 60 * 60_000
const RECOVERY_INTERVAL = 15_000
const REFRESH_INTERVAL = 5 * 60_000
const CHANGE_DELAY = 350
const MAX_PENDING = 999
const ACTIVITY_ID = /^[a-f0-9]{32}$/
const TOKEN = /^(?:[a-f0-9]{2}){16,128}$/
const LANGUAGES = new Set(['zh', 'en', 'ja', 'ko'])
const DROPPED = new Set([400, 401, 403, 404, 409, 410])
const TERMINAL = new Set(['completed', 'failed', 'stopped'])

export const LIVE_ACTIVITY_METHODS = new Set(['getLiveActivityStatus', 'trackLiveActivity', 'stopLiveActivity'])

function validSession(id) {
	return typeof id === 'string' && id.length > 0 && id.length <= 512
}

function isActive(status) {
	return status?.state === 'running' || status?.state === 'waiting'
}

function safeQuestionCount(questions) {
	return Array.isArray(questions) && questions.every(item => item && typeof item.id === 'string'
		&& typeof item.question === 'string' && item.intent?.kind !== 'approval') ? questions.length : 0
}

function pendingQuestions(values, currentRequests) {
	const answered = new Set()
	for (const target of ['next-step', 'next-turn']) {
		for (const message of values?.inbox?.[target] ?? []) {
			const source = message?.source
			if (source?.kind === 'user-question-reply' && typeof source.callId === 'string') answered.add(source.callId)
		}
	}
	const pending = new Map()
	for (const item of values?.userQuestions?.active ?? []) {
		if (typeof item?.callId === 'string' && (item.state === 'open' || item.state === 'continued')
			&& !answered.has(item.callId)) pending.set(item.callId, safeQuestionCount(item.questions))
	}
	for (const request of currentRequests ?? []) {
		const callId = request.wait?.callId
		if (request.signal?.aborted || answered.has(callId)) continue
		const key = callId ?? request
		if (!pending.has(key)) pending.set(key, safeQuestionCount(request.questions))
	}
	let count = 0
	for (const value of pending.values()) count += value
	return Math.min(count, MAX_PENDING)
}

function terminalState(event) {
	const reason = event?.type === 'turn/end' ? event.data?.reason?.kind : undefined
	if (reason === 'completed') return 'completed'
	if (reason === 'error' || reason === 'blocked' || reason === 'max-tokens') return 'failed'
	return 'stopped'
}

/** Reads the host's current Agent and question projection, also for a detached session. */
async function readStatus(ctx, sessionId, requests, signal, ending) {
	let observation
	try {
		const workspace = ctx.get('workspaceRegistry')
		if (workspace?.archivedSessionIds?.includes(sessionId)) return { state: 'stopped', pending: 0 }

		const sessions = ctx.get('sessions')
		const agents = ctx.get('agents')
		const projections = ctx.get('sessionProjections')
		const query = ctx.get('sessionQuery')
		const session = sessions?.get(sessionId)
		let values
		if (session && typeof projections?.snapshot === 'function') {
			values = projections.snapshot(session, ['userQuestions', 'inbox']).values
		} else if (typeof query?.observeSession === 'function') {
			observation = await query.observeSession(sessionId, { signal, projectionMode: 'all' })
			values = observation?.projections?.values
		} else {
			return
		}

		const pending = pendingQuestions(values, requests)
		if (pending > 0) return { state: 'waiting', pending }
		if (agents?.get(sessionId)?.status === 'running') return { state: 'running', pending: 0 }
		if (!ending) return { state: 'stopped', pending: 0 }
		if (ending !== true) return { state: ending, pending: 0 }
		if (!observation && typeof query?.observeSession === 'function') {
			observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
		}
		const turn = observation?.events?.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
		return { state: terminalState(turn), pending: 0 }
	} catch (error) {
		if (error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return { state: 'stopped', pending: 0 }
	} finally {
		observation?.[Symbol.dispose]?.()
	}
}

export class LiveActivities {
	constructor(ctx, { binding, bindings, set, paired, provision, request }) {
		this.ctx = ctx
		this.binding = binding
		this.bindings = bindings
		this.set = set
		this.paired = paired
		this.provision = provision
		this.request = request
		this.watches = new Map()
		this.requests = new Map()
		this.operations = new Map()
		this.controller = new AbortController()
	}

	get enabled() {
		try {
			return typeof this.ctx?.get?.('sessions')?.get === 'function' && typeof this.ctx?.get?.('agents')?.get === 'function'
				&& (typeof this.ctx?.get?.('sessionProjections')?.snapshot === 'function'
					|| typeof this.ctx?.get?.('sessionQuery')?.observeSession === 'function')
		} catch {
			return false
		}
	}

	isClosed() { return this.controller.signal.aborted }

	status(sessionId, ending = false) {
		const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(4_000)])
		return readStatus(this.ctx, sessionId, this.requests.get(sessionId), signal, ending)
	}

	handle(id, active, method, args) {
		if (!this.enabled || this.isClosed()) return false
		const { activityId, sessionId, token, version, language } = args
		if (method === 'getLiveActivityStatus') {
			if (!active || !validSession(sessionId)) return false
			return this.status(sessionId).then(status => isActive(status) ? status : false)
		}
		if (typeof activityId !== 'string' || !ACTIVITY_ID.test(activityId)) return false
		if (method === 'stopLiveActivity') return this.serial(id, () => this.stop(id, activityId))
		if (!validSession(sessionId) || typeof token !== 'string' || !TOKEN.test(token)
			|| !Number.isSafeInteger(version) || version < 1 || !LANGUAGES.has(language)) return false
		return this.serial(id, () => this.track(id, active, { activityId, sessionId, token, version, language }))
	}

	serial(id, operation) {
		const previous = this.operations.get(id) ?? Promise.resolve()
		const next = previous.then(operation).catch(() => false)
		this.operations.set(id, next)
		return next.finally(() => { if (this.operations.get(id) === next) this.operations.delete(id) })
	}

	async track(id, active, { activityId, sessionId, token, version, language }) {
		if (this.isClosed() || !this.paired(id)) return false
		const previous = this.binding(id)?.activity
		const sameActivity = previous?.activityId === activityId
		if (sameActivity && (previous.sessionId !== sessionId || previous.version > version || previous.expiresAt <= Date.now())) return false
		if (!sameActivity && !active) return false
		const initial = await this.status(sessionId)
		if (!sameActivity && !isActive(initial)) return false
		if (!sameActivity && !await this.provision(id)) return false
		if (this.isClosed() || !this.paired(id)) return false
		const accepted = await this.request(id, '/activity', 'PUT', 'phone', { activityId, token, version, language }, this.controller.signal)
		if (accepted !== 204 || this.isClosed() || !this.paired(id)) return false
		const watch = sameActivity && previous.version === version
			? previous : { activityId, sessionId, version, expiresAt: sameActivity ? previous.expiresAt : Date.now() + MAX_ACTIVITY_AGE }
		this.set(id, watch)
		this.schedule(id, watch)
		this.recover()
		const current = await this.status(sessionId)
		if (this.isClosed() || !this.paired(id)) return false
		return isActive(current) ? current : false
	}

	async stop(id, activityId) {
		if (this.isClosed() || !this.paired(id)) return false
		if (!this.binding(id)) return true
		if (this.binding(id)?.activity?.activityId === activityId) this.clear(id)
		const accepted = await this.request(id, '/activity/' + activityId, 'DELETE', 'phone', undefined, this.controller.signal)
		return accepted === 204 || accepted === 404 || accepted === 409 || accepted === 410
	}

	clear(id) {
		this.set(id, undefined)
		this.forget(id)
	}

	forget(id) {
		clearTimeout(this.watches.get(id)?.timer)
		this.watches.delete(id)
		this.recover()
	}

	close() {
		this.controller.abort()
		clearInterval(this.heartbeat)
		for (const entry of this.watches.values()) clearTimeout(entry.timer)
		this.watches.clear()
		this.requests.clear()
	}

	install(listen) {
		if (!this.enabled) return
		const options = { global: true }
		listen('agent/status', ({ agent }) => this.changed(agent?.id), options)
		listen('api-session/removed', sessionId => this.changed(sessionId), options)
		listen('session/event', (session, event) => {
			const type = event?.type
			if (type === 'turn/start') this.changed(session.id, true)
			else if (type === 'turn/end') this.changed(session.id, terminalState(event))
			else if (type === 'agent/inbox/spliced' || type?.startsWith('user-question')) this.changed(session.id)
		}, options)
		listen('user-questions/request', async (request, next) => {
			const sessionId = request.agent?.session?.id
			if (!validSession(sessionId) || !safeQuestionCount(request.questions)) return next()
			let current = this.requests.get(sessionId)
			if (!current) this.requests.set(sessionId, current = new Set())
			current.add(request)
			this.changed(sessionId)
			try { return await next() } finally {
				current.delete(request)
				if (!current.size) this.requests.delete(sessionId)
				this.changed(sessionId)
			}
		}, { ...options, prepend: true })
		this.changed()
		this.recover()
	}

	recover() {
		const watching = !this.isClosed() && [...this.bindings()].some(([, binding]) => binding.activity != null)
		if (watching && !this.heartbeat) {
			this.heartbeat = setInterval(() => this.changed(), RECOVERY_INTERVAL)
			this.heartbeat.unref()
		} else if (!watching && this.heartbeat) {
			clearInterval(this.heartbeat)
			this.heartbeat = undefined
		}
	}

	changed(sessionId, ending) {
		if (this.isClosed()) return
		for (const [id, { activity, revoked }] of this.bindings()) {
			if (!activity || (sessionId !== undefined && activity.sessionId !== sessionId)) continue
			if (revoked || !this.paired(id) || typeof activity.activityId !== 'string' || !ACTIVITY_ID.test(activity.activityId)
				|| !validSession(activity.sessionId) || !Number.isSafeInteger(activity.expiresAt) || activity.expiresAt <= Date.now()) this.clear(id)
			else this.schedule(id, activity, ending)
		}
	}

	schedule(id, activity, ending) {
		if (this.isClosed()) return
		let entry = this.watches.get(id)
		if (entry?.activity !== activity) {
			clearTimeout(entry?.timer)
			entry = { activity, failures: 0, when: 0, ending: true }
			this.watches.set(id, entry)
		}
		if (ending !== undefined) entry.ending = ending
		if (entry.inFlight) { entry.changed = true; return }
		if (entry.timer) return
		entry.timer = setTimeout(() => {
			entry.timer = undefined
			entry.inFlight = true
			void this.refresh(id, entry).catch(() => {}).finally(() => {
				entry.inFlight = false
				if (entry.changed && this.watches.get(id) === entry) {
					entry.changed = false
					this.schedule(id, activity)
				}
			})
		}, CHANGE_DELAY)
		entry.timer.unref()
	}

	current(id, entry) {
		return !this.isClosed() && this.watches.get(id) === entry && this.binding(id)?.activity === entry.activity
			&& this.paired(id) && entry.activity.expiresAt > Date.now()
	}

	async refresh(id, entry) {
		if (!this.current(id, entry)) return
		const observedEnding = entry.ending
		const status = await this.status(entry.activity.sessionId, observedEnding)
		if (!status || !this.current(id, entry)) return
		if (observedEnding !== entry.ending) return
		const key = status.state + ':' + status.pending
		const time = Date.now()
		if (key !== entry.key) {
			entry.key = key
			entry.failures = 0
			entry.when = 0
		}
		if (entry.when > time) return
		let accepted
		try {
			accepted = await this.request(id, '/activity/deliveries', 'POST', 'desktop', {
				activityId: entry.activity.activityId, ...status,
			}, this.controller.signal)
		} catch { /* Reconcile the newest state on a later heartbeat. */ }
		if (!this.current(id, entry)) return
		if (DROPPED.has(accepted) || (accepted === 204 && TERMINAL.has(status.state))) {
			this.clear(id)
			return
		}
		if (accepted === 204) {
			entry.failures = 0
			entry.when = Date.now() + REFRESH_INTERVAL
			return
		}
		entry.failures += 1
		entry.when = Date.now() + Math.min(60_000, 1_000 * 2 ** Math.min(entry.failures - 1, 6))
	}
}
