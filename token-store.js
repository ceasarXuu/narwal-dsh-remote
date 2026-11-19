import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_PAIRINGS = 10
const QR_TTL_MS = 10 * 60_000
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function deviceIdentity(value) {
	return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
}

function secretHash(secret) {
	return createHash('sha256').update(secret).digest('hex')
}

export class TokenStore {
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
		this.revokedConfig = new Set()
		this.configHashes = new Set()
		this.desktopId = null
		this.load()
		for (const t of (Array.isArray(configTokens) ? configTokens : [])) {
			if (typeof t?.secret !== 'string' || t.secret.length < 8) continue
			const hash = secretHash(t.secret)
			this.configHashes.add(hash)
			if (this.revokedConfig.has(hash) || this.memory.some((token) => token.secret === t.secret)) continue
			this.memory.push({ id: t.id ?? TokenStore.id(), label: t.label ?? '', createdAt: t.createdAt ?? new Date().toISOString(), secret: t.secret })
		}
	}

	static secret() {
		return randomBytes(24).toString('hex')
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
		if (!Array.isArray(parsed?.tokens)) throw new Error('Invalid Narwal pairing store')
		const secrets = new Set()
		this.memory = parsed.tokens.filter((token) => {
			if (typeof token?.secret !== 'string' || token.secret.length < 8 || secrets.has(token.secret)) return false
			secrets.add(token.secret)
			return true
		})
		this.desktopId = deviceIdentity(parsed.desktopId)
		this.revokedConfig = new Set(Array.isArray(parsed.revokedConfig) ? parsed.revokedConfig : [])
	}

	save(tokens, revokedConfig = this.revokedConfig, desktopId = this.desktopId ?? randomUUID()) {
		const data = JSON.stringify({ tokens, desktopId, revokedConfig: [...revokedConfig], updatedAt: new Date().toISOString() }, null, 1)
		mkdirSync(this.dir, { recursive: true, mode: 0o700 })
		const tmp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`
		const fd = openSync(tmp, 'wx', 0o600)
		try {
			try {
				writeFileSync(fd, data, 'utf8')
			} finally {
				closeSync(fd)
			}
			renameSync(tmp, this.file)
		} finally {
			rmSync(tmp, { force: true })
		}
		this.memory = tokens
		this.desktopId = desktopId
		this.revokedConfig = revokedConfig
	}

	getDesktopId() {
		if (this.desktopId) return this.desktopId
		try { this.save(this.list()) } catch { /* 旧配对仍可连接 */ }
		return this.desktopId
	}

	list() {
		const now = Date.now()
		return this.memory.filter(token => token.deviceId || token.expiresAt === undefined || Date.parse(token.expiresAt) > now)
	}

	create(label) {
		const tokens = this.list()
		if (tokens.length >= MAX_PAIRINGS) return null
		const now = Date.now()
		const token = {
			id: TokenStore.id(),
			label: (typeof label === 'string' && label.trim()) || `device-${tokens.length + 1}`,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + QR_TTL_MS).toISOString(),
			secret: TokenStore.secret(),
		}
		this.save([...tokens, token])
		return token
	}

	checkDevice(token, value) {
		const deviceId = deviceIdentity(value)
		if (token.deviceId && token.deviceId !== deviceId) return 'pairing-device-mismatch'
		if (!deviceId && (token.expiresAt || value !== null)) return 'pairing-device-required'
		return null
	}

	claim(token, value) {
		const deviceId = deviceIdentity(value)
		if (!deviceId || token.deviceId) return
		const tokens = this.list()
		if (!tokens.includes(token)) throw new Error('Pairing token expired')
		const claimed = { ...token, deviceId }
		delete claimed.expiresAt
		this.save(tokens.map(item => item === token ? claimed : item))
	}

	revoke(id) {
		const revokedConfig = new Set(this.revokedConfig)
		for (const token of this.memory) {
			if (token.id !== id) continue
			const hash = secretHash(token.secret)
			if (this.configHashes.has(hash)) revokedConfig.add(hash)
		}
		this.save(this.list().filter((token) => token.id !== id), revokedConfig)
	}

	relabel(id, label) {
		const tokens = this.list()
		const token = tokens.find(item => item.id === id)
		if (!token) return null
		const updated = { ...token, label: String(label ?? '').trim() || token.label }
		this.save(tokens.map(item => item === token ? updated : item))
		return updated
	}
}
