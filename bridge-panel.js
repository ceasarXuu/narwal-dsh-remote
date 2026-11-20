import { createRequire } from 'node:module'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'

import { MAX_PAIRINGS } from './token-store.js?device-pairing'
import { PAIR_ID, publicPairing } from './relay-pairing-store.js'
import { MAX_WORKSPACE_EXPANSION_BYTES, publishWorkspaceExpansion } from './workspace-expansion.js'

const MAX_PAIRING_HOSTS = 3
const DNS_LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const TAILNET_DNS = new RegExp(`^${DNS_LABEL}\\.${DNS_LABEL}\\.ts\\.net$`)
const requirePkg = createRequire(import.meta.url)
const VERSION = (() => {
	try {
		return requirePkg('./package.json').version
	} catch {
		return 'unknown'
	}
})()

function panelToken(token) {
	if (!token) return null
	const { deviceId, ...visible } = token
	return visible
}

/** 扁平位矩阵 → 方格 SVG(黑模块白底);手机相机可读。 */
function renderQrSvg(data, size) {
	const one = 8
	const pad = 16
	const total = size * one + pad * 2
	let rects = ''
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			if (data[y * size + x]) rects += `<rect x="${pad + x * one}" y="${pad + y * one}" width="${one}" height="${one}"/>`
		}
	}
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}">` +
		`<rect width="${total}" height="${total}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`
}

/** 优先选择可用的直连 IPv4，只有隧道可用时才使用隧道地址。 */
function autoLanIps() {
	try {
		const addresses = []
		let tunnelAddress = null
		for (const [name, nets] of Object.entries(networkInterfaces())) {
			const tunnel = /^(?:utun|tun|tap|wg|ppp|ipsec)\d*$/i.test(name)
			for (const net of nets ?? []) {
				if (net.family !== 'IPv4' || net.internal || net.address.startsWith('127.') || net.address.startsWith('169.254.')) continue
				if (tunnel) tunnelAddress ??= net.address
				else addresses.push(net.address)
			}
		}
		if (!addresses.length && tunnelAddress) addresses.push(tunnelAddress)
		return addresses
	} catch { /* frozen env */ }
	return []
}

/** 只有本机回环才允许「首次创建令牌」的引导路径。 */
function isLoopback(addr) {
	return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * 本机面板是否可信。
 *
 * 设置面板跑在 DSH 自己的渲染进程里，它需要读/写令牌列表 —— 但没有令牌时
 * 拿不到 secret，会形成死锁（创建按钮点了没反应）。所以对 loopback 请求放行，
 * 但要求 Origin 必须是 DSH 自己：
 *   - dsh-app://…（Electron 渲染进程）
 *   - http://127.0.0.1:<port> / http://localhost:<port>（浏览器打开同一 GUI）
 *   - 无 Origin（curl、本机脚本）
 * 其它 Origin（例如本机浏览器里的第三方网页）一律拒绝，避免 CSRF。
 */
function isTrustedLocal(req) {
	if (!isLoopback(req.socket?.remoteAddress ?? '')) return false
	const origin = String(req.headers?.origin ?? '')
	if (!origin) return true
	if (/^dsh-app:\/\//.test(origin)) return true
	if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true
	return false
}

function auditLine(ctx, event, details) {
	try {
		const line = `${new Date().toISOString()} AUDIT ${event} :: ${JSON.stringify(details ?? {})}\n`
		import('node:fs').then((fs) => fs.appendFileSync('/tmp/narwal-audit.log', line)).catch(() => {})
		ctx.logger('narwal-server.audit').info('%s :: %o', event, details ?? {})
	} catch { /* logger missing in test harness */ }
}

function replyJson(res, extra, body, status = 200) {
	res.writeHead(status, { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
	res.end(JSON.stringify(body))
}

function readBody(req, limit = Infinity) {
	return new Promise((resolve, reject) => {
		const chunks = []
		let size = 0
		req.on('data', (chunk) => {
			size += chunk.length
			if (size <= limit) chunks.push(chunk)
		})
		req.on('end', () => {
			if (size > limit) reject(new RangeError('Request body too large'))
			else resolve(Buffer.concat(chunks).toString('utf8'))
		})
		req.on('error', reject)
	})
}

function loadToqr(bridge) {
	bridge.toqrp ||= import('./vendor/toqr.mjs').catch(async () => {
		const argv1 = process.argv[1] ?? ''
		const cutAt = argv1.indexOf('/node_modules/')
		if (cutAt > 0) {
			try {
				return await import(`file://${argv1.slice(0, cutAt)}/node_modules/toqr/dist/toqr.mjs`)
			} catch { /* nop */ }
		}
		throw new Error('toqr unavailable')
	})
	return bridge.toqrp
}

function isTailnetIp(host) {
	if (!isIPv4(host)) return false
	const [first, second] = host.split('.').map(Number)
	return first === 100 && second >= 64 && second <= 127
}

export function configuredTailnetHost(value, log) {
	if (value == null) return undefined
	if (typeof value === 'string') {
		const host = value.trim().toLowerCase()
		if (!host) return undefined
		if (isTailnetIp(host)) return host
		const name = host.replace(/\.$/, '')
		if (TAILNET_DNS.test(name)) return name
	}
	log.warn('Ignoring invalid tailnetHost. Use a Tailscale IPv4 address or full MagicDNS name.')
	return undefined
}

function pairHosts(bridge, tailnetHost) {
	const lan = String(bridge.config?.lanHost ?? '').trim()
	const detected = autoLanIps()
	const addresses = tailnetHost ? detected.filter(address => !isTailnetIp(address)) : detected
	if (lan) addresses.unshift(lan)
	if (!addresses.length) addresses.push(bridge.hostLabel())
	return [...new Set(addresses)].slice(0, MAX_PAIRING_HOSTS)
}

async function v2PairingRequest(bridge, req, res, url, corsHeaders, local) {
	if (!local) return res.writeHead(403).end()
	const id = url.searchParams.get('id')
	const pairing = PAIR_ID.test(id) && bridge.relayV2?.pairings.pending(id)
	if (!pairing) return res.writeHead(404).end()
	const [host, ...alternateHosts] = pairHosts(bridge, bridge.tailnetHost)
	const params = new URLSearchParams({
		v: '2', host, port: String(Number(bridge.config?.port) || 48317), id,
		key: bridge.relayV2.pairings.identity.publicKey, secret: pairing.secret, name: bridge.hostLabel(),
	})
	for (const alternate of alternateHosts) params.append('hostAlt', alternate)
	if (bridge.tailnetHost) params.set('tailnetHost', bridge.tailnetHost)
	const uri = `narwal://pair?${params}`
	if (url.pathname === '/v2/pairing-uri') return replyJson(res, corsHeaders, { uri })
	const { toQR } = await loadToqr(bridge)
	if (bridge.stopping || res.destroyed) return
	const data = toQR(uri, 1)
	res.writeHead(200, {
		'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
	})
	res.end(renderQrSvg(data, Math.round(Math.sqrt(data.length)) || 0))
}

export async function handlePanelRequest(bridge, req, res) {
	if (bridge.stopping) {
		res.writeHead(503).end()
		return
	}
	/* CORS:面板跨端口号取路由;只接受同机 loopback 源 */
	const origin = req.headers.origin
	const corsHeaders = {}
	const originAllowed = typeof origin === 'string' && (
		/^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):(\d{1,5})$/.test(origin) ||
		/^dsh-app:\/\/[^/]*$/.test(origin)
	)
	if (originAllowed) {
		corsHeaders['access-control-allow-origin'] = origin
		corsHeaders['access-control-allow-methods'] = 'GET,POST,OPTIONS'
		corsHeaders['access-control-allow-headers'] = 'content-type'
		corsHeaders['vary'] = 'origin'
	}
	if (req.method === 'OPTIONS') {
		res.writeHead(204, corsHeaders)
		res.end()
		return
	}
	let url
	try {
		url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
	} catch {
		res.writeHead(400).end()
		return
	}
	const localPanel = isTrustedLocal(req) && /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers?.host ?? '')
	if (req.method === 'POST' && url.pathname === '/workspace-expansion') {
		if (!localPanel) return res.writeHead(403, corsHeaders).end()
		try {
			const value = JSON.parse(await readBody(req, MAX_WORKSPACE_EXPANSION_BYTES))
			if (bridge.stopping || res.destroyed) return
			publishWorkspaceExpansion(bridge, value)
			return res.writeHead(204, corsHeaders).end()
		} catch (error) {
			const code = error instanceof RangeError ? 413 : error instanceof TypeError || error instanceof SyntaxError ? 400 : 503
			if (code === 503) bridge.log.warn('Could not save workspace expansion: %s', error?.message)
			return res.writeHead(code, corsHeaders).end()
		}
	}
	if (req.method === 'GET' && ['/v2/qr.svg', '/v2/pairing-uri'].includes(url.pathname)) {
		try { await v2PairingRequest(bridge, req, res, url, corsHeaders, localPanel) }
		catch { if (!res.headersSent) res.writeHead(500).end() }
		return
	}
	const allowed = req.method === 'GET' ? ['/qr.svg', '/stats', '/tokens', '/relay-status'] : req.method === 'POST' ? ['/tokens', '/devices', '/reload'] : []
	if (!allowed.includes(url.pathname)) {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
		res.end('narwal server: /ws (socket), /qr.svg + /stats + /tokens (HTTP)\n')
		return
	}
	let matched = bridge.findToken(url.searchParams.get('token') ?? '')
	const isPairingProbe = url.pathname === '/stats' && url.searchParams.has('deviceId')
	if (!matched && !isPairingProbe && url.pathname !== '/qr.svg' && isTrustedLocal(req)) {
		/* 本机面板：可信，但仍记录一次审计 */
		matched = { id: 'local-panel', label: 'local-panel', secret: '' }
		auditLine(bridge.ctx, 'panel/local-access', { path: url.pathname, at: Date.now() })
	}
	if (!matched) {
		res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
		res.end('invalid token\n')
		return
	}
	if (isPairingProbe) {
		const deviceError = bridge.store.checkDevice(matched, url.searchParams.get('deviceId'))
		if (deviceError) replyJson(res, corsHeaders, { ok: false, error: deviceError }, 403)
		else replyJson(res, corsHeaders, { ok: true })
		return
	}
	const v2 = localPanel ? bridge.relayV2 : null
	try {
		if (url.pathname === '/relay-status') {
			const relay = bridge.relay
			const state = !relay
				? 'off'
				: relay.closed
					? 'off'
					: relay.socket
						? 'connected'
						: `retrying (${relay.attempts})`
			replyJson(res, corsHeaders, {
				enabled: Boolean(bridge.config?.relay?.enabled),
				url: String(bridge.config?.relay?.url || '').replace(/^[a-z]+:\/\//, ''),
				hasTicket: Boolean(String(bridge.config?.relay?.ticket || '').trim()),
				state,
			})
			return
		}
		if (url.pathname === '/stats') {
			replyJson(res, corsHeaders, {
				version: VERSION,
				pairHost: pairHosts(bridge)[0],
				port: Number(bridge.config?.port) || 48317,
				advertiseName: bridge.hostLabel(),
				tokens: bridge.store.list().length + (v2?.pairings.list().length ?? 0),
				...(localPanel ? { encryptedPairing: Boolean(v2) } : {}),
				traffic: bridge.traffic.snapshot(),
				devices: [...bridge.devices.values()].filter(d => !d.transport || localPanel).map((d) => ({
					sessionId: d.sessionId,
					tokenId: d.tokenId ?? null,
					label: d.label,
					streams: d.streams.size,
					connectedAt: d.connectedAt ?? null,
				})),
			})
			return
		}
		if (url.pathname === '/reload' && req.method === 'POST') {
			auditLine(bridge.ctx, 'bridge/reload', { byToken: matched.id, at: Date.now() })
		replyJson(res, corsHeaders, { ok: true, action: 'reloadscheduled' })
			/* 给 res 写完瞬息再重建(自桥替换:关闭 + 新建覆盖同一端口) */
			setTimeout(() => {
				if (!bridge.stopping && typeof bridge.onReloadRequest === 'function') {
					try { bridge.disposeAll() } catch { }
					if (typeof bridge.reuseBuildRef === 'function') bridge.reuseBuildRef()
				}
			}, 200)
			return
		}
		if (url.pathname === '/devices' && req.method === 'POST') {
			let body = {}
			try {
				body = JSON.parse(await readBody(req))
			} catch { body = {} }
			if (bridge.stopping || res.destroyed) return
			if (typeof body?.sessionId === 'string') {
				const device = bridge.devices.get(body.sessionId)
				if (!device) {
					replyJson(res, corsHeaders, { ok: false, error: 'no such device' })
					return
				}
				if (device.transport && !localPanel) return replyJson(res, corsHeaders, { ok: false, error: 'local-panel-required' }, 403)
				if (!device.transport) auditLine(bridge.ctx, 'device/kick', { sessionId: device.sessionId, label: device.label, byToken: matched.id, at: Date.now() })
				bridge.teardown(device)
				bridge.devices.delete(device.sessionId)
				if (!device.transport) bridge.log.info('device %s (%s) kicked by panel', device.sessionId, device.label)
				replyJson(res, corsHeaders, { ok: true })
				return
			}
			res.writeHead(400, corsHeaders)
			res.end()
			return
		}
		if (url.pathname === '/tokens') {
			if (req.method === 'GET') {
				replyJson(res, corsHeaders, {
					pairHost: pairHosts(bridge)[0],
					tokens: [...bridge.store.list().map(panelToken), ...(v2?.pairings.list().map(publicPairing) ?? [])],
					maxPairings: MAX_PAIRINGS,
				})
				return
			}
			let body
			try {
				body = JSON.parse(await readBody(req))
			} catch {
				body = {}
			}
			if (bridge.stopping || res.destroyed) return
			if (body?.action === 'create') {
				if (!v2 && body.relay !== undefined) return replyJson(res, corsHeaders, { ok: false, error: 'encrypted-pairing-unavailable' }, 503)
				if (v2) {
					let created
					try { created = await v2.create(body.label, body.relay) }
					catch { return replyJson(res, corsHeaders, { ok: false, error: 'relay-invite-unavailable' }, 422) }
					if (!created) return replyJson(res, corsHeaders, { ok: false, error: 'pairing-limit' }, 409)
					return replyJson(res, corsHeaders, publicPairing(created))
				}
				const token = bridge.store.create(body?.label)
				if (!token) {
					replyJson(res, corsHeaders, { ok: false, error: 'pairing-limit' }, 409)
					return
				}
				auditLine(bridge.ctx, 'token/create', { id: token.id, label: token.label, byToken: matched.id, at: Date.now() })
				replyJson(res, corsHeaders, token)
				return
			}
			if (body?.action === 'relabel' && typeof body?.id === 'string') {
				if (v2?.pairings.list().some(record => record.id === body.id)) {
					return replyJson(res, corsHeaders, { ok: true, token: publicPairing(v2.pairings.relabel(body.id, body.label)) })
				}
				auditLine(bridge.ctx, 'token/relabel', { id: body.id, next: String(body?.label ?? '').slice(0, 24), byToken: matched.id, at: Date.now() })
				const updated = bridge.store.relabel?.(body.id, body?.label) ?? null
				replyJson(res, corsHeaders, { ok: true, token: panelToken(updated) })
				return
			}
			if (body?.action === 'revoke' && typeof body?.id === 'string') {
				if (v2?.pairings.list().some(record => record.id === body.id)) {
					v2.revoke(body.id)
					return replyJson(res, corsHeaders, { ok: true })
				}
				auditLine(bridge.ctx, 'token/revoke', { id: body.id, byToken: matched.id, at: Date.now() })
				bridge.store.revoke?.(body.id)
				bridge.killDevicesByTokenId(body.id, 'token revoked')
				replyJson(res, corsHeaders, { ok: true })
				return
			}
			res.writeHead(400, corsHeaders)
			res.end()
			return
		}
		/* /qr.svg */
		const { toQR } = await loadToqr(bridge)
		if (bridge.stopping || res.destroyed) return
		const [host, ...alternateHosts] = pairHosts(bridge)
		const port = Number(bridge.config?.port) || 48317
		const name = bridge.hostLabel()
		const params = new URLSearchParams({ v: '1', host, port: String(port), token: matched.secret, name })
		const desktopId = bridge.store.getDesktopId()
		if (desktopId) {
			params.set('desktopId', desktopId)
			for (const alternate of alternateHosts) params.append('hostAlt', alternate)
		}
		const payload = `narwal://pair?${params}`
		const data = toQR(payload, 1)
		const size = Math.round(Math.sqrt(data.length)) || 0
		res.writeHead(200, {
			'content-type': 'image/svg+xml; charset=utf-8',
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff',
		})
		res.end(renderQrSvg(data, size))
	} catch (error) {
		bridge.log.warn('http %s failed: %s', url.pathname, error?.message ?? String(error))
		res.writeHead(500).end()
	}
}
