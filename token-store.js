import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
		this.memory = Array.isArray(parsed?.tokens) ? parsed.tokens.filter((t) => t && typeof t.secret === 'string') : []
	}

	save() {
		try {
			const data = JSON.stringify({ tokens: this.memory, updatedAt: new Date().toISOString() }, null, 1)
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
