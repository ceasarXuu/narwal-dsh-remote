import { readApiBalances } from './api-balances.js'
import { readGitHubProjects } from './github-projects.js'
import { readSessionSummaries } from './session-summaries.js'
import { sessionControlFilter } from './session-control-filter.js'
import { readWorkspaceExpansion } from './workspace-expansion.js'
import { answerUserQuestion } from './user-questions.js?event-result-args'

function streamLog(event, details) {
	try {
		const line = `${new Date().toISOString()} STREAM ${event} :: ${JSON.stringify(details)}\n`
		import('node:fs').then((fs) => fs.appendFileSync('/tmp/narwal-stream.log', line)).catch(() => {})
	} catch { }
}

export function handleDeviceFrame(bridge, device, text) {
	if (device.disposed) return
	let request
	try {
		request = device.transport ? text : JSON.parse(text)
	} catch {
		bridge.send(device, { event: 'narwal/protocol', payload: 'frame is not JSON' })
		return
	}
	const id = typeof request?.id === 'string' ? request.id : ''
	if (request?.unsubscribe === true && id) {
		if (!device.active) return
		if (!device.transport) streamLog('unsub', { sessionId: device.sessionId, id })
		const task = device.streams.get(id)
		if (task) {
			device.streams.delete(id)
			bridge.disposeStream(device, id, task)
			bridge.send(device, { id, done: true })
		} else if (/^s|^i/.test(id) && typeof request?.id === 'string' && device.pendingUnsub.add(id)) {
			/* runStream 的 subscribe 若在展开中:未登记完成也提前记录,以免泄漏 */
			bridge.send(device, { id, done: true })
		}
		return
	}
	const ns = typeof request?.ns === 'string' ? request.ns : ''
	const method = typeof request?.method === 'string' ? request.method : ''
	if (!id || !ns || !method) {
		bridge.send(device, { event: 'narwal/protocol', payload: 'id/ns/method required' })
		return
	}
	const args = (request?.args && typeof request.args === 'object') ? request.args : {}
	if (ns === 'narwal' && method === 'setActive' && request?.stream !== true) {
		bridge.setDeviceActive(device, id, args.active, args.lazyAvatar === true)
		return
	}
	if (!device.active) {
		bridge.send(device, { id, ok: false, error: { code: 'narwal/device-inactive', message: 'Desktop is not selected' } }, { unary: request?.stream !== true })
		return
	}
	const revision = device.activityRevision
	const sendResult = frame => {
		if (device.activityRevision === revision) bridge.send(device, frame, { unary: true })
	}
	if (request?.stream === true) {
		void runStream(bridge, device, id, ns, method, args, revision)
		return
	}
	if (ns === 'narwal' && method === 'getTrafficUsage') {
		bridge.send(device, { id, ok: true, value: bridge.traffic.snapshot() }, { meter: false, unary: true })
		return
	}
	if (ns === 'narwal' && method === 'getWorkspaceExpansion') {
		sendResult({ id, ok: true, value: readWorkspaceExpansion(bridge) })
		return
	}
	if (ns === 'narwal' && ['getMaid', 'installMaid', 'enableMaid'].includes(method)) {
		if (!device.transport || !device.peer) {
			sendResult({ id, ok: true, value: { kind: 'unavailable' } })
			return
		}
		const installer = bridge.deps.maidInstaller
		const task = method === 'getMaid' ? installer.availability(args.refresh === true) : installer.start(method === 'enableMaid')
		void task.then(value => sendResult({ id, ok: true, value })).catch(() => {
			sendResult({ id, ok: true, value: { kind: 'failed' } })
		})
		return
	}
	if (ns === 'narwal' && method === 'getDesktopAvatar') {
		if (!device.peer || device.transport === 'relay' || device.socket === bridge.relay?.socket) {
			sendResult({ id, ok: true, value: { avatar: null } })
			return
		}
		const { avatar } = bridge.account
		const { avatarVersion } = bridge.lazyAvatarAccount
		sendResult({ id, ok: true, value: { avatar, avatarVersion } })
		return
	}
	if (ns === 'narwal' && method === 'getApiBalances') {
		// Local provider account metadata is available only on the direct connection.
		if (!device.peer || device.transport === 'relay' || device.socket === bridge.relay?.socket) {
			sendResult({ id, ok: true, value: { status: 'unsupported' } })
			return
		}
		void readApiBalances(bridge.ctx).then((value) => sendResult({ id, ok: true, value }))
		return
	}
	if (ns === 'narwal' && ['getGitHubProjects', 'installGitHubProjects', 'enableGitHubProjects'].includes(method)) {
		const reply = (value) => sendResult({ id, ok: true, value })
		if (!device.peer || device.transport === 'relay' || device.tokenId === 'relay') {
			reply({ kind: 'unavailable' })
			return
		}
		const installer = bridge.deps.githubProjectsInstaller
		if (method !== 'getGitHubProjects') {
			reply(installer.start(method === 'installGitHubProjects' ? 'install' : 'enable'))
			return
		}
		void readGitHubProjects(bridge.ctx.get('webServer'), installer, args).then(reply).catch((error) => {
			sendResult({ id, ok: false, error: { code: error.code, message: error.message, details: error.details } })
		})
		return
	}
	let result
	if (ns === 'narwal' && method === 'answerUserQuestion') {
		result = Promise.resolve().then(() => answerUserQuestion(device, args))
	} else if (ns === 'narwal' && method === 'getSessionSummaries') {
		const readList = () => bridge.deps.invoke({ namespace: 'session', method: 'list', args: { _request: {} }, peer: device.peer })
		result = readSessionSummaries(readList, args.knownRevision)
	} else if (ns === 'narwal' && method === 'getSessionCursor') {
		result = bridge.deps.invoke({ namespace: 'session', method: 'projections', args, peer: device.peer })
			.then(baseline => ({ kind: baseline?.kind, asOfSeq: baseline?.asOfSeq }))
	} else {
		result = bridge.deps.invoke({ namespace: ns, method, args, peer: device.peer })
	}
	void result.then((value) => {
		sendResult({ id, ok: true, value })
	}).catch((error) => {
		sendResult({
			id,
			ok: false,
			error: {
				code: error?.code ?? 'narwal/bridge',
				message: error?.message ?? String(error),
				details: error?.details ?? {},
			},
		})
	})
}

async function runStream(bridge, device, id, ns, method, args, revision) {
	if (typeof bridge.deps?.stream !== 'function') {
		bridge.send(device, { id, ok: false, error: { code: 'narwal/bridge', message: 'stream() bridge not wired' } })
		return
	}
	if (device.streams.has(id)) {
		bridge.send(device, { id, ok: false, error: { code: 'narwal/protocol', message: 'duplicate stream id' } })
		return
	}
	let handle = null
	const { narwalFilter, ...hostArgs } = args
	const filter = ns === 'session' && method === 'control' ? sessionControlFilter(narwalFilter) : undefined
	try {
		handle = ns === 'narwal' && method === 'userQuestionEvents'
			? bridge.deps.openQuestionEvents(device)
			: await bridge.deps.stream({ namespace: ns, method, args: filter ? hostArgs : args, peer: device.peer })
	} catch (error) {
		if (device.activityRevision !== revision) return
		bridge.send(device, {
			id,
			ok: false,
			error: {
				code: error?.code ?? 'narwal/bridge',
				message: error?.message ?? String(error),
				details: error?.details ?? {},
			},
		})
		return
	}
	const iterator = handle?.[Symbol.asyncIterator]?.()
	if (device.disposed || device.activityRevision !== revision) {
		bridge.disposeStream(device, id, { iterator, handle })
		return
	}
	if (!iterator) {
		bridge.send(device, { id, ok: false, error: { code: 'narwal/bridge', message: 'stream method returned no async iterator' } })
		try { handle?.dispose?.() } catch { }
		return
	}
	if (!device.transport) streamLog('runStream', { sessionId: device.sessionId, id, ns, method })
	const task = { iterator, handle }
	device.streams.set(id, task)
	if (device.pendingUnsub.has(id)) {
		device.pendingUnsub.delete(id)
		device.streams.delete(id)
		bridge.disposeStream(device, id, task)
		bridge.send(device, { id, done: true })
		return
	}
	void (async () => {
		try {
			while (true) {
				const next = await iterator.next()
				if (bridge.devices.get(device.sessionId) !== device) return
				if (device.streams.get(id) !== task) return
				if (next?.done) {
					device.streams.delete(id)
					bridge.send(device, { id, done: true })
					return
				}
				const item = filter ? filter(next?.value) : next?.value
				if (item !== undefined) bridge.send(device, { id, item })
			}
		} catch (error) {
			if (device.streams.get(id) !== task) return
			device.streams.delete(id)
			bridge.send(device, {
				id,
				ok: false,
				error: {
					code: error?.code ?? 'narwal/stream',
					message: error?.message ?? String(error),
					details: error?.details ?? {},
				},
			})
		} finally {
			try { handle?.dispose?.() } catch { /* nop */ }
		}
	})()
}
