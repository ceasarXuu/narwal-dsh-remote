import { EventEmitter } from 'node:events'
import { performance } from 'node:perf_hooks'

const CHUNK_BYTES = 16 * 1024
const MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_SEND_BUFFER = 128 * 1024
const MAX_PENDING_MESSAGES = 128
const MAX_FRAGMENTS = MESSAGE_BYTES / CHUNK_BYTES
const FRAGMENT_TTL_MS = 30_000
const RELAY_BYTES_PER_MS = 100
const PROMPT_REPLY_BYTES = 4 * 1024
const ARTIFACT_REPLY_FLAG = 4

export function encodeArtifactReply(id, data) {
	if (typeof id !== 'string' || !/^i[1-9]\d{0,15}$/.test(id) || !data.length || data.length + id.length + 1 > CHUNK_BYTES) {
		return JSON.stringify({ id, ok: true, value: { data: data.toString('base64') } })
	}
	const headerLength = id.length + 1
	const packet = Buffer.allocUnsafe(headerLength + data.length)
	packet[0] = id.length
	packet.write(id, 1, 'ascii')
	data.copy(packet, headerLength)
	return packet
}

export function readRecord(data) {
	return Buffer.from(data).toString('base64')
}

export function handshakeStep(noise, session, data, socket) {
	noise.handshakeRead(session, readRecord(data))
	if (!noise.isHandshakeFinished(session)) {
		socket.send(Buffer.from(noise.handshakeWrite(session), 'base64'), { binary: true })
	}
	return noise.isHandshakeFinished(session)
}

export function sendControl(noise, session, socket, control) {
	sendProtected(noise, session, socket, Buffer.from(JSON.stringify(control)))
}

export function readControl(noise, session, data) {
	const value = Buffer.from(noise.decrypt(session, readRecord(data)), 'base64')
	if (value.length > 4096) throw new Error('Oversized encrypted control message')
	return JSON.parse(value.toString('utf8'))
}

function sendProtected(noise, session, socket, plaintext, done) {
	if (socket.readyState !== 1 || socket.bufferedAmount > MAX_SEND_BUFFER) throw new Error('Backpressured secure socket')
	const ciphertext = Buffer.from(noise.encrypt(session, plaintext.toString('base64')), 'base64')
	socket.send(ciphertext, { binary: true }, done)
}

export class RelaySecureSocket extends EventEmitter {
	constructor(socket, noise, session, transport, selected, compactReplies) {
		super()
		this.socket = socket
		this.noise = noise
		this.session = session
		this.transport = transport
		this.selected = selected
		this.compactReplies = compactReplies
		this.fragments = []
		this.inboundBytes = 0
		this.outgoing = []
		this.outboundBytes = 0
		this.nextSend = 0
		this.lastWasCompact = false
		this.closed = false
	}

	receive(data) {
		if (!this.selected() || this.closed) return
		const plaintext = Buffer.from(this.noise.decrypt(this.session, readRecord(data)), 'base64')
		const [flag] = plaintext
		const body = plaintext.subarray(1)
		if (flag === 2) return this.receiveControl(body)
		if ((flag !== 0 && flag !== 1) || !body.length || body.length > CHUNK_BYTES ||
			this.fragments.length >= MAX_FRAGMENTS || this.inboundBytes + body.length > MESSAGE_BYTES) {
			throw new Error('Invalid secure message fragment')
		}
		if (flag === 1) {
			if (!this.fragments.length) this.fragmentTimer = setTimeout(() => this.terminate(), FRAGMENT_TTL_MS).unref()
			this.fragments.push(body)
			this.inboundBytes += body.length
			return
		}
		clearTimeout(this.fragmentTimer)
		const message = this.fragments.length ? Buffer.concat([...this.fragments, body], this.inboundBytes + body.length) : body
		this.fragments = []
		this.inboundBytes = 0
		const value = JSON.parse(message.toString('utf8'))
		if (value?.type === 'ping' && Number.isSafeInteger(value.id) && value.id >= 0) {
			this.send(JSON.stringify({ type: 'pong', id: value.id }))
			return
		}
		this.emit('message', value)
	}

	receiveControl(body) {
		if (body.length > 256) throw new Error('Oversized liveness control record')
		const value = JSON.parse(body.toString('utf8'))
		if (value?.type !== 'ping' || !Number.isSafeInteger(value.id) || value.id < 0) throw new Error('Invalid liveness control record')
		const pong = Buffer.concat([Buffer.from([2]), Buffer.from(JSON.stringify({ type: 'pong', id: value.id }))])
		sendProtected(this.noise, this.session, this.socket, pong)
	}

	send(data, done, unary = false) {
		const artifact = Buffer.isBuffer(data)
		const body = artifact ? data : Buffer.from(data)
		if (this.closed || !this.selected()) return done?.(new Error('Secure socket is no longer active'))
		if (!body.length || this.outboundBytes + body.length > MESSAGE_BYTES || this.outgoing.length >= MAX_PENDING_MESSAGES) {
			done?.(new Error('Secure message budget exhausted'))
			this.terminate()
			return
		}
		const compact = this.compactReplies && unary && body.length <= CHUNK_BYTES
		this.outgoing.push({ body, offset: 0, wireBytes: 0, interleavedBytes: 0, done, compact, artifact })
		this.outboundBytes += body.length
		this.writeNext()
	}

	writeNext() {
		if (this.closed || this.writing || !this.outgoing.length) return
		if (!this.selected()) return this.terminate()
		const head = this.outgoing[0]
		const mayInterleave = head.offset > 0 && !this.lastWasCompact
		// Bound interleaving during a fragmented message independently of the relay rate.
		const budget = Math.max(CHUNK_BYTES, head.offset / 4) - head.interleavedBytes
		const delay = Math.ceil(this.nextSend - performance.now())
		const promptReply = delay > 0 && !this.lastWasCompact
			? this.outgoing.findIndex(item => item.offset === 0 && item.compact &&
				item.body.length <= Math.min(PROMPT_REPLY_BYTES, budget)) : -1
		if (delay > 0 && promptReply < 0) {
			this.writeTimer ??= setTimeout(() => {
				this.writeTimer = null
				this.writeNext()
			}, delay).unref()
			return
		}
		clearTimeout(this.writeTimer)
		this.writeTimer = null
		const candidate = mayInterleave ? this.outgoing.findIndex(item => item.compact) : -1
		const interleave = candidate > 0 && this.outgoing[candidate].body.length <= budget ? candidate : 0
		const index = promptReply >= 0 ? promptReply : interleave
		const interruptedMessage = index > 0 && head.offset > 0
		const item = this.outgoing[index]
		const end = Math.min(item.offset + CHUNK_BYTES, item.body.length)
		const complete = end === item.body.length
		const plaintext = Buffer.allocUnsafe(end - item.offset + 1)
		plaintext[0] = item.artifact ? ARTIFACT_REPLY_FLAG : interruptedMessage ? 3 : complete ? 0 : 1
		item.body.copy(plaintext, 1, item.offset, end)
		this.writing = true
		try {
			sendProtected(this.noise, this.session, this.socket, plaintext, error => {
				if (this.closed) return
				this.writing = false
				if (error) return this.terminate()
				item.offset = end
				item.wireBytes += plaintext.length + 16
				this.lastWasCompact = promptReply >= 0 || interruptedMessage
				if (interruptedMessage) head.interleavedBytes += item.body.length
				// An early reply borrows time from the next regular frame without raising the sustained rate.
				if (this.transport === 'relay') this.nextSend = Math.max(this.nextSend, performance.now()) +
					(plaintext.length + 16) / RELAY_BYTES_PER_MS
				if (complete) {
					this.outgoing.splice(index, 1)
					this.outboundBytes -= item.body.length
					item.done?.(undefined, item.wireBytes)
				}
				this.writeNext()
			})
		} catch {
			this.terminate()
		}
	}

	ping() { this.socket.ping() }
	close() { this.terminate() }

	terminate() {
		this.socket.terminate()
		this.finish()
	}

	finish() {
		if (this.closed) return
		this.closed = true
		clearTimeout(this.fragmentTimer)
		clearTimeout(this.writeTimer)
		this.fragments = []
		const outgoing = this.outgoing
		this.outgoing = []
		for (const item of outgoing) item.done?.(new Error('Secure socket closed'))
		this.emit('close')
	}
}
