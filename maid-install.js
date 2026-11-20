import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = '@ceasarxuu/dsh-maid'
const VERSION = '0.1.10'
const SHA256 = 'd63f34de36a706f5b08e1d2b4b3320919ae61d72008e53a8e76356c2a3e798cb'
const BOOT_TIMEOUT = 30_000
const REGISTRY = 'https://registry.npmjs.org'
export const MAID_ARCHIVE = 'vendor/dsh-maid.tgz'
const archivePath = fileURLToPath(new URL(MAID_ARCHIVE, import.meta.url))

export function verifyMaidArchive(bytes) {
	if (createHash('sha256').update(bytes).digest('hex') !== SHA256) {
		throw new Error(`Maid ${VERSION} archive failed integrity verification`)
	}
}

async function stageArchive(directory) {
	const bytes = await readFile(archivePath)
	verifyMaidArchive(bytes)
	const artifacts = join(directory, 'installers')
	await mkdir(artifacts, { recursive: true, mode: 0o700 })
	// DSH's profile retains this file dependency after Narwal itself gets updated.
	const target = join(artifacts, `dsh-maid-${VERSION}.tgz`)
	const temp = join(artifacts, `.maid-${randomUUID()}.tgz`)
	try {
		await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' })
		await rename(temp, target)
	} finally {
		await rm(temp, { force: true })
	}
	return `file:${target}`
}

function bundleRequiresUpdate(version) {
	return typeof version === 'string' && /^0\.(?:0\.\d+|1\.[0-9])(?:$|[-+])/.test(version)
}

export function createMaidInstaller({ getManager, getConversation, directory, log }) {
	let action
	let outcome
	let preparing
	let bootDeadline = Date.now() + BOOT_TIMEOUT

	async function checkBundle() {
		const manager = getManager()
		if (typeof manager?.listBundles !== 'function') return { kind: 'unavailable' }
		const bundles = await manager.listBundles()
		if (!Array.isArray(bundles)) return { kind: 'unavailable' }
		const bundle = bundles.find(row => row.name === NAME)
		if (!bundle?.installed || bundleRequiresUpdate(bundle.version)) {
			if (typeof manager.installBundle !== 'function' || !existsSync(archivePath)) return { kind: 'install-unavailable' }
			return { kind: bundle?.installed ? 'update-required' : 'missing', manager }
		}
		if (!bundle.enabled) return { kind: typeof manager.setBundleEnabled === 'function' ? 'disabled' : 'unavailable', manager }
		if (bundle.error || Date.now() >= bootDeadline) return { kind: 'failed' }
		return { kind: 'starting' }
	}

	async function prepare(conversation) {
		preparing ??= Promise.resolve().then(() => conversation.prepare()).finally(() => { preparing = undefined })
		const result = await preparing
		if (typeof result?.sessionId !== 'string' || result.sessionId.length === 0 || result.sessionId.length > 200) {
			throw new Error('Maid did not return a valid conversation')
		}
		return { kind: 'ready', sessionId: result.sessionId }
	}

	async function availability(refresh = false) {
		try {
			if (action) return { kind: action }
			if (refresh && outcome?.kind === 'failed') outcome = undefined
			const conversation = getConversation()
			if (typeof conversation?.prepare === 'function') return await prepare(conversation)
			if (outcome) return outcome
			const { kind } = await checkBundle()
			return { kind: action ?? kind }
		} catch (error) {
			log.warn('Maid conversation unavailable: %s', error?.message)
			return { kind: 'failed' }
		}
	}

	return {
		availability,
		async start(enable) {
			const conversation = getConversation()
			if (action || (typeof conversation?.prepare === 'function' && (enable || typeof conversation.notebook === 'function'))) {
				return availability()
			}
			const pending = enable ? 'starting' : 'installing'
			const failure = { kind: 'failed', retry: enable ? 'enable' : 'install' }
			action = pending
			outcome = undefined
			void (async () => {
				try {
					const { kind, manager } = await checkBundle()
					if (enable ? kind !== 'disabled' : kind !== 'missing' && kind !== 'update-required') return
					const result = enable
						? await manager.setBundleEnabled(NAME, true)
						: await manager.installBundle(await stageArchive(directory), {
							enabled: true, registry: REGISTRY, expected: { name: NAME, version: VERSION },
						})
					if (result?.application === 'restart-required' || (result?.application === 'applied' && kind === 'update-required')) {
						// An enabled replacement can be persisted while DSH still holds the old module.
						outcome = { kind: 'restart' }
					} else if (result?.application === 'applied') bootDeadline = Date.now() + BOOT_TIMEOUT
					else {
						outcome = failure
						log.warn('Maid setup did not apply: %s', result?.error?.code ?? 'unknown')
					}
				} catch (error) {
					outcome = failure
					log.warn('Maid setup failed: %s', error?.message)
				} finally {
					action = undefined
				}
			})()
			return { kind: pending }
		},
	}
}
