const replyTypes = new Set(['text', 'image', 'file'])
const turnEvents = new Set(['turn/start', 'turn/end', 'step/start', 'step/end', 'llm/retry', 'llm/retry-started'])
const questionTool = 'ask_user_question'
const maxToolSummary = 180

function visibleChunk(chunk) {
	if (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta') return true
	return chunk?.type === 'block-start' && ['text', 'reasoning'].includes(chunk.blockType)
		|| chunk?.type === 'block-end' && ['text', 'reasoning'].includes(chunk.block?.type)
}

export function transcriptRequest(args, modes) {
	const { narwalTranscript, ...hostArgs } = args
	return modes.includes(narwalTranscript?.mode) ? { selection: narwalTranscript, hostArgs } : undefined
}

function withData(record, data, type = record.event.type) {
	const { seq, time, ignorable, surfaceOp } = record.event
	return { type: record.type, event: { type, seq, time, ignorable, surfaceOp, data } }
}

function usageOf(data) {
	if (data.usage) return data.usage
	const record = data.stream?.findLast?.(entry => (entry?.chunk ?? entry)?.type === 'usage')
	return (record?.chunk ?? record)?.usage
}

function assistantMessage(record, mode) {
	const data = record.event.data
	const { turn, step, interrupted, message } = data
	const content = Array.isArray(message?.content) ? message.content : []
	const intermediate = content.some(part => part?.type === 'tool-call')
		|| Boolean(record.event.surfaceOp && record.event.surfaceOp !== 'append')
	let parts
	if (mode === 'process') {
		parts = content.filter(part => part?.type === 'reasoning' || (intermediate && part?.type === 'text'))
		if (!parts.length) return
	} else {
		parts = content.filter(part => {
			if (mode === 'live') return replyTypes.has(part?.type) || part?.type === 'reasoning'
			return !intermediate && replyTypes.has(part?.type)
		})
	}
	const { provider, model } = message?.source ?? {}
	const result = withData(record, {
		turn, step, interrupted, usage: usageOf(data),
		message: { id: message?.id, source: { provider, model }, content: parts },
	})
	return mode === 'live' && intermediate ? { ...result, processOnly: true } : result
}

function json(text) {
	if (typeof text !== 'string' || text.length > 64 * 1024) return
	try { return JSON.parse(text) } catch { /* Invalid tool content is not displayable. */ }
}

function questionCall(data) {
	if (data.name !== questionTool) return
	const args = typeof data.arguments === 'string' ? json(data.arguments) : data.arguments
	if (!Array.isArray(args?.questions)) return
	const questions = args.questions.map(question => ({
		id: question?.id, question: question?.question, header: question?.header,
		intent: question?.intent ? { kind: question.intent.kind } : undefined,
	}))
	return JSON.stringify({ questions })
}

function questionResult(data, native) {
	const result = native ? data.message : data
	const parts = result?.content
	if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.type !== 'text') return
	const payload = json(parts[0].text)
	if (!Array.isArray(payload?.answers) || payload.pending === true || result.isError === true) return
	const answers = payload.answers
	if (!answers.every(answer => typeof answer?.id === 'string' && Array.isArray(answer.selected)
		&& answer.selected.every(value => typeof value === 'string') && (answer.custom === undefined || typeof answer.custom === 'string'))) return
	const content = [{ type: 'text', text: JSON.stringify({ answers: answers.map(({ id, selected, custom }) => ({ id, selected, custom })) }) }]
	return native ? { message: { source: { callId: result.source?.callId }, content } } : { content }
}

function recordQuestionCall(record, calls) {
	const { event } = record
	if (event?.type === 'tool/call' && event.data?.name === questionTool && typeof event.data.callId === 'string') {
		calls.add(event.data.callId)
	}
}

function questionCallsIn(records) {
	const calls = new Set()
	for (const record of records) recordQuestionCall(record, calls)
	return calls
}

function toolRecord(record, mode, questionCalls) {
	const { type, data } = record.event
	const { turn, step } = data
	const native = type === 'tool/call' || type === 'tool/result'
	const call = type === 'tool/call' || type === 'tool/ptc-dispatch-start'
	const callId = data.message?.source?.callId ?? data.callId
	const isQuestion = native && !call ? questionCalls?.has(callId) : data.name === questionTool
	if (mode === 'summary' || !native) {
		let detail
		if (isQuestion) detail = call ? { arguments: questionCall(data) } : questionResult(data, native)
		return { ...withData(record, { turn, step, callId: data.callId, subCallId: data.subCallId, name: detail && data.name, ...detail }), processHidden: true }
	}
	if (call) {
		const args = json(data.arguments)
		const summary = args?.description || args?.command || (args === undefined ? data.arguments : '')
		const preview = typeof summary === 'string' ? summary.slice(0, maxToolSummary) : ''
		return withData(record, {
			turn, step, callId: data.callId, name: data.name,
			arguments: mode === 'live' && data.name === questionTool ? questionCall(data) : JSON.stringify({ description: preview }),
		})
	}
	const error = typeof data.error === 'string' ? data.error : data.error?.message ?? data.error?.code
	return withData(record, {
		turn, step, callId: data.callId ?? data.message?.source?.callId,
		isError: data.message?.isError === true || data.isError === true || data.error != null,
		error: typeof error === 'string' ? error.slice(0, maxToolSummary) : undefined,
		...(mode === 'live' && isQuestion ? questionResult(data, true) : undefined),
	})
}

function projectRecord(record, mode, questionCalls) {
	const { type, seq, data = {} } = record.event ?? {}
	if (mode === 'process') {
		if (type === 'assistant/message') return assistantMessage(record, mode)
		if (type === 'tool/call' || type === 'tool/result') return toolRecord(record, mode)
		return
	}
	if (type === 'assistant/message') return assistantMessage(record, mode)
	if (type === 'assistant/attempt') return withData(record, { turn: data.turn, step: data.step, usage: usageOf(data) })
	if (type === 'deliverables/presented') return record
	if (type === 'user/message' && ['user', 'user-question-reply'].includes(data.source?.kind)) return record
	if (type === 'agent/inbox/spliced') return withData(record, { inserted: promptSources(data.inserted) })
	if (type === 'tool/call' || type === 'tool/result' || type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch') {
		return toolRecord(record, mode, questionCalls) ?? { type: 'event', event: { seq } }
	}
	if (turnEvents.has(type)) {
		const { turn, step, reason } = data
		const result = withData(record, { turn, step, reason: reason && { kind: reason.kind } })
		return type === 'turn/end' && mode === 'summary' ? { ...result, processTurn: turn } : result
	}
	if (type === 'request/context' || type === 'request/header') {
		const { provider, model } = (type === 'request/header' ? data.header?.config : data) ?? {}
		return withData(record, type === 'request/header' ? { header: { config: { provider, model } } } : { provider, model })
	}
	// Keep the host's dense sequence and cursor while omitting unrelated event data.
	return { type: 'event', event: { seq } }
}

function promptSources(messages) {
	return Array.isArray(messages) ? messages.flatMap(message => (
		message?.source?.kind === 'user' ? [{ source: { kind: 'user', rpcId: message.source.rpcId } }] : []
	)) : undefined
}

export function projectTranscriptPage(page, { mode, turn }) {
	if (!Array.isArray(page?.records)) return page
	if (mode !== 'process') {
		const questionCalls = questionCallsIn(page.records)
		return { ...page, records: page.records.map(record => projectRecord(record, 'summary', questionCalls)) }
	}
	const nextBeforeSeq = page.records[0]?.event?.seq
	const records = []
	let reachedStart = false
	for (const record of page.records) {
		const event = record.event
		if (event?.data?.turn !== turn) continue
		if (event.type === 'turn/start') reachedStart = true
		const projected = projectRecord(record, mode)
		if (projected) records.push(projected)
	}
	return { records, nextBeforeSeq, hasMore: page.hasMore === true && !reachedStart }
}

export function transcriptFollower({ mode, resumeTurn }) {
	let detailedTurn
	let detailedAttempt
	let questionCalls = new Set()
	return item => {
		if (!item) return
		if (item?.type === 'snapshot') {
			const { records = [], assistantStream, projections } = item
			const boundary = records.findLast(record => record.event?.type === 'turn/start' || record.event?.type === 'turn/end')?.event
			detailedTurn = mode === 'live' && Number.isSafeInteger(resumeTurn) && boundary?.type !== 'turn/end'
				&& (boundary?.data?.turn ?? assistantStream?.activeAttempt?.turn) === resumeTurn ? resumeTurn : undefined
			const activeAttempt = detailedTurn !== undefined && assistantStream?.activeAttempt?.turn === detailedTurn
				? assistantStream.activeAttempt : undefined
			detailedAttempt = activeAttempt?.attemptId
			questionCalls = questionCallsIn(records)
			const { title, inbox } = projections?.values ?? {}
			return {
				...item,
				records: records.map(record => projectRecord(record,
					detailedTurn !== undefined && record.event?.data?.turn === detailedTurn ? 'live' : 'summary', questionCalls)),
				assistantStream: activeAttempt ? { ...assistantStream, activeAttempt: {
					...activeAttempt,
					stream: activeAttempt.stream?.filter(entry => entry?.type === 'text-chunks' || entry?.type === 'reasoning-chunks'
						|| visibleChunk(entry?.chunk ?? entry)),
				} } : undefined,
				projections: { asOfSeq: projections?.asOfSeq, values: {
					title, inbox: { 'next-turn': promptSources(inbox?.['next-turn']), 'next-step': promptSources(inbox?.['next-step']) },
				} },
			}
		}
		if (item.type === 'assistant-stream') {
			const frame = item.frame
			if (!frame) return
			if (frame.type === 'start') {
				detailedAttempt = detailedTurn !== undefined && frame.turn === detailedTurn ? frame.attemptId : undefined
				return detailedAttempt === undefined ? undefined : item
			}
			if (detailedAttempt === undefined || frame.attemptId !== detailedAttempt) return
			if (frame.type === 'end') {
				detailedAttempt = undefined
				return item
			}
			if (frame.type === 'chunk' && visibleChunk(frame.chunk)) return item
			return
		}
		const { type, data } = item?.event ?? {}
		if (type === 'turn/start') detailedTurn = mode === 'live' ? data?.turn : undefined
		const isDetailed = detailedTurn !== undefined && data?.turn === detailedTurn
		recordQuestionCall(item, questionCalls)
		const result = projectRecord(item, isDetailed ? 'live' : 'summary', questionCalls)
		if (type === 'turn/end') {
			questionCalls.clear()
			detailedTurn = undefined
			detailedAttempt = undefined
		}
		return type === 'turn/start' && isDetailed ? { ...result, processLive: true } : result
	}
}
