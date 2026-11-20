import { createHash } from 'node:crypto'

export async function readSessionSummaries(readList, knownRevision) {
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
	const revision = createHash('sha256').update(JSON.stringify(summaries)).digest('base64url')
	return revision === knownRevision ? { revision } : { revision, items: summaries }
}
