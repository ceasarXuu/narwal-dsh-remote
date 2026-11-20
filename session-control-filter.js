export function sessionControlFilter(selection) {
	const sessionId = typeof selection?.sessionId === 'string' ? selection.sessionId : undefined
	const keys = Array.isArray(selection?.keys) ? new Set(selection.keys.filter(key => typeof key === 'string')) : undefined
	if (!sessionId && !keys?.size) return

	return item => {
		if (item?.type === 'baseline') {
			const blocks = item.value.projections
			const ids = sessionId ? [sessionId] : Object.keys(blocks)
			const projections = Object.create(null)
			for (const id of ids) {
				if (!Object.hasOwn(blocks, id)) continue
				const block = blocks[id]
				const values = keys ? Object.fromEntries(Object.entries(block.values).filter(([key]) => keys.has(key))) : block.values
				if (Object.keys(values).length) projections[id] = { ...block, values }
			}
			return { ...item, value: { ...item.value, projections } }
		}
		if (item?.type !== 'projection' || (sessionId && item.sessionId !== sessionId)) return
		if (!keys) return item
		if (Array.isArray(item.changes)) {
			const changes = item.changes.filter(change => keys.has(change.key))
			if (changes.length) return { ...item, changes }
		} else if (keys.has(item.key)) {
			return item
		}
	}
}
