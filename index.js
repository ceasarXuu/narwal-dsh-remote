import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'

import { createRuntimeUpdates } from './runtime-updates.js'

const IMPL = fileURLToPath(new URL('./impl.js', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const STATUS_DIR = join(process.env.NARWAL_PROFILE_HOME || process.env.DSH_HOME || join(homedir(), '.dsh'), 'narwal-server')
const FIRST_CHECK_DELAY = 30_000
const UPDATE_INTERVAL = 6 * 60 * 60_000

export const Config = z.object({
	port: z.union([z.number(), z.string()]).default(48317).disabled().volatile(),
})

function writeStatus(status) {
	try {
		mkdirSync(STATUS_DIR, { recursive: true, mode: 0o700 })
		writeFileSync(join(STATUS_DIR, 'status.json'), JSON.stringify({ ...status, pid: process.pid, at: new Date().toISOString() }, null, 2))
	} catch { /* diagnostics must not stop the bridge */ }
}

export function apply(ctx, config) {
	const log = (msg, error) => {
		const line = `[narwal] ${msg}${error ? `: ${error.stack ?? error}` : ''}`
		try { process.stderr.write(`${line}\n`) } catch { /* unavailable */ }
		try { ctx.logger('narwal-server').warn('%s', line) } catch { /* unavailable */ }
	}
	const bundled = { version: manifest.version, entry: IMPL }
	const development = manifest.private === true
	const updates = development ? null : createRuntimeUpdates(join(STATUS_DIR, 'runtime'), bundled.version)
	const ws = import('ws').catch(() => undefined)
	let updateStatus = 'idle'
	let stopped = false
	let current
	let queue = Promise.resolve()
	let watching
	let debounce
	let updateTimer
	let rejectedVersion
	let previousRelease
	const configuredPort = () => {
		const port = typeof config?.port?.get === 'function' ? config.port.get() : config?.port
		return Number(port) || 48317
	}

	const report = () => writeStatus({
		ok: Boolean(current),
		version: current?.version,
		impl: current?.entry ?? IMPL,
		update: updateStatus,
		failedVersion: rejectedVersion,
	})
	const enqueue = (action) => {
		queue = queue.then(() => stopped ? undefined : action()).catch(error => {
			report()
			log('bridge operation failed', error)
		})
		return queue
	}
	const prepare = async (release, reload = false) => {
		const url = pathToFileURL(release.entry)
		if (reload) url.searchParams.set('revision', randomUUID())
		const module = await import(url.href)
		if (typeof module.start !== 'function') throw new Error('Narwal runtime has no start function')
		return { ...release, start: module.start }
	}
	const start = async (release, port = configuredPort()) => {
		const transport = await ws
		if (stopped) return
		let dispose
		try {
			const handle = await release.start(ctx, { ...config, port }, {
				ws: transport,
				registerStop(stop) { dispose = stop },
			})
			if (typeof handle?.stop !== 'function') throw new Error('Narwal runtime did not return a stop function')
			if (stopped) await handle.stop()
			else current = { ...release, port, stop: () => handle.stop() }
		} catch (error) {
			try { await dispose?.() } catch (stopError) { log('failed runtime could not stop', stopError) }
			throw error
		}
	}
	const switchRuntime = async (next) => {
		if (stopped) return
		const previous = current
		await previous?.stop()
		current = undefined
		try {
			await start(next)
		} catch (error) {
			if (!stopped && previous) await start(previous, previous.port)
			throw error
		}
	}

	void enqueue(async () => {
		const cached = updates?.installed() ?? { releases: [] }
		rejectedVersion = cached.rejected
		let rolledBack = false
		for (const [index, release] of cached.releases.entries()) {
			try {
				await switchRuntime(await prepare(release))
				previousRelease = cached.releases[index + 1]
				break
			} catch (error) {
				if (stopped) return
				if (!rolledBack) rejectedVersion = release.version
				rolledBack = true
				log(`cached runtime ${release.version} failed`, error)
			}
		}
		if (!current && !stopped) await switchRuntime(await prepare(bundled, development))
		if (!stopped) {
			if (rolledBack && current) {
				updateStatus = 'rolled-back'
				updates?.remember(current, previousRelease, rejectedVersion)
			}
			report()
		}
	})
	ctx.on('loader/volatile-update', () => {
		void enqueue(async () => {
			if (!current || current.port === configuredPort()) return
			await switchRuntime(current)
			if (!stopped) report()
		})
	})

	async function checkForUpdate() {
		if (!updates || stopped) return
		try {
			const next = await updates.stage(current?.version ?? bundled.version, rejectedVersion)
			if (next) await enqueue(async () => {
				const previous = current
				try {
					await switchRuntime(await prepare(next))
					if (!stopped) {
						previousRelease = previous
						rejectedVersion = undefined
						updates.remember(next, previous)
						updateStatus = 'updated'
						log(`activated runtime ${next.version}`)
					}
				} catch (error) {
					rejectedVersion = next.version
					updateStatus = current?.version === next.version ? 'cache-write-failed' : 'rolled-back'
					if (!stopped && current && current.version !== next.version) {
						try { updates.remember(current, previousRelease, rejectedVersion) }
						catch (cacheError) { log('cannot save runtime rollback', cacheError) }
					}
					log(`runtime ${next.version} update failed`, error)
				}
				report()
			})
		} catch (error) {
			updateStatus = 'check-failed'
			if (!stopped) report()
			log('runtime update check failed', error)
		} finally {
			if (!stopped) updateTimer = setTimeout(checkForUpdate, UPDATE_INTERVAL).unref()
		}
	}

	if (updates && config?.autoUpdate !== false) {
		updateTimer = setTimeout(checkForUpdate, FIRST_CHECK_DELAY).unref()
	}
	if (development) {
		try {
			watching = watch(dirname(IMPL), (_event, filename) => {
				if (filename && String(filename) !== basename(IMPL)) return
				clearTimeout(debounce)
				debounce = setTimeout(() => {
					void enqueue(async () => {
						await switchRuntime(await prepare(bundled, true))
						if (!stopped) report()
					})
				}, 300)
			})
			watching.on('error', error => log('hot reload unavailable', error))
		} catch (error) {
			log('hot reload unavailable', error)
		}
	}

	return async () => {
		stopped = true
		clearTimeout(debounce)
		clearTimeout(updateTimer)
		watching?.close()
		await queue
		const previous = current
		current = undefined
		try { await previous?.stop() }
		catch (error) { log('bridge stop failed', error) }
	}
}

export const inject = ['connection', 'typertGateway']
