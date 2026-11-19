import { randomUUID } from 'node:crypto'

const ENDPOINT = '$events/result'

function bridgeError(code, message) {
	return Object.assign(new Error(message), { code })
}

async function sendOutcome(connection, peer, clientId, eventId, outcome, signal) {
	const request = new Request(`http://narwal.local/api/${ENDPOINT}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: ENDPOINT, payload: { clientId, eventId, outcome } }),
		signal,
	})
	const response = await connection.fetch(request, peer)
	if (!response.ok) throw bridgeError('narwal/question-response', '桌面端未能接收回答')
	const { result } = await response.json()
	if (!result?.ok) throw bridgeError(result?.error?.code ?? 'narwal/question-response', result?.error?.message ?? '桌面端未能接收回答')
}

function validateAnswer(questions, answer) {
	if (!Array.isArray(answer?.answers) || answer.answers.length !== questions.length) return false
	const byId = new Map(answer.answers.map(item => [item?.id, item]))
	return questions.every(question => {
		const item = byId.get(question.id)
		if (!Array.isArray(item?.selected) || new Set(item.selected).size !== item.selected.length) return false
		if (item.custom !== undefined && (typeof item.custom !== 'string' || item.custom.trim() === '' || item.custom.length > 8000)) return false
		if (!question.multiSelect && item.selected.length + Number(item.custom !== undefined) > 1) return false
		return item.selected.every(label => question.options?.some(option => option.label === label))
	})
}

export function openQuestionEvents(gateway, connection, device) {
	if (!device.peer || device.tokenId === 'relay' || !gateway?.wireStream?.open || !connection?.fetch) {
		throw bridgeError('narwal/questions-unavailable', '当前连接不支持实时 Agent 提问')
	}
	if (device.userQuestions) throw bridgeError('narwal/question-stream-exists', '提问订阅已打开')
	const controller = new AbortController()
	const pending = new Map()
	let clientId
	const subscriptions = {
		async answer(eventId, answer) {
			const row = pending.get(eventId)
			if (!clientId || !row || row.submitting) return false
			if (!validateAnswer(row.questions, answer)) throw bridgeError('narwal/question-answer-invalid', '回答与原问题不匹配')
			row.submitting = true
			try {
				const value = { answers: answer.answers.map(({ id, selected, custom }) => ({ id, selected, custom })) }
				await sendOutcome(connection, device.peer, clientId, eventId, { kind: 'result', value }, controller.signal)
				pending.delete(eventId)
				return true
			} finally {
				row.submitting = false
			}
		},
	}
	device.userQuestions = subscriptions
	function dispose() {
		if (device.userQuestions === subscriptions) device.userQuestions = undefined
		pending.clear()
		controller.abort()
	}
	return {
		dispose,
		async *[Symbol.asyncIterator]() {
			const noUplink = (async function* () {})()
			try {
				const source = await gateway.wireStream.open('$events', { args: {} }, noUplink, device.peer, controller.signal)
				for await (const frame of source) {
					if (frame.type === 'ready') {
						clientId = frame.clientId
						yield { type: 'ready' }
					} else if (frame.type === 'cancel' && pending.delete(frame.eventId)) {
						yield { type: 'cancel', eventId: frame.eventId }
					} else if (frame.type === 'waterfall' && clientId) {
						const questions = frame.request?.questions
						if (frame.event !== 'user-questions/request' || !Array.isArray(questions)
							|| questions.length === 0 || questions.some(question => question?.intent?.kind === 'approval')) {
							// This connection only answers ordinary Agent questions. Let DSH handle other waterfalls.
							await sendOutcome(connection, device.peer, clientId, frame.eventId, { kind: 'next' }, controller.signal)
							continue
						}
						pending.set(frame.eventId, { questions, submitting: false })
						yield { type: 'question', eventId: frame.eventId, sessionId: frame.agentId, callId: frame.request.wait?.callId, questions }
					}
				}
			} finally {
				dispose()
			}
		},
	}
}

export function answerUserQuestion(device, args) {
	return device.userQuestions?.answer(args.eventId, args.answer) ?? false
}

export function watchPendingQuestions(gateway, notify) {
	let timer
	const read = () => {
		try {
			return new Set(gateway.getPendingRemoteEvents()
				.filter(row => row.event === 'user-questions/request' && typeof row.agentId === 'string')
				.map(row => row.agentId))
		} catch {
			return null
		}
	}
	return (enabled) => {
		if (!enabled) {
			clearInterval(timer)
			timer = undefined
			return
		}
		if (timer || typeof gateway?.getPendingRemoteEvents !== 'function') return
		// Observe the host's outstanding requests without opening an answering waterfall.
		let seen = read()
		timer = setInterval(() => {
			const pending = read()
			if (!pending) return
			if (seen) {
				for (const sessionId of pending) if (!seen.has(sessionId)) notify(sessionId)
			}
			seen = pending
		}, 1000)
		timer.unref()
	}
}
