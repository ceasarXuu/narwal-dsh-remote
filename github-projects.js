const PLUGIN_PATH = '/plugin/github-projects'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]'])
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const READ_TIMEOUT_MS = 25_000
const ERROR_MESSAGES = new Map([
	['gh-missing', '桌面端未安装 GitHub CLI。'],
	['gh-auth', '请在桌面端登录 GitHub CLI。'],
	['project-not-found', '找不到已绑定的 GitHub Project，或当前账户无权访问。'],
	['issue-not-found', '找不到已绑定的 GitHub Issue，或当前账户无权访问。'],
	['timeout', '桌面端读取 GitHub 数据超时。'],
])

function projectsError(reason) {
	return Object.assign(new Error(ERROR_MESSAGES.get(reason) ?? '桌面端无法读取 GitHub 数据。'), {
		code: 'narwal/github-projects',
		details: { reason: ERROR_MESSAGES.has(reason) ? reason : 'read-failed' },
	})
}

function getLoopbackOrigin(webServer) {
	try {
		const origin = new URL(webServer.getOrigin())
		if (!LOOPBACK_HOSTS.has(origin.hostname) || !['http:', 'https:'].includes(origin.protocol)) return null
		if (origin.username || origin.password) return null
		return origin.origin
	} catch {
		return null
	}
}

async function readJson(response) {
	const reader = response.body?.getReader()
	if (!reader) throw projectsError()
	const chunks = []
	let size = 0
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
			size += value.byteLength
			if (size > MAX_RESPONSE_BYTES) throw projectsError()
			chunks.push(value)
		}
	} finally {
		await reader.cancel().catch(() => {})
	}
}

async function readRoute(origin, route, query, signal) {
	const url = new URL(`${PLUGIN_PATH}/${route}`, origin)
	url.search = new URLSearchParams(query).toString()
	const response = await fetch(url, { redirect: 'error', signal })
	const json = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json'
	if (!json) {
		await response.body?.cancel()
		// When the plugin has no route, DSH can answer with a 404 or its HTML app shell.
		if (route === 'config' && (response.status === 404 || response.ok)) return null
		throw projectsError()
	}
	const payload = await readJson(response)
	if (route === 'config' && response.status === 404 && payload?.error?.code === 'not-found') return null
	if (!response.ok) throw projectsError(payload?.error?.code)
	return payload
}

async function readService(reader, route, query, signal) {
	signal.throwIfAborted()
	const abort = Promise.withResolvers()
	const onAbort = () => abort.reject(signal.reason)
	signal.addEventListener('abort', onAbort, { once: true })
	try {
		const payload = await Promise.race([reader[route](new URLSearchParams(query)), abort.promise])
		if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESPONSE_BYTES) throw projectsError()
		return payload
	} catch (error) {
		throw projectsError(signal.aborted ? 'timeout' : error?.code)
	} finally {
		signal.removeEventListener('abort', onAbort)
	}
}

export async function readGitHubProjects(ctx, installer, args) {
	const target = args?.target
	const id = typeof args?.id === 'string' ? args.id.trim() : ''
	if ((target !== 'workspace' && target !== 'session') || id === '' || id.length > 200) {
		throw Object.assign(new Error('缺少有效的工作区或会话。'), { code: 'narwal/bad-request' })
	}
	const reader = ctx.get('githubProjectsReader')
	const hasReader = ['config', 'items', 'issue'].every(route => typeof reader?.[route] === 'function')
	const origin = hasReader ? null : getLoopbackOrigin(ctx.get('webServer'))
	if (!hasReader && !origin) return { kind: 'unavailable' }
	const signal = AbortSignal.timeout(READ_TIMEOUT_MS)
	const read = hasReader
		? (route, query) => readService(reader, route, query, signal)
		: (route, query) => readRoute(origin, route, query, signal)
	try {
		const key = target === 'workspace' ? 'workspaceId' : 'sessionId'
		const config = await read('config', { [key]: id })
		if (config === null) {
			const availability = await installer.availability()
			return availability.kind === 'registered' ? { kind: 'unavailable' } : availability
		}
		const binding = config[target]
		if (binding?.[key] !== id) throw projectsError()
		const query = args.refresh === true ? { refresh: '1' } : {}
		if (target === 'workspace') {
			const project = binding.project
			if (project === null) return { kind: 'unbound' }
			if (typeof project?.owner !== 'string' || !Number.isSafeInteger(project.number) || project.number < 1) throw projectsError()
			const data = await read('items', { ...query, owner: project.owner, number: project.number })
			return { kind: 'project', data }
		}
		const issue = binding.issue
		if (issue === null) return { kind: 'unbound' }
		if (typeof issue?.repo !== 'string' || !Number.isSafeInteger(issue.number) || issue.number < 1) throw projectsError()
		const data = await read('issue', { ...query, repo: issue.repo, number: issue.number })
		return { kind: 'issue', data }
	} catch (error) {
		if (error?.code === 'narwal/github-projects') throw error
		throw projectsError(signal.aborted ? 'timeout' : undefined)
	}
}
