const MAX_TITLE_LENGTH = 80
const MAX_PREVIEW_LENGTH = 800
const MAX_SOURCE_LENGTH = 2048
const LOCK_SCREEN_TITLE = 72
const LOCK_SCREEN_SUMMARY = 150

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
			const projection = ctx.get('sessionProjections')?.snapshot?.(session, ['title'])
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

export function publicAssistantReply(event) {
	if (event?.type !== 'assistant/message' || event.ignorable || (event.surfaceOp && event.surfaceOp !== 'append') ||
		!Number.isSafeInteger(event.data?.turn)) return undefined
	return { turn: event.data.turn, preview: assistantPreview(event.data) }
}

function lockScreenText(value, limit) {
	if (typeof value !== 'string') return undefined
	return boundedText(value.replace(/[\p{Cc}\p{Cs}\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' '), limit)
}

export function lockScreenTitles(ctx, sessionId, session, projectedTitle) {
	const { workspaceTitle, sessionTitle } = notificationTitles(ctx, sessionId, session)
	const workspace = lockScreenText(workspaceTitle, LOCK_SCREEN_TITLE)
	const title = lockScreenText(projectedTitle ?? sessionTitle, LOCK_SCREEN_TITLE)
	return { ...(workspace ? { workspace } : {}), ...(title ? { title } : {}) }
}

/** Keep the short lock-screen snippet to prose and visible labels. */
export function lockScreenSummary(value) {
	if (typeof value !== 'string') return undefined
	const lines = []
	let fence
	for (const line of value.slice(0, MAX_SOURCE_LENGTH).split(/\r\n?|\n/u)) {
		const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
		if (fence) {
			if (marker?.[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
			continue
		}
		if (marker) { fence = marker[1]; continue }
		if (/^(?: {4}|\t| {0,3}\[[^\]]+\]:)/u.test(line)) continue
		lines.push(line.replace(/^ {0,3}(?:#{1,6}\s+|>+\s*|[-*+]\s+|\d+[.)]\s+)/u, ''))
	}
	const plain = lines.join('\n')
		.replace(/<!--[^]*?(?:-->|$)/gu, ' ')
		.replace(/<(script|style|pre|details)\b[^>]*>[^]*?(?:<\/\1\s*>|$)/giu, ' ')
		.replace(/!?\[([^\[\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu, '$1')
		.replace(/!?\[([^\[\]\n]+)\]\[[^\]\n]*\]/gu, '$1')
		.replace(/<[^<>\n]*>/gu, ' ')
		.replace(/\b(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|www\.)[^\s<>()]+/giu, ' ')
		.replace(/(\*{1,3}|_{1,3}|~~)(\S(?:.*?\S)?)\1/gu, '$2')
		.replace(/`+/gu, '')
	return lockScreenText(plain, LOCK_SCREEN_SUMMARY)
}

/** Plain fields for the opt-in encrypted notification preview. */
export function notificationPreview({ workspaceTitle, sessionTitle, summary }) {
	const title = value => typeof value === 'string'
		? lockScreenText(value.slice(0, MAX_SOURCE_LENGTH), MAX_TITLE_LENGTH) : undefined
	return {
		workspaceTitle: title(workspaceTitle),
		sessionTitle: title(sessionTitle),
		summary: lockScreenSummary(summary),
	}
}

export function taskTurnNotices(ctx, emit) {
	const lastReplies = new WeakMap()
	return (session, event) => {
		if (typeof session?.id !== 'string' || session.header?.origin === 'subagent') return
		if (event?.type === 'assistant/message') {
			const reply = publicAssistantReply(event)
			if (reply?.preview) lastReplies.set(session, reply)
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
