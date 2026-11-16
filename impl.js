/**
 * Narwal Server — host half (protocol v1 bridge, 0.2.0).
 *
 * Cordis plugin running inside the DSH desktop runtime (contract proven in the
 * tarball load experiment: named exports `apply(ctx, config)` + `inject`).
 *
 * Responsibilities:
 *   1. HTTP + ws on config.port; token auth at upgrade (/ws) and on admin routes
 *   2. per-device in-process Peer (owner principal) via ctx.connection.createPeer
 *   3. unary bridge  : ctx.typertGateway.invoke({namespace, method, args, peer})
 *   4. stream bridge : ctx.typertGateway.stream(...), explicit unsubscribe/close
 *   5. fan-out       : api-session/{added,removed,status,activity,error} per device
 *   6. pairing tokens: durable plugin-owned file store under $DSH_HOME
 *                      (config doc page only holds visual params now)
 *   7. routes        : /qr.svg (pairing QR), /stats (devices), /tokens (admin)
 *
 * Wire frames (JSON):
 *   client→server { id, ns, method, args, stream? } / { id, unsubscribe: true }
 *   server→client { event:'hello', payload } | { id, ok, value } | { id, ok:false, error }
 *   server→client { id, item } … { id, done } | { event, payload }
 */

import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'

const requirePkg = createRequire(import.meta.url)
const VERSION = (() => {
	try {
		return requirePkg('./package.json').version
	} catch {
		return 'unknown'
	}
})()
import { homedir, networkInterfaces, userInfo } from 'node:os'
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const TRACE = process.env.NARWAL_TRACE === '1'
const TOKEN_ACTIONS = ['create', 'revoke']

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

/** 首个非环回 IPv4 —— QR 载荷里的手机可达 host。 */
function autoLanIp() {
	try {
		for (const nets of Object.values(networkInterfaces())) {
			for (const net of nets ?? []) {
				if (net.family === 'IPv4' && !net.internal) return net.address
			}
		}
	} catch { /* frozen env */ }
	return null
}

class TokenStore {
	constructor(home, configTokens) {
		/*
		 * 令牌落在哪个 home：
		 * 1. DSH_HOME（宿主显式提供时最权威）
		 * 2. 进程 cwd —— 桌面端未注入 DSH_HOME，cwd 即 profiles/<name>，
		 *    正好实现「每个 profile 独立令牌」的语义
		 * 3. os.homedir()/.dsh 兜底
		 */
		const explicit = home && home.length > 3 ? home : null
		const fallback = process.cwd()
		const base = explicit ?? fallback
		this.dir = join(base, 'narwal-server')
		this.file = join(this.dir, 'tokens.json')
		this.base = base
		this.memory = []
		try {
			this.load()
		} catch { this.memory = [] }
		for (const t of (Array.isArray(configTokens) ? configTokens : [])) {
			if (t && typeof t === 'object' && typeof t.secret === 'string' && !this.memory.some((x) => x.secret === t.secret)) {
				this.memory.push({ id: t.id ?? `nt_${Date.now().toString(36)}`, label: t.label ?? '', createdAt: t.createdAt ?? new Date().toISOString(), secret: t.secret })
			}
		}
	}

	static secret() {
		const bytes = new Uint8Array(24)
		;((globalThis.crypto ?? { getRandomValues: (b) => b }).getRandomValues)(bytes)
		return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
	}

	static id() {
		return `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
	}

	load() {
		if (!existsSync(this.file)) {
			this.memory = []
			return
		}
		const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
		this.memory = Array.isArray(parsed?.tokens) ? parsed.tokens.filter((t) => t && typeof t.secret === 'string') : []
	}

	save() {
		try {
			mkdirSync(this.dir, { recursive: true })
			const tmp = `${this.file}.tmp`
			writeFileSync(tmp, JSON.stringify({ tokens: this.memory, updatedAt: new Date().toISOString() }, null, 1), 'utf8')
			renameSync(tmp, this.file)
		} catch { /* 权限不足时令牌仍在内存,重启丢失 */ }
	}

	list() {
		return this.memory
	}

	create(label) {
		const token = {
			id: TokenStore.id(),
			label: (typeof label === 'string' && label.trim()) || `device-${this.memory.length + 1}`,
			createdAt: new Date().toISOString(),
			secret: TokenStore.secret(),
		}
		this.memory = [...this.memory, token]
		this.save()
		return token
	}

	revoke(id) {
		this.memory = this.memory.filter((t) => t.id !== id)
		this.save()
	}

	relabel(id, label) {
		const t = this.memory.find((x) => x.id === id)
		if (!t) return null
		t.label = String(label ?? '').trim() || t.label
		this.save()
		return t
	}
}

function streamLog(ctx, event, details) {
	try {
		const line = `${new Date().toISOString()} STREAM ${event} :: ${JSON.stringify(details)}\n`
		import('node:fs').then((fs) => fs.appendFileSync('/tmp/narwal-stream.log', line)).catch(() => {})
	} catch { }
}

/**
 * 桌面端账户信息:macOS 全名 + 系统头像。
 * 头像来自 dscl 的 JPEGPhoto(十六进制),一次性读入并缓存,作为 data URL 下发给手机。
 */
function readDesktopAccount() {
	try {
		let user = ''
		try {
			user = userInfo().username || ''
		} catch { /* fall through */ }
		if (!user) user = process.env.USER || process.env.LOGNAME || ''
		let name = ''
		try {
			name = String(execFileSync('id', ['-F'], { encoding: 'utf8' })).trim()
		} catch { /* fall through */ }
		if (!name) name = user || 'desktop'
		let avatar = null
		try {
			const hex = String(execFileSync('dscl', ['.', '-read', `/Users/${user}`, 'JPEGPhoto'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }))
			/* dscl 输出形如 "JPEGPhoto:" 后跟按空格分组的十六进制,需先剔除标签行与空白 */
			const raw = hex
				.split('\n')
				.filter((line) => !line.includes(':'))
				.join('')
				.replace(/[^0-9a-fA-F]/g, '')
			if (raw.length > 256) {
				const buf = Buffer.from(raw, 'hex')
				if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
					avatar = `data:image/jpeg;base64,${buf.toString('base64')}`
				}
			}
		} catch { /* no avatar configured */ }
		return { name, user, avatar }
	} catch {
		return { name: 'desktop', user: '', avatar: null }
	}
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

class NarwalBridge {
	constructor(ctx, config, deps) {
		this.account = readDesktopAccount()
		this.ctx = ctx
		this.config = config
		this.deps = deps
		this.store = deps.store
		this.log = ctx.logger('narwal-server')
		this.devices = new Map()
	}

	startRelayDialer(relay) {
		const url = String(relay?.url ?? '').trim()
		const ticket = String(relay?.ticket ?? '').trim()
		if (!this.deps.WS || !url || !ticket) {
			this.log.info('relay dialer not started (missing url/ticket/ws)')
			return
		}
		this.relay = { url, ticket, attempts: 0, timer: null, socket: null, closed: false, dial: null }
		const dial = () => {
			if (this.relay.closed) return
			const scheme = url.startsWith('wss://') ? 'wss' : 'ws'
			const rest = url.slice(url.indexOf('://') + 3)
			const target = `${scheme}:${rest}/ws/host?ticket=${encodeURIComponent(ticket)}`
			this.log.info('relay dial %s', url)
			let socket
			try {
				socket = new this.deps.WS(target)
			} catch (error) {
				this.log.warn('relay dial failed: %s', error?.message ?? String(error))
				this.scheduleRelayRetry()
				return
			}
			this.relay.socket = socket
			socket.on('open', () => {
				this.relay.attempts = 0
				void this.attach(socket, { id: 'relay', label: 'relay' }).then(() => {
					this.log.info('relay device attached')
				})
			})
			socket.on('close', () => {
				if (this.relay.socket !== socket) return
				this.relay.socket = null
				if (!this.relay.closed) this.scheduleRelayRetry()
			})
			socket.on('error', () => { /* close follows */ })
		}
		this.relay.dial = dial
		dial()
		this.relay.dispose = () => {
			if (this.relay) {
				this.relay.closed = true
				if (this.relay.timer) clearInterval(this.relay.timer)
				try { this.relay.socket?.close?.(1000, 'plugin stop') } catch { /* nop */ }
			}
		}
	}

	scheduleRelayRetry() {
		if (!this.relay || this.relay.closed) return
		if (this.relay.attempts >= 8) {
			this.log.warn('relay retry cap reached')
			return
		}
		const delay = Math.min(1500 * 2 ** this.relay.attempts, 30000)
		this.relay.attempts++
		this.relay.timer = setTimeout(() => {
			if (this.relay && !this.relay.closed) this.relay.dial?.()
		}, delay)
	}

	start() {
		this.server = createServer((req, res) => {
			void this.handlePlain(req, res)
		})
		this.server.on('error', (err) => this.log.warn('bridge http error: %s', err?.message))

		this.wss = new this.deps.WebSocketServer({ noServer: true })
		this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))

		const port = (this.config && Number(this.config.port)) || 48317
		this.server.listen(port, '0.0.0.0', () => {
			this.log.info('narwal bridge listening on %d (ws /ws?token=...)', port)
		})

		/* heartbeat: 保活 NAT/WiFi 链路,杀掉死 socket */
		this.aliveFails = new Map()
		this.heartbeat = setInterval(() => {
			for (const device of [...this.devices.values()]) {
				const fails = (this.aliveFails.get(device.sessionId) ?? 0) + 1
				this.aliveFails.set(device.sessionId, fails)
				if (fails > 2) {
					try { device.socket.terminate() } catch { }
					continue
				}
				try {
					device.socket.once?.('pong', () => this.aliveFails.set(device.sessionId, 0))
					device.socket.ping?.()
				} catch { /* closing */ }
			}
		}, 30000)
		/* 清理统一由 disposeAll 负责：插件被热重载时 apply 不会重新执行，
		 * 挂在 ctx.effect 上会逐次累积，这里不再注册。 */
	}

	disposeAll() {
		try { this.relay?.dispose?.() } catch { /* nop */ }
		for (const off of this.fanoutOffs ?? []) {
			try { off?.() } catch { /* nop */ }
		}
		this.fanoutOffs = []
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.aliveFails?.clear()
		try { this.wss?.close() } catch { /* nop */ }
		for (const device of [...this.devices.values()]) this.teardown(device)
		this.devices.clear()
		try { this.server?.close() } catch { /* nop */ }
		this.log.info('bridge stopped; devices disposed')
	}

	/** 可鉴权令牌全集(自有文件 + patch config 的兼容并集,按 secret 去重)。 */
	tokens() {
		const seen = new Set()
		const out = []
		for (const t of [...(this.store?.list?.() ?? []), ...(Array.isArray(this.config?.tokens) ? this.config.tokens : [])]) {
			if (t && typeof t === 'object' && typeof t.secret === 'string' && t.secret.length >= 8 && !seen.has(t.secret)) {
				seen.add(t.secret)
				out.push(t)
			}
		}
		return out
	}

	findToken(secret) {
		return this.tokens().find((t) => t.secret === secret) ?? null
	}

	handleUpgrade(req, socket, head) {
		let url
		try {
			url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
		} catch {
			socket.destroy()
			return
		}
		if (url.pathname !== '/ws') {
			this.rejectUpgrade(socket, 404, 'unknown path')
			return
		}
		const matched = this.findToken(url.searchParams.get('token') ?? '')
		if (!matched) {
			this.rejectUpgrade(socket, 401, 'invalid pairing token')
			return
		}
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			void this.attach(ws, matched)
		})
	}

	rejectUpgrade(socket, status, message) {
		socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nconnection: close\r\ncontent-length: ${message.length}\r\n\r\n${message}`)
		socket.destroy()
	}

	async handlePlain(req, res) {
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
		const allowed = req.method === 'GET' ? ['/qr.svg', '/stats', '/tokens', '/relay-status'] : req.method === 'POST' ? ['/tokens', '/devices', '/reload'] : []
		if (!allowed.includes(url.pathname)) {
			res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('narwal server: /ws (socket), /qr.svg + /stats + /tokens (HTTP)\n')
			return
		}
		let matched = this.findToken(url.searchParams.get('token') ?? '')
		/*
		 * 引导例外：一枚令牌都没有时，本机面板需要一个创建入口。
		 * 仅限 loopback + POST /tokens + 零令牌，一旦存在任何令牌立即恢复严格鉴权。
		 */
		if (!matched && isTrustedLocal(req)) {
			/* 本机面板：可信，但仍记录一次审计 */
			matched = { id: 'local-panel', label: 'local-panel', secret: '' }
			auditLine(this.ctx, 'panel/local-access', { path: url.pathname, at: Date.now() })
		}
		if (!matched) {
			res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
			res.end('invalid token\n')
			return
		}
		try {
			if (url.pathname === '/relay-status') {
				const relay = this.relay
				const state = !relay
					? 'off'
					: relay.closed
						? 'off'
						: relay.socket
							? 'connected'
							: `retrying (${relay.attempts})`
				this.replyJson(res, corsHeaders, {
					enabled: Boolean(this.config?.relay?.enabled),
					url: String(this.config?.relay?.url || '').replace(/^[a-z]+:\/\//, ''),
					hasTicket: Boolean(String(this.config?.relay?.ticket || '').trim()),
					state,
				})
				return
			}
			if (url.pathname === '/stats') {
				this.replyJson(res, corsHeaders, {
					version: VERSION,
					pairHost: this.pairHost(),
					port: Number(this.config?.port) || 48317,
					advertiseName: this.hostLabel(),
					tokens: this.tokens().length,
					devices: [...this.devices.values()].map((d) => ({
						sessionId: d.sessionId,
						label: d.label,
						streams: d.streams.size,
						connectedAt: d.connectedAt ?? null,
					})),
				})
				return
			}
			if (url.pathname === '/reload' && req.method === 'POST') {
				auditLine(this.ctx, 'bridge/reload', { byToken: matched.id, at: Date.now() })
			this.replyJson(res, corsHeaders, { ok: true, action: 'reloadscheduled' })
				/* 给 res 写完瞬息再重建(自桥替换:关闭 + 新建覆盖同一端口) */
				setTimeout(() => {
					if (typeof this.onReloadRequest === 'function') {
						try { this.disposeAll() } catch { }
						if (typeof this.reuseBuildRef === 'function') this.reuseBuildRef()
					}
				}, 200)
				return
			}
			if (url.pathname === '/devices' && req.method === 'POST') {
				let body = {}
				try {
					body = JSON.parse(await this.readBody(req))
				} catch { body = {} }
				if (typeof body?.sessionId === 'string') {
					const device = this.devices.get(body.sessionId)
					if (!device) {
						this.replyJson(res, corsHeaders, { ok: false, error: 'no such device' })
						return
					}
					auditLine(this.ctx, 'device/kick', { sessionId: device.sessionId, label: device.label, byToken: matched.id, at: Date.now() })
					this.teardown(device)
					this.devices.delete(device.sessionId)
					this.log.info('device %s (%s) kicked by panel', device.sessionId, device.label)
					this.replyJson(res, corsHeaders, { ok: true })
					return
				}
				res.writeHead(400, corsHeaders)
				res.end()
				return
			}
			if (url.pathname === '/tokens') {
				if (req.method === 'GET') {
					this.replyJson(res, corsHeaders, {
						pairHost: this.pairHost(),
						tokens: this.store?.list?.() ?? [],
					})
					return
				}
				let body
				try {
					body = JSON.parse(await this.readBody(req))
				} catch {
					body = {}
				}
				if (body?.action === 'create') {
					const token = this.store.create?.(body?.label) ?? {}
					auditLine(this.ctx, 'token/create', { id: token.id, label: token.label, byToken: matched.id, at: Date.now() })
					this.replyJson(res, corsHeaders, token)
					return
				}
				if (body?.action === 'relabel' && typeof body?.id === 'string') {
					auditLine(this.ctx, 'token/relabel', { id: body.id, next: String(body?.label ?? '').slice(0, 24), byToken: matched.id, at: Date.now() })
					const updated = this.store.relabel?.(body.id, body?.label) ?? null
					this.replyJson(res, corsHeaders, { ok: true, token: updated })
					return
				}
				if (body?.action === 'revoke' && typeof body?.id === 'string') {
					auditLine(this.ctx, 'token/revoke', { id: body.id, byToken: matched.id, at: Date.now() })
					this.store.revoke?.(body.id)
					this.killDevicesByTokenId(body.id, 'token revoked')
					this.replyJson(res, corsHeaders, { ok: true })
					return
				}
				res.writeHead(400, corsHeaders)
				res.end()
				return
			}
			/* /qr.svg */
			const { toQR } = await this.loadToqr()
			const host = this.pairHost()
			const port = Number(this.config?.port) || 48317
			const name = this.hostLabel()
			const payload = `narwal://pair?v=1&host=${encodeURIComponent(host)}&port=${port}&token=${encodeURIComponent(matched.secret)}&name=${encodeURIComponent(name)}`
			const data = toQR(payload, 1)
			const size = Math.round(Math.sqrt(data.length)) || 0
			res.writeHead(200, {
				'content-type': 'image/svg+xml; charset=utf-8',
				'cache-control': 'no-store',
				'x-content-type-options': 'nosniff',
			})
			res.end(renderQrSvg(data, size))
		} catch (error) {
			this.log.warn('http %s failed: %s', url.pathname, error?.message ?? String(error))
			res.writeHead(500).end()
		}
	}

	/** 让已连接的设备感知吊销:立即踢线;其自动重连将因 401 拒绝而停止。 */
	killDevicesByTokenId(tokenId, reason) {
		for (const device of [...this.devices.values()]) {
			if (device.tokenId !== tokenId) continue
			this.log.info('device %s (%s) kicked: %s', device.sessionId, device.label, reason)
			device.socket?.close(4003, String(reason).slice(0, 100))
			this.teardown(device)
			this.devices.delete(device.sessionId)
		}
	}

	replyJson(res, extra, body) {
		res.writeHead(200, { ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
		res.end(JSON.stringify(body))
	}

	readBody(req) {
		return new Promise((resolve, reject) => {
			const chunks = []
			req.on('data', (c) => chunks.push(c))
			req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
			req.on('error', reject)
		})
	}

	loadToqr() {
		this.toqrp ||= import('./vendor/toqr.mjs').catch(async () => {
			const argv1 = process.argv[1] ?? ''
			const cutAt = argv1.indexOf('/node_modules/')
			if (cutAt > 0) {
				try {
					return await import(`file://${argv1.slice(0, cutAt)}/node_modules/toqr/dist/toqr.mjs`)
				} catch { /* nop */ }
			}
			throw new Error('toqr unavailable')
		})
		return this.toqrp
	}

	hostLabel() {
		return this.config?.advertiseName ?? 'narwal'
	}

	pairHost() {
		const lan = String(this.config?.lanHost ?? '').trim()
		return lan || autoLanIp() || this.hostLabel()
	}

	async attach(ws, tokenRecord) {
		const sessionId = `nv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
		let peer = null
		try {
			peer = this.deps.createPeer?.({ principal: { kind: 'owner' }, interactions: 'answer' }) ?? null
		} catch { peer = null }
		const device = { socket: ws, peer, label: tokenRecord.label ?? tokenRecord.id, tokenId: tokenRecord.id, sessionId, streams: new Map(), pendingUnsub: new Set(), connectedAt: Date.now() }
		this.devices.set(sessionId, device)

		ws.on('message', (buf) => this.onFrame(device, buf.toString('utf8')))
		ws.on('close', () => {
			if (this.devices.get(sessionId) === device) {
				this.teardown(device)
				this.devices.delete(sessionId)
			}
		})
		ws.on('error', () => { /* close follows */ })
		for (const name of ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity', 'api-session/error']) {
			try {
				const off = this.ctx.on(name, (payload) => {
					if (this.devices.get(sessionId) !== device) return
					this.send(device, { event: name, payload })
				})
				this.fanoutOffs ??= []
				if (typeof off === 'function') this.fanoutOffs.push(off)
			} catch {
				/* event not declared in this composition */
			}
		}
		this.send(device, {
			event: 'hello',
			payload: { sessionId, label: device.label, host: this.hostLabel(), account: this.account },
		})
		this.log.info('device %s (%s) connected', sessionId, device.label)
	}

	teardown(device) {
		for (const [id, task] of device.streams) this.disposeStream(device, id, task)
		device.streams.clear()
		try { device.peer?.dispose?.() } catch { /* idempotent */ }
		device.disposed = true
		try { device.socket?.close?.() } catch { /* nop */ }
	}

	disposeStream(device, id, task) {
		if (!task) return
		try { task.iterator?.return?.() } catch { /* ended */ }
		try { task.handle?.dispose?.() } catch { /* nop */ }
	}

	send(device, frame) {
		if (device.disposed) return
		try {
			device.socket.send(JSON.stringify(frame))
		} catch { /* closing */ }
	}

	onFrame(device, text) {
		let request
		try {
			request = JSON.parse(text)
		} catch {
			this.send(device, { event: 'narwal/protocol', payload: 'frame is not JSON' })
			return
		}
		const id = typeof request?.id === 'string' ? request.id : ''
		if (request?.unsubscribe === true && id) {
			streamLog(this.ctx, 'unsub', { sessionId: device.sessionId, id })
			const task = device.streams.get(id)
			if (task) {
				device.streams.delete(id)
				this.disposeStream(device, id, task)
				this.send(device, { id, done: true })
			} else if (/^s|^i/.test(id) && typeof request?.id === 'string' && device.pendingUnsub.add(id)) {
				/* runStream 的 subscribe 若在展开中:未登记完成也提前记录,以免泄漏 */
				this.send(device, { id, done: true })
			}
			return
		}
		const ns = typeof request?.ns === 'string' ? request.ns : ''
		const method = typeof request?.method === 'string' ? request.method : ''
		if (!id || !ns || !method) {
			this.send(device, { event: 'narwal/protocol', payload: 'id/ns/method required' })
			return
		}
		const args = (request?.args && typeof request.args === 'object') ? request.args : {}
		if (request?.stream === true) {
			void this.runStream(device, id, ns, method, args)
			return
		}
		void this.deps.invoke({
			namespace: ns,
			method,
			args,
			peer: device.peer,
		}).then((value) => {
			this.send(device, { id, ok: true, value })
		}).catch((error) => {
			this.send(device, {
				id,
				ok: false,
				error: {
					code: error?.code ?? 'narwal/bridge',
					message: error?.message ?? String(error),
					details: error?.details ?? {},
				},
			})
		})
	}

	async runStream(device, id, ns, method, args) {
		if (typeof this.deps?.stream !== 'function') {
			this.send(device, { id, ok: false, error: { code: 'narwal/bridge', message: 'stream() bridge not wired' } })
			return
		}
		if (device.streams.has(id)) {
			this.send(device, { id, ok: false, error: { code: 'narwal/protocol', message: 'duplicate stream id' } })
			return
		}
		let handle = null
		try {
			handle = await this.deps.stream({ namespace: ns, method, args, peer: device.peer })
		} catch (error) {
			this.send(device, {
				id,
				ok: false,
				error: {
					code: error?.code ?? 'narwal/bridge',
					message: error?.message ?? String(error),
					details: error?.details ?? {},
				},
			})
			return
		}
		const iterator = handle?.[Symbol.asyncIterator]?.()
		if (!iterator) {
			this.send(device, { id, ok: false, error: { code: 'narwal/bridge', message: 'stream method returned no async iterator' } })
			try { handle?.dispose?.() } catch { }
			return
		}
		streamLog(this.ctx, 'runStream', { sessionId: device.sessionId, id, ns, method })
		const task = { iterator, handle }
		device.streams.set(id, task)
		if (device.pendingUnsub.has(id)) {
			device.pendingUnsub.delete(id)
			device.streams.delete(id)
			this.disposeStream(device, id, task)
			this.send(device, { id, done: true })
			return
		}
		void (async () => {
			try {
				while (true) {
					const next = await iterator.next()
					if (this.devices.get(device.sessionId) !== device) return
					if (device.streams.get(id) !== task) return
					if (next?.done) {
						device.streams.delete(id)
						this.send(device, { id, done: true })
						return
					}
					this.send(device, { id, item: next?.value })
				}
			} catch (error) {
				if (device.streams.get(id) !== task) return
				device.streams.delete(id)
				this.send(device, {
					id,
					ok: false,
					error: {
						code: error?.code ?? 'narwal/stream',
						message: error?.message ?? String(error),
						details: error?.details ?? {},
					},
				})
			} finally {
				try { handle?.dispose?.() } catch { /* nop */ }
			}
		})()
	}
}

async function build(ctx, config) {
	let wsMod = null
	try {
		wsMod = unwrapWs(await import('ws').catch(() => null)) ?? await runtimeWs()
	} catch { wsMod = null }
	if (!wsMod?.WebSocketServer) {
		ctx.logger('narwal-server').warn('ws module unavailable; bridge disabled this session')
		return null
	}
	const store = new TokenStore(process.env.DSH_HOME, config?.tokens)
	try {
		ctx.logger('narwal-server').info('token store: %s (%d tokens)', store.file, store.memory.length)
	} catch { /* logger unavailable */ }
	const connection = ctx.connection
	const gateway = ctx.typertGateway
	const bridge = new NarwalBridge(ctx, config, {
		WS: wsMod.WebSocket,
		WebSocketServer: wsMod.WebSocketServer,
		createPeer: (o) => connection?.createPeer?.(o) ?? null,
		invoke: (request) => gateway?.invoke?.(request),
		stream: (request) => gateway?.stream?.(request),
		store,
	})
	bridge.start()
	if (config?.relay?.enabled && String(config.relay?.url || '').trim() && String(config.relay?.ticket || '').trim()) {
		bridge.startRelayDialer(config.relay)
	}
	return bridge
}

export async function start(ctx, config) {
	const bridge = await build(ctx, config)
	return {
		stop() {
			try { bridge?.disposeAll?.() } catch { /* nop */ }
		},
	}
}
/** ws 是 CJS：直接导入 index.js 时命名导出挂在 default 上。 */
function unwrapWs(mod) {
	return mod?.WebSocketServer ? mod : mod?.default ?? mod
}

async function runtimeWs() {
	/* 软链安装时 impl.js 的真实路径在仓库里，裸 import('ws') 解析不到 DSH 的依赖 */
	for (const base of [process.env.DSH_HOME, join(homedir(), '.dsh')]) {
		if (!base) continue
		try {
			const mod = unwrapWs(await import(pathToFileURL(join(base, 'profiles', 'node_modules', 'ws', 'index.js')).href))
			if (mod?.WebSocketServer) return mod
		} catch { /* try next */ }
	}
	try {
		const argv1 = process.argv[1] ?? ''
		const cutAt = argv1.indexOf('/node_modules/')
		if (cutAt > 0) {
			const root = argv1.slice(0, cutAt)
			return unwrapWs(await import(`file://${root}/node_modules/ws/index.js`))
		}
	} catch { /* not reachable */ }
	return null
}
