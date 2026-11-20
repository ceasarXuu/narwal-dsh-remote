export const MAID_COMPANION_METHODS = new Map([
	['getMaidNotebook', ['notebook']],
	['getMaidPersona', ['readPersona']],
	['setMaidPersona', ['savePersona', 'text']],
	['getMaidMemory', ['searchMemory', 'query']],
])

function maidError(code, message) {
	return Object.assign(new Error(message), { code })
}

export async function invokeMaidCompanion(companion, method, args) {
	const [name, parameter] = MAID_COMPANION_METHODS.get(method)
	const operation = companion?.[name]
	if (typeof operation !== 'function') {
		if (typeof companion?.prepare === 'function') {
			throw maidError('narwal/maid-update-required', '请更新桌面 Maid 后重试。')
		}
		throw maidError('narwal/maid-unavailable', '桌面 Maid 暂不可用。')
	}
	if (parameter === 'text' && (typeof args.text !== 'string' || args.text.length > 4000 || (args.text && !args.text.trim()))) {
		throw maidError('narwal/maid-invalid-input', '性格内容应在 4000 字符以内。')
	}
	if (parameter === 'query' && args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 500)) {
		throw maidError('narwal/maid-invalid-input', '搜索内容应在 500 字符以内。')
	}
	return parameter === undefined ? operation.call(companion) : operation.call(companion, args[parameter])
}
