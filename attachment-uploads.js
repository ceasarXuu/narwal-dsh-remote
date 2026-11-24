import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const ID = /^[A-Za-z0-9._:-]{1,128}$/
const CHUNK_BYTES = 11_250
const FILE_LIMIT = 32 * 1024 * 1024
const PAIR_BYTES = 64 * 1024 * 1024
const TOTAL_BYTES = 256 * 1024 * 1024
const PAIR_IN_PROGRESS = 4
const TOTAL_IN_PROGRESS = 32
const PAIR_RECORDS = 32
const TOTAL_RECORDS = 128
const TTL_MS = 10 * 60_000
const RUN_DIR = /^run-([1-9]\d{0,9})-[A-Za-z0-9]{6}$/

function uploadError(reason, message) {
	return Object.assign(new Error(message), { code: `narwal/upload-${reason}` })
}

function badRequest() {
	return uploadError('bad-request', '附件上传请求无效。')
}

function conflict() {
	return uploadError('conflict', '附件上传内容或进度已变化。请重新读取上传进度。')
}

function unavailable() {
	return uploadError('unavailable', '桌面暂时无法上传此附件。')
}

function missing() {
	return uploadError('missing', '附件暂存已失效。请重新开始上传。')
}

function details({ name, size, mediaType }) {
	if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/u.test(name) ||
		!Number.isSafeInteger(size) || size < 0 || (mediaType !== undefined && mediaType !== 'image/jpeg')) throw badRequest()
	if (size > FILE_LIMIT) throw uploadError('limit', '单个附件不能超过 32 MiB。')
	return { name, size, mediaType }
}

function decodeChunk({ offset, data }) {
	if (!Number.isSafeInteger(offset) || offset < 0 || !data?.length) throw badRequest()
	if (Buffer.isBuffer(data)) {
		if (data.length > CHUNK_BYTES) throw badRequest()
		return data
	}
	if (typeof data !== 'string' || data.length > CHUNK_BYTES * 4 / 3) {
		throw badRequest()
	}
	const bytes = Buffer.from(data, 'base64')
	if (!bytes.length || bytes.toString('base64') !== data) throw badRequest()
	return bytes
}

function position(upload) {
	const { offset, receiptId } = upload
	return receiptId ? { offset, receiptId } : { offset }
}

async function verifyPrivateDirectory(path) {
	const info = await lstat(path)
	if (!info.isDirectory() || (info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) throw unavailable()
}

async function removeAbandonedRuns(root) {
	try { await verifyPrivateDirectory(root) }
	catch (error) {
		if (error.code === 'ENOENT') return
		throw error
	}
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const match = entry.isDirectory() && RUN_DIR.exec(entry.name)
		if (!match) continue
		try { process.kill(Number(match[1]), 0) }
		catch (error) {
			if (error.code === 'ESRCH') await rm(join(root, entry.name), { recursive: true, force: true })
		}
	}
}

export class AttachmentUploads {
	constructor(bridge) {
		this.bridge = bridge
		this.entries = new Map()
		this.root = join(bridge.store.dir, 'attachment-uploads')
		this.startupCleanup = removeAbandonedRuns(this.root).catch(() => this.reportCleanupFailure())
		this.sweep = setInterval(() => {
			for (const upload of this.entries.values()) {
				if (upload.expiresAt <= Date.now()) this.discard(upload)
			}
		}, 60_000).unref()
	}

	get service() {
		const service = this.bridge.ctx.get('fileUploads')
		return typeof service?.uploadStream === 'function' && typeof service.uploadImageStream === 'function' ? service : undefined
	}

	get available() { return Boolean(this.service) }

	async invoke(device, args) {
		if (this.closed || device.disposed || !device.active || !device.transport || !device.peer ||
			!this.bridge.relayV2?.pairings.paired(device.tokenId) || !this.available) throw unavailable()
		const { action, sessionId, uploadId } = args
		if (typeof sessionId !== 'string' || !ID.test(sessionId) || typeof uploadId !== 'string' || !ID.test(uploadId) ||
			!['open', 'append', 'finish', 'cancel'].includes(action)) throw badRequest()
		const pairId = device.tokenId
		const key = JSON.stringify([pairId, sessionId, uploadId])
		let upload = this.entries.get(key)
		if (action === 'cancel') {
			if (upload) await this.discard(upload)
			return { offset: 0 }
		}
		if (upload?.expiresAt <= Date.now()) {
			await this.discard(upload)
			if (this.closed || !this.bridge.relayV2?.pairings.paired(pairId)) throw unavailable()
			upload = this.entries.get(key)
		}
		if (action === 'open') {
			const meta = details(args)
			if (!upload) upload = this.reserve(key, pairId, sessionId, meta)
			if (upload.name !== meta.name || upload.size !== meta.size || upload.mediaType !== meta.mediaType) throw conflict()
		}
		if (!upload || upload.controller.signal.aborted) throw missing()
		if (upload.queued >= 4) throw uploadError('limit', '附件当前有过多未完成的请求。')
		upload.queued++
		const result = upload.pending.then(async () => {
			if (upload.controller.signal.aborted) throw missing()
			let value
			if (action === 'open') value = position(upload)
			else if (action === 'append') value = await this.append(upload, args, decodeChunk(args))
			else value = await this.finish(upload)
			upload.expiresAt = Date.now() + TTL_MS
			return value
		}).finally(() => { upload.queued-- })
		upload.pending = result.catch(() => {})
		return result
	}

	reserve(key, pairId, sessionId, meta) {
		const records = [...this.entries.values()]
		const ownRecords = records.filter(upload => upload.pairId === pairId)
		const partial = records.filter(upload => !upload.receiptId || upload.path)
		const ownPartial = partial.filter(upload => upload.pairId === pairId)
		const bytes = uploads => uploads.reduce((total, upload) => total + upload.size, meta.size)
		if (records.length >= TOTAL_RECORDS || ownRecords.length >= PAIR_RECORDS ||
			partial.length >= TOTAL_IN_PROGRESS || ownPartial.length >= PAIR_IN_PROGRESS ||
			bytes(partial) > TOTAL_BYTES || bytes(ownPartial) > PAIR_BYTES) {
			throw uploadError('limit', '桌面附件暂存已满。请取消未完成的附件上传或稍后重试。')
		}
		const upload = {
			key, pairId, sessionId, ...meta, offset: 0, queued: 0,
			pending: Promise.resolve(), controller: new AbortController(), expiresAt: Date.now() + TTL_MS,
		}
		this.entries.set(key, upload)
		return upload
	}

	async stage(upload) {
		if (upload.handle) return upload.handle
		this.directory ??= this.createDirectory().catch(error => {
			this.directory = undefined
			throw error
		})
		const directory = await this.directory
		upload.controller.signal.throwIfAborted()
		const path = join(directory, randomUUID())
		const handle = await open(path, 'wx+', 0o600)
		upload.path = path
		upload.handle = handle
		return handle
	}

	async createDirectory() {
		await this.startupCleanup
		await mkdir(this.root, { recursive: true, mode: 0o700 })
		await verifyPrivateDirectory(this.root)
		return mkdtemp(join(this.root, `run-${process.pid}-`))
	}

	async append(upload, { offset }, bytes) {
		const end = offset + bytes.length
		if (upload.receiptId || offset > upload.offset || end > upload.size) throw conflict()
		const handle = await this.stage(upload)
		if (offset < upload.offset) {
			if (end > upload.offset) throw conflict()
			const saved = Buffer.alloc(bytes.length)
			for (let done = 0; done < saved.length;) {
				const { bytesRead } = await handle.read(saved, done, saved.length - done, offset + done)
				if (!bytesRead) throw conflict()
				done += bytesRead
			}
			if (!saved.equals(bytes)) throw conflict()
			return position(upload)
		}
		for (let done = 0; done < bytes.length;) {
			const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, offset + done)
			if (!bytesWritten) throw unavailable()
			done += bytesWritten
		}
		upload.offset = end
		return position(upload)
	}

	async finish(upload) {
		if (upload.receiptId) return position(upload)
		if (upload.offset !== upload.size) throw conflict()
		const service = this.service
		if (!service) throw unavailable()
		await this.stage(upload)
		const { sessionId, name, mediaType, controller: { signal } } = upload
		const data = createReadStream(upload.path, { signal })
		// An abort before DSH starts iterating still belongs to this request.
		data.on('error', () => {})
		try {
			const result = mediaType
				? await service.uploadImageStream({ sessionId, data, name, mediaType, signal })
				: await service.uploadStream({ sessionId, data, name, signal })
			if (typeof result?.receiptId !== 'string' || !result.receiptId) throw unavailable()
			upload.receiptId = result.receiptId
		} finally { data.destroy() }
		await this.releaseFile(upload).catch(() => this.reportCleanupFailure())
		return position(upload)
	}

	async releaseFile(upload) {
		if (upload.handle) {
			await upload.handle.close()
			upload.handle = undefined
		}
		if (upload.path) {
			await rm(upload.path, { force: true })
			upload.path = undefined
		}
	}

	discard(upload) {
		upload.controller.abort()
		upload.discarding ??= upload.pending.then(async () => {
			await this.releaseFile(upload)
			this.entries.delete(upload.key)
		}).catch(() => {
			upload.discarding = undefined
			this.reportCleanupFailure()
		})
		return upload.discarding
	}

	revoke(pairId) {
		for (const upload of this.entries.values()) {
			if (upload.pairId === pairId) this.discard(upload)
		}
	}

	async close() {
		this.closed = true
		clearInterval(this.sweep)
		await Promise.all([...this.entries.values()].map(upload => this.discard(upload)))
		await this.startupCleanup
		const directory = await this.directory?.catch(() => undefined)
		if (directory) await rm(directory, { recursive: true, force: true }).catch(() => this.reportCleanupFailure())
	}

	reportCleanupFailure() {
		this.bridge.log.warn('attachment upload staging cleanup failed')
	}
}
