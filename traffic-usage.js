import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DAYS = 30
const FLUSH_INTERVAL_MS = 5_000

function dateKey(date) {
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${date.getFullYear()}-${month}-${day}`
}

function recentDates(now) {
	return Array.from({ length: DAYS }, (_, index) => dateKey(new Date(
		now.getFullYear(), now.getMonth(), now.getDate() + index - DAYS + 1, 12,
	)))
}

function normalizeBytes(bytes) {
	return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0
}

/** UTF-8 Narwal messages written successfully, grouped by host calendar day. */
export class TrafficUsage {
	constructor(dir, log) {
		this.dir = dir
		this.file = join(dir, 'traffic-usage.json')
		this.log = log
		this.totals = new Map()
		try {
			const saved = JSON.parse(readFileSync(this.file, 'utf8'))
			const dates = new Set(recentDates(new Date()))
			for (const day of Array.isArray(saved?.days) ? saved.days : []) {
				if (!dates.has(day?.date)) continue
				this.totals.set(day.date, { wifiBytes: normalizeBytes(day.wifiBytes), relayBytes: normalizeBytes(day.relayBytes) })
			}
		} catch (error) {
			if (error?.code !== 'ENOENT') this.log.warn('Unable to read Narwal traffic usage: %s', error?.message)
		}
	}

	record(transport, bytes) {
		if (this.closed || !bytes) return
		const date = dateKey(new Date())
		const counters = this.totals.get(date) ?? { wifiBytes: 0, relayBytes: 0 }
		const key = transport === 'relay' ? 'relayBytes' : 'wifiBytes'
		counters[key] = Math.min(counters[key] + bytes, Number.MAX_SAFE_INTEGER)
		this.totals.set(date, counters)
		this.dirty = true
		if (!this.timer) {
			this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS)
			this.timer.unref()
		}
	}

	snapshot() {
		const days = recentDates(new Date()).map(date => ({
			date, ...(this.totals.get(date) ?? { wifiBytes: 0, relayBytes: 0 }),
		}))
		return { days, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
	}

	flush() {
		clearTimeout(this.timer)
		this.timer = undefined
		if (!this.dirty) return
		const { days } = this.snapshot()
		const active = new Set(days.map(day => day.date))
		for (const date of this.totals.keys()) {
			if (!active.has(date)) this.totals.delete(date)
		}
		try {
			mkdirSync(this.dir, { recursive: true })
			const temp = `${this.file}.tmp`
			writeFileSync(temp, JSON.stringify({ days: days.filter(day => day.wifiBytes || day.relayBytes) }), { mode: 0o600 })
			renameSync(temp, this.file)
			this.dirty = false
		} catch (error) {
			this.log.warn('Unable to persist Narwal traffic usage: %s', error?.message)
		}
	}

	close() {
		this.closed = true
		this.flush()
	}
}
