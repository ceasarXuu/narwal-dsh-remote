import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const TTL_MS = 30 * 60_000
const IDLE_MS = 20_000
const CHUNK_BYTES = 32 * 1024
const MAX_RESOURCE_BYTES = 8 * 1024 * 1024
const MAX_HEADER_BYTES = 8 * 1024
const MAX_INFLIGHT = 6
const MAX_DESKTOP_INFLIGHT = 24
const MAX_PATH_LENGTH = 4096
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const REQUEST_HEADERS = new Set([
	'accept', 'accept-language', 'authorization', 'content-type', 'cookie', 'if-match', 'if-modified-since',
	'if-none-match', 'if-range', 'if-unmodified-since', 'range', 'x-csrf-token', 'x-xsrf-token', 'x-requested-with',
])
const RESPONSE_HEADERS = new Set([
	'allow', 'cache-control', 'content-disposition', 'content-encoding', 'content-language', 'content-range',
	'content-security-policy', 'content-type', 'etag', 'expires', 'last-modified', 'vary', 'www-authenticate',
	'x-content-type-options',
])
const BASE64 = /^(?:[a-z\d+/]{4})*(?:[a-z\d+/]{2}==|[a-z\d+/]{3}=)?$/i
const CONTROL = /[\u0000-\u001f\u007f]/u
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(?::(\d{1,5}))?(?=[/?#]|$)/i
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])

export const LOCAL_WEB_METHODS = new Set(['openLocalWeb', 'localWebRequest', 'localWebRead', 'localWebClose'])

function error(reason, message) {
	return Object.assign(new Error(message), { code: `narwal/local-web-${reason}` })
}

function invalid() {
	return error('invalid', '只支持已共享的本机 HTTP 服务和有效的网页请求。')
}

function notShared() {
	return error('not-shared', '请在桌面 Narwal 设置中为这台设备共享该端口。')
}

function unavailable() {
	return error('unavailable', '桌面本机网页暂时无法访问。')
}

function restricted() {
	return error('restricted', '这个端口属于桌面控制服务，无法共享。')
}

function tooLarge() {
	return error('too-large', '网页请求或资源超过大小限制。')
}

function parsePort(port) {
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw invalid()
	return port
}

function ownPorts(bridge) {
	const web = bridge.ctx.get('webServer')
	let originPort
	try {
		const origin = new URL(web.getOrigin())
		originPort = Number(origin.port || (origin.protocol === 'https:' ? 443 : 80))
	} catch { /* Older Host versions expose their bound port directly. */ }
	return [bridge.server?.address()?.port, Number(bridge.config?.port) || 48317, Number(web?.port), originPort]
}

function ensureUserPort(bridge, port) {
	const blocked = ownPorts(bridge)
	if (blocked.includes(port)) throw restricted()
}

function parseService(url) {
	if (typeof url !== 'string' || url.length > MAX_PATH_LENGTH || CONTROL.test(url) || url.includes('\\')) throw invalid()
	const match = LOOPBACK.exec(url)
	if (!match) throw invalid()
	const port = parsePort(Number(match[2] ?? 80))
	const host = match[1].toLowerCase()
	const { pathname, search, hash } = new URL(url)
	return { port, origin: new URL(`http://${host}:${port}`).origin, path: `${safePath(pathname + search)}${hash}` }
}

function safePath(path) {
	if (typeof path !== 'string' || path.length > MAX_PATH_LENGTH || !path.startsWith('/') || path.startsWith('//') ||
		path.includes('\\') || path.includes('#') || CONTROL.test(path)) throw invalid()
	return path
}

function grantStore(bridge) {
	return bridge.localWeb ??= new Map()
}

function finish(grant, record) {
	clearTimeout(record.idle)
	grant.responses.delete(record.id)
	record.request?.destroy()
}

export function revokeLocalWeb(bridge, pairId) {
	const grant = bridge.localWeb?.get(pairId)
	if (!grant) return
	bridge.localWeb.delete(pairId)
	clearTimeout(grant.expiry)
	for (const record of grant.responses.values()) finish(grant, record)
}

export function closeLocalWebDevice(bridge, device) {
	const grant = bridge.localWeb?.get(device.tokenId)
	if (!grant) return
	for (const record of grant.responses.values()) {
		if (record.device === device) finish(grant, record)
	}
}

export function closeAllLocalWeb(bridge) {
	if (!bridge.localWeb) return
	for (const pairId of bridge.localWeb.keys()) revokeLocalWeb(bridge, pairId)
}

function currentGrant(bridge, pairId) {
	const grant = bridge.localWeb?.get(pairId)
	if (!grant) return null
	if (grant.expiresAt <= Date.now() || !bridge.relayV2?.pairings.paired(pairId)) {
		revokeLocalWeb(bridge, pairId)
		return null
	}
	return grant
}

export function localWebStatus(bridge, pairId) {
	const grant = currentGrant(bridge, pairId)
	return grant ? { port: grant.port, expiresAt: grant.expiresAt } : null
}

export function grantLocalWeb(bridge, pairId, port) {
	if (!bridge.relayV2?.pairings.paired(pairId)) throw notShared()
	parsePort(port)
	ensureUserPort(bridge, port)
	revokeLocalWeb(bridge, pairId)
	const expiresAt = Date.now() + TTL_MS
	const expiry = setTimeout(() => revokeLocalWeb(bridge, pairId), TTL_MS).unref()
	grantStore(bridge).set(pairId, { port, expiresAt, expiry, responses: new Map() })
	return { port, expiresAt }
}

function requestBody(method, encoded) {
	if (encoded === undefined || encoded === '') return undefined
	if (method === 'GET' || method === 'HEAD' || typeof encoded !== 'string') throw invalid()
	if (encoded.length > Math.ceil(CHUNK_BYTES / 3) * 4) throw tooLarge()
	if (!BASE64.test(encoded)) throw invalid()
	const body = Buffer.from(encoded, 'base64')
	if (body.length > CHUNK_BYTES) throw tooLarge()
	return body
}

function requestHeaders(grant, raw, body) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid()
	const headers = { host: new URL(grant.origin).host, 'accept-encoding': 'identity' }
	let size = 0
	for (const [key, value] of Object.entries(raw)) {
		const name = key.toLowerCase()
		if (typeof value !== 'string' || CONTROL.test(value)) throw invalid()
		size += Buffer.byteLength(key) + Buffer.byteLength(value)
		if (size > MAX_HEADER_BYTES) throw tooLarge()
		if (REQUEST_HEADERS.has(name)) headers[name] = value
		if (name === 'origin') headers.origin = grant.origin
		if (name === 'referer') {
			try {
				const ref = new URL(value)
				if (ref.protocol === 'http:' && ref.hostname === '127.0.0.1') {
					headers.referer = grant.origin + safePath(ref.pathname + ref.search)
				}
			} catch { /* Ignore referers that cannot belong to the app viewer. */ }
		}
	}
	if (body) headers['content-length'] = String(body.length)
	return headers
}

function redirectPath(grant, path, location) {
	try {
		const target = new URL(location, grant.origin + path)
		const { origin, username, password, pathname, search, hash } = target
		if (origin === grant.origin && !username && !password) return safePath(pathname + search) + hash
	} catch { /* The app never leaves this service in a private preview. */ }
	throw error('redirect', '网页试图跳转到未共享的地址。')
}

function sameHostCookie(cookie, hostname) {
	const [value, ...attributes] = cookie.split(';')
	if (/^__narwal_web\s*=/i.test(value.trim())) return undefined
	const removeDomain = /^\s*domain\s*=/i
	for (const attribute of attributes) {
		if (removeDomain.test(attribute) && attribute.replace(removeDomain, '').trim().replace(/^\./, '').toLowerCase() !== hostname) {
			return undefined
		}
	}
	return [value, ...attributes.filter(attribute => !removeDomain.test(attribute))].join(';')
}

function responseMetadata(grant, path, response) {
	const status = response.statusCode
	if (!status || status < 200) throw unavailable()
	const headers = {}
	for (const name of RESPONSE_HEADERS) {
		const value = response.headers[name]
		if (typeof value === 'string') headers[name] = value
	}
	const location = response.headers.location
	if (typeof location === 'string' && REDIRECT_CODES.has(status)) headers.location = redirectPath(grant, path, location)
	const hostname = new URL(grant.origin).hostname
	const cookies = (response.headers['set-cookie'] ?? []).map(cookie => sameHostCookie(cookie, hostname)).filter(Boolean)
	if (Buffer.byteLength(JSON.stringify({ headers, cookies })) > MAX_HEADER_BYTES) throw tooLarge()
	return { status, headers, ...(cookies.length ? { cookies } : {}) }
}

function setIdle(grant, record) {
	clearTimeout(record.idle)
	record.idle = setTimeout(() => finish(grant, record), IDLE_MS).unref()
}

function upstream(grant, record, path, method, headers, body) {
	return new Promise((resolve, reject) => {
		record.request = httpRequest({ hostname: '127.0.0.1', port: grant.port, path, method, headers, agent: false }, resolve)
		record.request.on('error', reject)
		record.request.on('upgrade', (_response, socket) => { socket.destroy(); reject(unavailable()) })
		record.request.end(body)
	})
}

async function nextChunk(record) {
	const chunks = []
	let size = 0
	let eof = false
	while (size < CHUNK_BYTES) {
		let buffer = record.pending
		if (!buffer?.length) {
			const next = await record.iterator.next()
			if (next.done) { eof = true; break }
			buffer = next.value
		}
		const count = Math.min(buffer.length, CHUNK_BYTES - size)
		chunks.push(buffer.subarray(0, count))
		record.pending = buffer.subarray(count)
		size += count
	}
	const offset = record.offset
	record.offset += size
	if (record.offset > MAX_RESOURCE_BYTES) throw tooLarge()
	return { offset, body: Buffer.concat(chunks, size).toString('base64'), eof }
}

async function readChunk(grant, record) {
	try {
		record.busy = true
		setIdle(grant, record)
		const reply = await nextChunk(record)
		if (!grant.responses.has(record.id)) throw notShared()
		record.last = reply
		if (reply.eof) finish(grant, record)
		else setIdle(grant, record)
		return reply
	} finally {
		record.busy = false
	}
}

async function start(bridge, grant, device, args) {
	const path = safePath(args.path)
	const method = args.method
	if (!METHODS.has(method)) throw invalid()
	const body = requestBody(method, args.body)
	const headers = requestHeaders(grant, args.headers, body)
	const total = [...bridge.localWeb.values()].reduce((count, sharing) => count + sharing.responses.size, 0)
	if (grant.responses.size >= MAX_INFLIGHT || total >= MAX_DESKTOP_INFLIGHT) throw error('busy', '当前网页请求太多，请稍后重试。')
	const record = { device, id: randomUUID(), offset: 0, busy: true }
	grant.responses.set(record.id, record)
	try {
		setIdle(grant, record)
		const response = await upstream(grant, record, path, method, headers, body)
		if (!grant.responses.has(record.id)) throw notShared()
		const metadata = responseMetadata(grant, path, response)
		if (method !== 'HEAD' && /^\d+$/.test(response.headers['content-length'] ?? '')
			&& Number(response.headers['content-length']) > MAX_RESOURCE_BYTES) throw tooLarge()
		record.iterator = response[Symbol.asyncIterator]()
		const chunk = await readChunk(grant, record)
		return { ...metadata, body: chunk.body, ...(chunk.eof ? {} : { responseId: record.id }) }
	} catch (cause) {
		finish(grant, record)
		throw cause
	}
}

export async function invokeLocalWeb(bridge, device, method, args) {
	if (!device.active || !device.transport || !device.peer) throw unavailable()
	const grant = currentGrant(bridge, device.tokenId)
	if (method === 'openLocalWeb') {
		const target = parseService(args.url)
		ensureUserPort(bridge, target.port)
		if (!grant || grant.port !== target.port) throw notShared()
		for (const record of grant.responses.values()) finish(grant, record)
		grant.origin = target.origin
		grant.id = randomUUID()
		return { id: grant.id, path: target.path }
	}
	if (!grant || typeof args.id !== 'string' || grant.id !== args.id || !grant.origin) throw notShared()
	ensureUserPort(bridge, grant.port)
	try {
		if (method === 'localWebRequest') return await start(bridge, grant, device, args)
		if (method === 'localWebClose') {
			closeLocalWebDevice(bridge, device)
			return { ok: true }
		}
		const record = grant.responses.get(args.responseId)
		if (!record || record.device !== device || record.busy) throw unavailable()
		if (args.offset === record.last?.offset) return record.last
		if (args.offset !== record.offset) throw invalid()
		try { return await readChunk(grant, record) }
		catch (cause) { finish(grant, record); throw cause }
	} catch (cause) {
		if (typeof cause?.code === 'string' && cause.code.startsWith('narwal/local-web-')) throw cause
		throw unavailable()
	}
}
