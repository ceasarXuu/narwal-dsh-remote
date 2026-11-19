import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gunzipSync } from 'node:zlib'

const PACKAGE = 'narwal-dsh-remote'
const REGISTRY = 'https://registry.npmjs.org'
const FORMAT = 1
const ENTRY = 'impl.js'
const ARCHIVE_LIMIT = 4 * 1024 * 1024
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
const DIGEST = /^[0-9a-f]{128}$/
const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/
const FILE = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.m?js$/

export function newerVersion(candidate, current) {
	const next = typeof candidate === 'string' && candidate.match(VERSION)
	const active = typeof current === 'string' && current.match(VERSION)
	if (!next || !active) return false
	for (let index = 1; index <= 3; index++) {
		const difference = Number(next[index]) - Number(active[index])
		if (difference !== 0) return difference > 0
	}
	return false
}

async function download(fetcher, url, limit, timeout) {
	const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(timeout) })
	if (!response.ok || !response.body) throw new Error(`Runtime download failed (${response.status})`)
	let size = 0
	const chunks = []
	const reader = response.body.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) return Buffer.concat(chunks, size)
			size += value.length
			if (size > limit) throw new Error('Narwal runtime download exceeds size limit')
			chunks.push(value)
		}
	} finally {
		void reader.cancel().catch(() => {})
	}
}

function runtimeFiles(manifest) {
	const { format, files } = manifest?.narwalRuntime ?? {}
	if (format !== FORMAT || !Array.isArray(files) || files.length > 100 || !files.includes(ENTRY)) return null
	if (!files.every(file => typeof file === 'string' && file.length < 96 && FILE.test(file))) return null
	return new Set(['package.json', ...files])
}

function readArchive(archive, version) {
	const tar = gunzipSync(archive, { maxOutputLength: ARCHIVE_LIMIT * 2 })
	const files = new Map()
	let offset = 0
	while (offset + 512 <= tar.length && tar[offset] !== 0) {
		const header = tar.subarray(offset, offset + 512)
		const name = header.toString('utf8', 0, 100).split('\0', 1)[0]
		const sizeText = header.toString('ascii', 124, 136).split('\0', 1)[0].trim()
		const size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN
		const start = offset + 512
		if (!Number.isSafeInteger(size) || size > tar.length - start) throw new Error('Invalid Narwal runtime archive')
		const path = name.startsWith('package/') ? name.slice('package/'.length) : ''
		if (path === 'package.json' || (path.length < 96 && FILE.test(path))) {
			if ((header[156] !== 0 && header[156] !== 48) || files.has(path) || header[345] !== 0) {
				throw new Error('Invalid Narwal runtime file')
			}
			files.set(path, tar.subarray(start, start + size))
		}
		offset = start + Math.ceil(size / 512) * 512
	}
	const manifest = JSON.parse(files.get('package.json')?.toString('utf8') ?? 'null')
	if (manifest?.name !== PACKAGE || manifest.version !== version || manifest.type !== 'module') {
		throw new Error('Unexpected Narwal runtime package')
	}
	const paths = runtimeFiles(manifest)
	if (!paths) return null
	if (![...paths].every(path => files.has(path))) throw new Error('Incomplete Narwal runtime archive')
	return new Map([...paths].map(path => [path, files.get(path)]))
}

export function createRuntimeUpdates(directory, bundledVersion, fetcher = fetch) {
	const marker = join(directory, 'active.json')
	const releaseDir = (version, hash) => join(directory, `${version}-${hash}`)
	const resolve = (version, hash) => ({ version, hash, entry: join(releaseDir(version, hash), ENTRY) })
	return {
		installed() {
			try {
				const { releases, rejected } = JSON.parse(readFileSync(marker, 'utf8'))
				return {
					releases: releases.slice(0, 2).flatMap(({ version, hash }) =>
						newerVersion(version, bundledVersion) && typeof hash === 'string' && DIGEST.test(hash)
							? [resolve(version, hash)] : []),
					rejected: typeof rejected === 'string' && VERSION.test(rejected) ? rejected : undefined,
				}
			} catch { /* first launch or invalid marker */ }
			return { releases: [] }
		},
		async stage(currentVersion, rejectedVersion) {
			const metadataUrl = `${REGISTRY}/${PACKAGE}/latest`
			const metadata = JSON.parse(await download(fetcher, metadataUrl, 256 * 1024, 10_000))
			const version = metadata.version
			if (metadata.name !== PACKAGE || !newerVersion(version, currentVersion) || version === rejectedVersion) return null
			const url = `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${version}.tgz`
			const integrity = typeof metadata.dist?.integrity === 'string' && metadata.dist.integrity.match(INTEGRITY)
			if (metadata.dist?.tarball !== url || !integrity) throw new Error('Untrusted Narwal runtime package metadata')
			const archive = await download(fetcher, url, ARCHIVE_LIMIT, 20_000)
			const digest = createHash('sha512').update(archive).digest()
			if (digest.toString('base64') !== integrity[1]) throw new Error('Narwal runtime integrity check failed')
			const files = readArchive(archive, version)
			if (!files) return null
			const hash = digest.toString('hex')
			mkdirSync(directory, { recursive: true, mode: 0o700 })
			const stage = mkdtempSync(join(directory, '.stage-'))
			try {
				for (const [path, content] of files) {
					const file = join(stage, path)
					mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
					writeFileSync(file, content, { mode: 0o600, flag: 'wx' })
				}
				try {
					renameSync(stage, releaseDir(version, hash))
				} catch (error) {
					if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EEXIST') throw error
					// Another process has already staged the same content-addressed release.
				}
			} finally {
				rmSync(stage, { recursive: true, force: true })
			}
			return resolve(version, hash)
		},
		remember(current, previous, rejected) {
			const releases = [current, previous]
				.filter(release => release?.hash)
				.map(({ version, hash }) => ({ version, hash }))
			const temp = join(directory, `.active-${randomUUID()}.json`)
			try {
				writeFileSync(temp, JSON.stringify({ releases, rejected }), { mode: 0o600, flag: 'wx' })
				renameSync(temp, marker)
			} finally {
				rmSync(temp, { force: true })
			}
		},
	}
}
