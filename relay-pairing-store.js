import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const PAIR_ID = /^[0-9a-f]{32}$/
const KEY = /^[0-9a-f]{64}$/
const QR_TTL_MS = 10 * 60_000

export class RelayPairingStore {
	constructor(dir, noise) {
		this.dir = join(dir, 'relay-v2')
		this.file = join(this.dir, 'pairings.json')
		this.records = []
		mkdirSync(this.dir, { recursive: true, mode: 0o700 })
		const parent = lstatSync(this.dir)
		if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) throw new Error('Unsafe v2 pairing directory')
		let saved = this.load()
		if (!saved) {
			this.identity = noise.generateKeypair()
			this.validateIdentity()
			try {
				this.save([], true)
				return
			} catch (error) {
				if (error?.code !== 'EEXIST') throw error
				saved = this.load()
			}
		}
		this.identity = saved?.identity
		this.validateIdentity()
		if (saved.format !== 2 || !Array.isArray(saved.records)) throw new Error('Invalid v2 pairing store')
		const ids = new Set()
		for (const record of saved.records) {
			const valid = PAIR_ID.test(record?.id) && !ids.has(record.id) && typeof record.label === 'string' &&
				(record.phoneKey ? KEY.test(record.phoneKey) : KEY.test(record.secret) && Number.isFinite(record.expiresAt))
			if (!valid) throw new Error('Invalid v2 pairing record')
			ids.add(record.id)
		}
		this.records = saved.records
	}

	load() {
		try {
			const entry = lstatSync(this.file)
			if (!entry.isFile() || (entry.mode & 0o077) !== 0) throw new Error('Unsafe v2 pairing file')
			return JSON.parse(readFileSync(this.file, 'utf8'))
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error
			return null
		}
	}

	validateIdentity() {
		if (!KEY.test(this.identity?.privateKey) || !KEY.test(this.identity?.publicKey)) throw new Error('Invalid v2 desktop key')
	}

	save(records, exclusive = false) {
		const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
		try {
			writeFileSync(tmp, JSON.stringify({ format: 2, identity: this.identity, records }), { mode: 0o600, flag: 'wx', flush: true })
			if (exclusive) linkSync(tmp, this.file)
			else renameSync(tmp, this.file)
		} finally {
			rmSync(tmp, { force: true })
		}
		this.records = records
	}

	list(now = Date.now()) {
		return this.records.filter(record => record.phoneKey || record.expiresAt > now)
	}

	create(label, relay) {
		const records = this.list()
		const now = Date.now()
		const record = {
			id: randomBytes(16).toString('hex'), label: String(label ?? '').trim().slice(0, 80) || `device-${records.length + 1}`,
			createdAt: new Date(now).toISOString(), expiresAt: now + QR_TTL_MS,
			secret: randomBytes(32).toString('hex'), ...(relay ? { relay } : {}),
		}
		this.save([...records, record])
		return record
	}

	pending(id) {
		return this.list().find(record => record.id === id && !record.phoneKey)
	}

	paired(id) {
		return this.records.find(record => record.id === id && record.phoneKey)
	}

	claim(expected, phoneKey) {
		const pending = this.pending(expected.id)
		if (!pending || pending.secret !== expected.secret || !KEY.test(phoneKey)) return null
		const { relay, secret, expiresAt, ...metadata } = pending
		const record = {
			...metadata, phoneKey,
			...(relay ? { relay: { url: relay.url, host: relay.host, expiresAt: relay.expiresAt } } : {}),
		}
		this.save(this.list().map(item => item.id === record.id ? record : item))
		return { record, phoneRelay: relay ? { url: relay.url, ...relay.phone } : undefined }
	}

	relabel(id, label) {
		const records = this.list()
		const current = records.find(record => record.id === id)
		if (!current) return null
		const updated = { ...current, label: String(label ?? '').trim().slice(0, 80) || current.label }
		this.save(records.map(record => record.id === id ? updated : record))
		return updated
	}

	revoke(id) {
		this.save(this.list().filter(record => record.id !== id))
	}
}

export function publicPairing(record) {
	return record ? { id: record.id, label: record.label, createdAt: record.createdAt, expiresAt: record.expiresAt, protocol: 2 } : null
}
