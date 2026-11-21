export const MAID_COMPANION_METHODS = new Map([
	['getMaidAvatar', ['readAvatar', 'avatar']],
	['getMaidProfile', ['readProfile', undefined, true]],
	['setMaidName', ['saveName', 'name', true]],
	['setMaidAvatar', ['saveAvatar', 'dataUrl', true]],
	['getMaidNotebook', ['notebook']],
	['getMaidPersona', ['readPersona']],
	['setMaidPersona', ['savePersona', 'text']],
	['getMaidMemory', ['searchMemory', 'query']],
	['updateMaidMemory', ['updateMemory', 'memory']],
])

const AVATAR_CHUNK_SIZE = 192 * 1024 // Align base64 chunks to three-byte groups.

function maidError(code, message) {
	return Object.assign(new Error(message), { code })
}

export async function invokeMaidCompanion(companion, method, args) {
	const [name, parameter, returnsProfile] = MAID_COMPANION_METHODS.get(method)
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
	if (parameter === 'avatar') {
		const { version, offset } = args
		if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)
			|| !Number.isSafeInteger(offset) || offset < 0 || offset % AVATAR_CHUNK_SIZE !== 0) {
			throw maidError('narwal/maid-invalid-input', '头像版本或读取位置无效。')
		}
		const image = operation.call(companion)
		if (image?.version !== version || offset >= image.body.length) return null
		const end = Math.min(offset + AVATAR_CHUNK_SIZE, image.body.length)
		return {
			mimeType: image.type,
			data: image.body.subarray(offset, end).toString('base64'),
			nextOffset: end === image.body.length ? null : end,
		}
	}
	const argument = parameter === 'memory' ? { id: args.id, topic: args.topic, scope: args.scope, fact: args.fact } : args[parameter]
	const result = await operation.call(companion, argument)
	return returnsProfile ? { name: result.name, avatarVersion: result.version } : result
}
