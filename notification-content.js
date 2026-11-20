const MAX_TITLE_LENGTH = 80
const MAX_PREVIEW_LENGTH = 800
const MAX_SOURCE_LENGTH = 2048

function boundedText(value, limit) {
	const text = value.trim()
	if (!text) return undefined
	const characters = Array.from(text)
	return characters.length > limit ? `${characters.slice(0, limit - 1).join('').trimEnd()}…` : text
}

function noticeTitle(value) {
	return typeof value === 'string' ? boundedText(value.slice(0, MAX_SOURCE_LENGTH).replace(/\s+/gu, ' '), MAX_TITLE_LENGTH) : undefined
}

export function notificationTitles(ctx, sessionId, liveSession) {
	let workspaceTitle
	let sessionTitle
	try {
		const workspace = ctx.get('workspaceRegistry')?.list?.()?.find(item => item.sessionIds?.includes(sessionId))
		workspaceTitle = noticeTitle(workspace?.title)
	} catch { /* Older compositions can lack a ready workspace registry. */ }
	try {
		const session = liveSession ?? ctx.get('sessions')?.get?.(sessionId)
		if (session) {
			const projection = ctx.get('sessionProjections')?.cachedSnapshot?.(session, ['title'])
			sessionTitle = noticeTitle(projection?.values?.title)
		}
	} catch { /* A missing title must not prevent the notice. */ }
	return { workspaceTitle, sessionTitle }
}

function assistantPreview(data) {
	if (data.interrupted === true || !Array.isArray(data.message?.content)
		|| data.message.content.some(part => part?.type === 'tool-call')) return undefined
	let text = ''
	for (const part of data.message.content) {
		if (part?.type !== 'text' || typeof part.text !== 'string') continue
		text += part.text.slice(0, MAX_SOURCE_LENGTH - text.length)
		if (text.length === MAX_SOURCE_LENGTH) break
	}
	// Keep line breaks for the phone's Markdown parser.
	return boundedText(text, MAX_PREVIEW_LENGTH)
}

export function taskTurnNotices(ctx, emit) {
	const lastReplies = new WeakMap()
	return (session, event) => {
		if (typeof session?.id !== 'string' || session.header?.origin === 'subagent') return
		if (event?.type === 'assistant/message') {
			if (event.ignorable || (event.surfaceOp && event.surfaceOp !== 'append') || !Number.isSafeInteger(event.data?.turn)) return
			const preview = assistantPreview(event.data)
			if (preview) lastReplies.set(session, { turn: event.data.turn, preview })
			return
		}
		if (event?.type !== 'turn/end') return
		const reply = lastReplies.get(session)
		lastReplies.delete(session)
		const outcome = event.data?.reason?.kind
		if (event.ignorable || (outcome !== 'completed' && outcome !== 'error')) return
		const sequence = event.seq ?? event.data.turn
		if (!Number.isSafeInteger(sequence)) return
		emit({
			kind: outcome === 'completed' ? 'task-complete' : 'task-failed', sessionId: session.id, eventId: String(sequence),
			...notificationTitles(ctx, session.id, session),
			preview: outcome === 'completed' && reply?.turn === event.data.turn ? reply?.preview : undefined,
		})
	}
}

export function sendLegacyNotice(bridge, payload) {
	for (const device of bridge.devices.values()) {
		if (!device.active && device.peer && device.socket !== bridge.relay?.socket && !device.pushLocal) {
			bridge.send(device, { event: 'narwal/notification', payload })
		}
	}
}
