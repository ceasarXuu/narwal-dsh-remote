import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

const SHAPE_FIELDS = new Set([
	'sessionId', 'parentSessionId', 'updatedAt', 'running', 'blank', 'cwd', 'projections', 'values', 'title', 'tokenUsage',
	'uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
])
const MAX_SHAPE_BYTES = 256 * 1024

export async function readSessionSummaries(readList, knownRevision, gzipShape = false) {
	const { items } = await readList()
	const summaries = items.map(item => {
		const values = item.projections?.values
		const usage = values?.tokenUsage
		return {
			sessionId: item.sessionId,
			parentSessionId: item.parentSessionId,
			updatedAt: item.updatedAt,
			running: item.running,
			blank: item.blank,
			cwd: item.cwd,
			projections: { values: {
				title: values?.title,
				tokenUsage: usage && {
					uncachedInputTokens: usage.uncachedInputTokens,
					cacheReadTokens: usage.cacheReadTokens,
					cacheWriteTokens: usage.cacheWriteTokens,
					outputTokens: usage.outputTokens,
				},
			} },
		}
	})
	const json = JSON.stringify(summaries)
	const revision = createHash('sha256').update(json).digest('base64url')
	if (revision === knownRevision) return { revision }
	const raw = { revision, items: summaries }
	return gzipShape && json.length >= 1024 ? packShape(raw, json) : raw
}

function packShape(raw, json) {
	const values = []
	let knownFields = true
	const shape = JSON.stringify(raw.items, (field, value) => {
		if (value === undefined) return value
		if (value !== null && typeof value === 'object') {
			if (!Array.isArray(value)) knownFields &&= Object.keys(value).every(key => SHAPE_FIELDS.has(key))
			return value
		}
		// Keep every scalar out of the compressor, including titles, paths and identifiers.
		values.push(value)
		return 0
	})
	const shapeBytes = Buffer.byteLength(shape)
	if (!knownFields || shapeBytes > MAX_SHAPE_BYTES) return raw
	const packed = { revision: raw.revision, gzipShape: gzipSync(shape, { level: 1 }).toString('base64'), shapeBytes, values }
	const rawBytes = Buffer.byteLength(json) + Buffer.byteLength(JSON.stringify({ revision: raw.revision, items: [] })) - 2
	return Buffer.byteLength(JSON.stringify(packed)) <= rawBytes * .8 ? packed : raw
}
