import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { MAX_PAIRINGS } from './token-store.js?device-pairing'
import { PAIR_ID, RelayPairingStore } from './relay-pairing-store.js'
import { handshakeStep, readControl, RelaySecureSocket, sendControl } from './relay-secure-socket.js'

const TOKEN = /^[0-9a-f]{64}$/
const HANDSHAKE_TIMEOUT_MS = 8_000
const MAX_CANDIDATES = 32

export async function loadRelayV2(bridge) {
	try {
		const configured = process.env.NARWAL_NOISE_DIR || bridge.config?.relayV2?.noiseDirectory
		const directory = configured ? resolve(configured) : fileURLToPath(new URL('./vendor/relay-crypto', import.meta.url))
		const { loadNodeNoise } = await import(pathToFileURL(join(directory, 'node.mjs')).href)
		return new RelayV2(bridge, await loadNodeNoise())
	} catch {
		bridge.log.info('v2 pairing requires the Narwal Noise runtime')
		return null
	}
}

class RelayV2 {
	constructor(bridge, noise) {
		this.bridge = bridge
		this.noise = noise
		this.pairings = new RelayPairingStore(bridge.store.dir, noise)
		this.active = new Map()
		this.highest = new Map()
		this.dialers = new Map()
		this.candidates = new Set()
		this.generation = 0
		this.creating = 0
		this.closed = false
	}

	async create(label, suppliedRelay) {
		if (this.bridge.store.list().length + this.pairings.list().length + this.creating >= MAX_PAIRINGS) return null
		this.creating++
		try {
			const url = process.env.NARWAL_RELAY_URL || this.bridge.config?.relayV2?.url
			const invite = process.env.NARWAL_RELAY_INVITE
			const relayConfig = suppliedRelay === undefined && url && invite ? { url, invite } : suppliedRelay
			const relay = relayConfig == null ? null : await redeem(relayConfig)
			if (this.closed || this.bridge.stopping) throw new Error('Relay bridge is stopping')
			return this.pairings.create(label, relay)
		} finally { this.creating-- }
	}

	handleUpgrade(req, socket, head, url) {
		const id = url.searchParams.get('id')
		const mode = url.pathname === '/v2/pair' ? 'pair' : 'session'
		const record = PAIR_ID.test(id) && (mode === 'pair' ? this.pairings.pending(id) : this.pairings.paired(id))
		if (!record) return this.bridge.rejectUpgrade(socket, 404, 'Unknown v2 pairing')
		if (this.candidates.size >= MAX_CANDIDATES) return this.bridge.rejectUpgrade(socket, 503, 'Busy')
		this.bridge.v2wss.handleUpgrade(req, socket, head, ws => this.accept(ws, mode, record, 'wifi'))
	}

	accept(socket, mode, record, transport, onReady) {
		if (this.closed || this.candidates.size >= MAX_CANDIDATES) return socket.terminate()
		this.candidates.add(socket)
		const noise = this.noise
		const { privateKey } = this.pairings.identity
		const { id } = record
		let session
		let adapter
		let offered = 0
		let timer
		let handshakeFinished = false
		let waiting = transport === 'relay'
		const offersCompactReplies = waiting
		const arm = (ms) => {
			clearTimeout(timer)
			timer = setTimeout(() => socket.terminate(), ms).unref()
		}
		const begin = () => {
			session = noise.createSession({
				pattern: mode, initiator: false, privateKey, prologue: `narwal/v2/${mode}/${id}`,
				...(mode === 'pair' ? { psk: record.secret } : { remotePublicKey: record.phoneKey }),
			})
			arm(HANDSHAKE_TIMEOUT_MS)
		}
		socket.on('pong', (...args) => adapter?.emit('pong', ...args))
		socket.on('error', () => socket.terminate())
		socket.once('close', () => {
			clearTimeout(timer)
			this.candidates.delete(socket)
			if (adapter && this.active.get(id) === adapter) this.active.delete(id)
			adapter?.finish()
			if (session) {
				try { noise.close(session) } catch { /* already closed */ }
			}
		})
		if (waiting) arm(130_000)
		else {
			try { begin() } catch { return socket.terminate() }
		}
		socket.on('message', (data, isBinary) => {
			try {
				if (!isBinary && transport === 'relay') {
					if (data.length > 256) throw new Error('Oversized relay control')
					const status = JSON.parse(data.toString('utf8'))?.type
					if (status === 'waiting' && waiting) return
					if (status === 'peer_left') return socket.close(1000)
					if (status === 'ready' && waiting) {
						waiting = false
						begin()
						return
					}
				}
				if (!isBinary || !session || !data.length) throw new Error('Expected Noise record')
				if (adapter) return adapter.receive(data)
				if (!handshakeFinished) {
					if (data.length > 256) throw new Error('Oversized Noise handshake')
					if (!handshakeStep(noise, session, data, socket)) return
					handshakeFinished = true
					if (mode === 'pair') return this.enroll(record, noise.remotePublicKey(session), session, socket)
					offered = ++this.generation
					sendControl(noise, session, socket, { type: 'offer', ...(offersCompactReplies ? { compactReplies: true } : {}) })
					return
				}
				const current = this.pairings.paired(id)
				if (!current || current.phoneKey !== record.phoneKey || !offered || offered <= (this.highest.get(id) ?? 0) ||
					data.length > 4112) throw new Error('Invalid activation')
				const activation = readControl(noise, session, data)
				if (activation?.type !== 'activate') throw new Error('Invalid activation')
				const compactReplies = offersCompactReplies && activation.compactReplies === true
				const previous = this.active.get(id)
				adapter = new RelaySecureSocket(socket, noise, session, transport, () => this.active.get(id) === adapter, compactReplies)
				this.highest.set(id, offered)
				this.active.set(id, adapter)
				this.candidates.delete(socket)
				previous?.terminate()
				clearTimeout(timer)
				sendControl(noise, session, socket, { type: 'activated', ...(compactReplies ? { compactReplies: true } : {}) })
				onReady?.()
				void this.bridge.attach(adapter, { id, label: current.label, transport }, false).catch(() => adapter.terminate())
			} catch {
				socket.terminate()
			}
		})
	}

	enroll(pending, phoneKey, session, socket) {
		const desktopId = this.bridge.store.getDesktopId()
		if (!desktopId) throw new Error('Desktop identity store unavailable')
		const enrolled = this.pairings.claim(pending, phoneKey)
		if (!enrolled) throw new Error('Pairing invitation expired or already consumed')
		const { record, phoneRelay } = enrolled
		sendControl(this.noise, session, socket, {
			type: 'paired', desktopId, hostname: hostname(), ...(phoneRelay ? { relay: phoneRelay } : {}),
		})
		socket.close(1000)
		this.startDialer(record)
	}

	startDialer(record) {
		if (!record.relay || this.dialers.has(record.id) || this.closed) return
		const { url, host, expiresAt } = record.relay
		if (expiresAt <= Date.now()) return
		const entry = { attempts: 0, socket: null, timer: null, healthy: null, terminal: false }
		this.dialers.set(record.id, entry)
		const retry = (quick = false) => {
			if (this.closed || entry.terminal || expiresAt <= Date.now() || entry.timer) return
			const ceiling = quick ? 250 : Math.min(1_000 * 2 ** Math.min(entry.attempts++, 6), 60_000)
			entry.timer = setTimeout(() => {
				entry.timer = null
				dial()
			}, Math.max(25, Math.random() * ceiling)).unref()
		}
		const dial = () => {
			if (this.closed || entry.terminal || expiresAt <= Date.now() || !this.pairings.paired(record.id)) return
			let socket
			try {
				socket = new this.bridge.deps.WS(new URL('/v2/ws/host', url), {
					headers: { authorization: `Bearer ${host.token}`, 'x-narwal-relay-resume': host.resume },
					maxPayload: 65535, maxFragments: 8, maxBufferedChunks: 128, maxPendingAutoPongs: 8,
					perMessageDeflate: false, handshakeTimeout: 5_000,
				})
			} catch { return retry() }
			entry.socket = socket
			socket.on('error', () => { /* close schedules retry */ })
			socket.on('unexpected-response', (_request, response) => {
				if (response.statusCode === 401 || response.statusCode === 403) entry.terminal = true
				response.resume()
				socket.terminate()
			})
			socket.once('open', () => {
				entry.healthy = setTimeout(() => { entry.attempts = 0 }, 20_000).unref()
				this.accept(socket, 'session', record, 'relay', () => { entry.attempts = 0 })
			})
			socket.once('close', (code, reason) => {
				clearTimeout(entry.healthy)
				entry.socket = null
				if (code === 4003 || code === 4005) entry.terminal = true
				retry(code === 1000 || (code === 4000 && reason.toString() === 'peer_left'))
			})
		}
		dial()
	}

	stopDialer(id) {
		const entry = this.dialers.get(id)
		if (!entry) return
		this.dialers.delete(id)
		entry.terminal = true
		clearTimeout(entry.timer)
		clearTimeout(entry.healthy)
		entry.socket?.terminate()
	}

	revoke(id) {
		this.pairings.revoke(id)
		this.stopDialer(id)
		this.active.get(id)?.terminate()
		this.highest.delete(id)
	}

	stop() {
		this.closed = true
		for (const id of this.dialers.keys()) this.stopDialer(id)
		for (const socket of this.candidates) socket.terminate()
		for (const socket of this.active.values()) socket.terminate()
	}
}

async function redeem(config) {
	if (!TOKEN.test(config?.invite)) throw new Error('Invalid relay invite')
	const url = new URL(config.url)
	const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
	if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
		(!['https:', 'wss:'].includes(url.protocol) && !(loopback && ['http:', 'ws:'].includes(url.protocol)))) {
		throw new Error('Relay requires a trusted WSS origin')
	}
	const secure = ['https:', 'wss:'].includes(url.protocol)
	url.protocol = secure ? 'https:' : 'http:'
	const response = await fetch(new URL('/v2/invites/redeem', url), {
		method: 'POST', headers: { authorization: `Bearer ${config.invite}` },
		redirect: 'error', signal: AbortSignal.timeout(5_000),
	})
	if (response.status !== 201) throw new Error('Relay invite could not be redeemed')
	const text = await response.text()
	if (text.length > 4096) throw new Error('Invalid relay grant')
	const value = JSON.parse(text)
	const expiresAt = value.expires_at * 1_000
	if (![value.host_token, value.host_resume, value.phone_token, value.phone_resume].every(token => TOKEN.test(token)) ||
		!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid relay grant')
	url.protocol = secure ? 'wss:' : 'ws:'
	return {
		url: url.origin, expiresAt, host: { token: value.host_token, resume: value.host_resume },
		phone: { token: value.phone_token, resume: value.phone_resume },
	}
}
