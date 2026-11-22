import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const HANDSHAKE_TIMEOUT = 5_000
const READ_WAIT = 8_000
const WRITE_TIMEOUT = 8_000

// Keep reads pull-based so Node's socket buffer applies backpressure when the phone is slow.
function waitForReadable(socket) {
	return new Promise(resolve => {
		const finish = () => {
			clearTimeout(timer)
			socket.off('readable', finish)
			socket.off('end', finish)
			socket.off('close', finish)
			resolve()
		}
		const timer = setTimeout(finish, READ_WAIT).unref()
		socket.once('readable', finish)
		socket.once('end', finish)
		socket.once('close', finish)
	})
}

export class LocalWebSocket {
	constructor(device, blockBytes) {
		this.id = randomUUID()
		this.device = device
		this.blockBytes = blockBytes
	}

	open(port, path, headers, maxHeaderSize) {
		return new Promise((resolve, reject) => {
			const request = this.request = httpRequest({
				hostname: '127.0.0.1', port, path, headers, agent: false, maxHeaderSize,
			})
			const timer = setTimeout(() => request.destroy(new Error('WebSocket upgrade timed out')), HANDSHAKE_TIMEOUT).unref()
			request.once('error', error => {
				clearTimeout(timer)
				reject(error)
			})
			request.once('response', response => {
				clearTimeout(timer)
				response.destroy()
				reject(new Error('Desktop service did not upgrade to WebSocket'))
			})
			request.once('upgrade', (response, socket, head) => {
				clearTimeout(timer)
				socket.on('error', () => { /* A failed socket reaches EOF on the next read. */ })
				socket.pause()
				this.socket = socket
				this.head = head
				resolve(response)
			})
			request.end()
		})
	}

	readBlock() {
		const { socket } = this
		const head = this.head.subarray(0, this.blockBytes)
		this.head = this.head.subarray(head.length)
		const count = Math.min(this.blockBytes - head.length, socket.readableLength)
		const body = count ? socket.read(count) : null
		const eof = !this.head.length && !socket.readableLength && (socket.readableEnded || socket.destroyed)
		if (!head.length && !body && !eof) return
		const data = body && head.length ? Buffer.concat([head, body]) : body ?? head
		return { body: data.toString('base64'), eof }
	}

	async read() {
		if (!this.socket || this.reading) throw new Error('WebSocket read unavailable')
		this.reading = true
		try {
			const block = this.readBlock()
			if (block) return block
			await waitForReadable(this.socket)
			return this.readBlock() ?? { body: '', eof: false }
		} finally {
			this.reading = false
		}
	}

	async write(bytes) {
		const { socket } = this
		if (!bytes?.length || !socket?.writable || this.writing) throw new Error('WebSocket write unavailable')
		this.writing = true
		try {
			await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					socket.destroy()
					reject(new Error('WebSocket write timed out'))
				}, WRITE_TIMEOUT).unref()
				socket.write(bytes, error => {
					clearTimeout(timer)
					if (error) reject(error)
					else resolve()
				})
			})
		} finally {
			this.writing = false
		}
	}

	close() {
		this.socket?.destroy()
		this.request?.destroy()
	}
}
