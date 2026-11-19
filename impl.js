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
import { once } from 'node:events'
import { createServer, STATUS_CODES } from 'node:http'
import { homedir, hostname, userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { handlePanelRequest } from './bridge-panel.js?lan-host-selection'
import { handleDeviceFrame } from './bridge-rpc.js'
import { createGitHubProjectsInstaller } from './github-projects-install.js'
// A linked DSH profile can still have the pre-pairing modules in its ESM cache.
import { TokenStore } from './token-store.js?device-pairing'
import { TrafficUsage } from './traffic-usage.js'
import { openQuestionEvents, watchPendingQuestions } from './user-questions.js?passive-notices'

const SESSION_EVENTS = ['api-session/added', 'api-session/removed', 'api-session/status', 'api-session/activity', 'api-session/error']

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

class NarwalBridge {
	constructor(ctx, config, deps) {
		this.account = readDesktopAccount()
		this.ctx = ctx
		this.config = config
		this.deps = deps
		this.store = deps.store
		this.log = ctx.logger('narwal-server')
		this.traffic = new TrafficUsage(this.store.dir, this.log)
		this.devices = new Map()
		this.stopping = false
		this.fanoutOffs = []
		this.watchPendingQuestions = watchPendingQuestions(ctx.typertGateway, sessionId => {
			this.notice({ kind: 'agent-question', sessionId })
		})
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
				try { this.relay.socket?.terminate?.() } catch { /* nop */ }
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

	async start() {
		this.server = createServer((req, res) => {
			void handlePanelRequest(this, req, res)
		})
		this.server.on('error', (err) => this.log.warn('bridge http error: %s', err?.message))

		this.wss = new this.deps.WebSocketServer({ noServer: true })
		this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))

		const port = (this.config && Number(this.config.port)) || 48317
		await once(this.server.listen(port, '0.0.0.0'), 'listening')
		this.log.info('narwal bridge listening on %d (ws /ws?token=...)', port)
		this.listenForHostEvents()

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
		if (this.stopping) return this.stopTask
		this.stopping = true
		this.watchPendingQuestions(false)
		this.stopTask = new Promise((resolve) => {
			if (!this.server) {
				resolve()
				return
			}
			this.server.close(() => resolve())
			this.server.closeAllConnections()
		})
		try { this.relay?.dispose?.() } catch { /* nop */ }
		for (const off of this.fanoutOffs) {
			try { off?.() } catch { /* nop */ }
		}
		this.fanoutOffs = []
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.aliveFails?.clear()
		for (const device of [...this.devices.values()]) this.teardown(device)
		this.devices.clear()
		for (const socket of this.wss?.clients ?? []) socket.terminate()
		try { this.wss?.close() } catch { /* nop */ }
		this.traffic.close()
		this.log.info('bridge stopped; devices disposed')
		return this.stopTask
	}

	listenForHostEvents() {
		const listen = (name, receive, options) => {
			try {
				const off = this.ctx.on(name, receive, options)
				if (typeof off === 'function') this.fanoutOffs.push(off)
			} catch { /* event not declared in this composition */ }
		}
		for (const event of SESSION_EVENTS) {
			listen(event, payload => {
				for (const device of this.devices.values()) {
					if (device.active) this.send(device, { event, payload })
				}
			})
		}
		listen('session/event', (session, event) => {
			if (event?.type !== 'turn/end' || event.data.reason?.kind !== 'completed') return
			if (typeof session?.id !== 'string' || session.header?.origin === 'subagent') return
			const sequence = event.seq ?? event.data.turn
			if (!Number.isSafeInteger(sequence)) return
			this.notice({ kind: 'task-complete', sessionId: session.id, eventId: String(sequence) })
		}, { global: true })
	}

	notice(payload) {
		for (const device of this.devices.values()) {
			if (!device.active && device.peer) this.send(device, { event: 'narwal/notification', payload })
		}
	}

	refreshQuestionWatcher() {
		const observing = !this.stopping && [...this.devices.values()]
			.some(device => device.peer && !device.active && !device.disposed)
		this.watchPendingQuestions(observing)
	}

	findToken(secret) {
		return this.store.list().find((t) => t.secret === secret) ?? null
	}

	handleUpgrade(req, socket, head) {
		if (this.stopping) {
			socket.destroy()
			return
		}
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
		const deviceId = url.searchParams.get('deviceId')
		const deviceError = this.store.checkDevice(matched, deviceId)
		if (deviceError) {
			this.rejectUpgrade(socket, 403, deviceError)
			return
		}
		this.wss.handleUpgrade(req, socket, head, (ws) => {
			try {
				this.store.claim(matched, deviceId)
			} catch {
				ws.close(1011, 'Could not save device binding')
				return
			}
			void this.attach(ws, matched, url.searchParams.get('notificationsOnly') !== '1')
		})
	}

	rejectUpgrade(socket, status, message) {
		socket.write(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nconnection: close\r\ncontent-length: ${message.length}\r\n\r\n${message}`)
		socket.destroy()
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

	hostLabel() {
		return this.config?.advertiseName ?? 'narwal'
	}

	async attach(ws, tokenRecord, active = true) {
		if (this.stopping) {
			ws.terminate()
			return
		}
		const sessionId = `nv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
		let peer = null
		try {
			peer = this.deps.createPeer?.({ principal: { kind: 'owner' }, interactions: 'answer' }) ?? null
		} catch { peer = null }
		const device = {
			socket: ws, peer, label: tokenRecord.label ?? tokenRecord.id, tokenId: tokenRecord.id, sessionId,
			active, activityRevision: 0, streams: new Map(), pendingUnsub: new Set(), connectedAt: Date.now(),
		}
		this.devices.set(sessionId, device)
		this.refreshQuestionWatcher()

		ws.on('message', (buf) => handleDeviceFrame(this, device, buf.toString('utf8')))
		ws.on('close', () => {
			if (this.devices.get(sessionId) === device) {
				this.teardown(device)
				this.devices.delete(sessionId)
			}
		})
		ws.on('error', () => { /* close follows */ })
		this.send(device, {
			event: 'hello',
			payload: {
				sessionId, label: device.label, host: this.hostLabel(), hostname: hostname(),
				account: active ? this.account : undefined, githubProjects: true, desktopId: this.store.getDesktopId(),
			},
		})
		this.log.info('device %s (%s) connected', sessionId, device.label)
	}

	teardown(device) {
		for (const [id, task] of device.streams) this.disposeStream(device, id, task)
		device.streams.clear()
		try { device.peer?.dispose?.() } catch { /* idempotent */ }
		device.disposed = true
		this.refreshQuestionWatcher()
		try { device.socket?.close?.() } catch { /* nop */ }
	}

	setDeviceActive(device, id, active) {
		if (!device.peer || device.tokenId === 'relay' || typeof active !== 'boolean') {
			this.send(device, { id, ok: false, error: { code: 'narwal/device-role-unavailable', message: 'Device role is unavailable' } })
			return
		}
		const changed = device.active !== active
		if (changed) {
			device.active = active
			device.activityRevision++
			if (!active) {
				for (const [streamId, task] of device.streams) {
					device.streams.delete(streamId)
					this.disposeStream(device, streamId, task)
				}
				device.pendingUnsub.clear()
			}
			this.refreshQuestionWatcher()
		}
		this.send(device, { id, ok: true, value: { active } })
		if (changed && active) this.send(device, { event: 'narwal/active', payload: { account: this.account } })
	}

	disposeStream(device, id, task) {
		if (!task) return
		try { task.iterator?.return?.()?.catch?.(() => {}) } catch { /* ended */ }
		try { task.handle?.dispose?.() } catch { /* nop */ }
	}

	send(device, frame, meter = true) {
		if (device.disposed) return
		try {
			const payload = JSON.stringify(frame)
			const transport = device.socket === this.relay?.socket ? 'relay' : 'wifi'
			const bytes = meter ? Buffer.byteLength(payload) : 0
			device.socket.send(payload, error => {
				if (!error && bytes) this.traffic.record(transport, bytes)
			})
		} catch { /* closing */ }
	}
}

async function build(ctx, config, runtime) {
	let wsMod = null
	try {
		wsMod = unwrapWs(runtime?.ws) ?? await runtimeWs()
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
	const questionRpc = connection?.createSharedFetchHandler?.('/api')
	const bridge = new NarwalBridge(ctx, config, {
		WS: wsMod.WebSocket,
		WebSocketServer: wsMod.WebSocketServer,
		createPeer: (o) => connection?.createPeer?.(o) ?? null,
		invoke: (request) => gateway?.invoke?.(request),
		stream: (request) => gateway?.stream?.(request),
		openQuestionEvents: (device) => openQuestionEvents(gateway, questionRpc, device),
		githubProjectsInstaller: createGitHubProjectsInstaller(() => ctx.get('pluginManager')),
		store,
	})
	runtime?.registerStop?.(() => bridge.disposeAll())
	try {
		await bridge.start()
		if (config?.relay?.enabled && String(config.relay?.url || '').trim() && String(config.relay?.ticket || '').trim()) {
			bridge.startRelayDialer(config.relay)
		}
		return bridge
	} catch (error) {
		try { await bridge.disposeAll() } catch { /* retain startup error */ }
		throw error
	}
}

export async function start(ctx, config, runtime) {
	const bridge = await build(ctx, config, runtime)
	if (!bridge) throw new Error('ws module unavailable; bridge not started')
	return {
		stop() {
			return bridge.disposeAll()
		},
	}
}
/** ws 是 CJS：直接导入 index.js 时命名导出挂在 default 上。 */
function unwrapWs(mod) {
	return mod?.WebSocketServer ? mod : mod?.default ?? mod
}

async function runtimeWs() {
	const dependency = unwrapWs(await import('ws').catch(() => null))
	if (dependency?.WebSocketServer) return dependency
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
