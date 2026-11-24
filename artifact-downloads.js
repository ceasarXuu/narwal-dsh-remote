import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, posix, win32 } from 'node:path'

const CHUNK_BYTES = 256 * 1024
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024
const ATTACHMENT_ID = /^sha256:[a-f0-9]{64}$/
const SESSION_ID = /^[\w.:-]{1,512}$/
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f]/u
const MIME_TYPES = new Map(Object.entries({
	'.avif': 'image/avif', '.bmp': 'image/bmp', '.gif': 'image/gif',
	'.heic': 'image/heic', '.heif': 'image/heif', '.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png',
	'.svg': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp',
	'.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown',
	'.html': 'text/html', '.htm': 'text/html', '.log': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
	'.zip': 'application/zip', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}))
const IMAGE_EXTENSIONS = new Map([
	['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif'],
])

function artifactError(reason, message) {
	return Object.assign(new Error(message), { code: `narwal/artifact-${reason}` })
}

function unavailable() {
	return artifactError('unavailable', '桌面端无法读取这个文件。')
}

function changed() {
	return artifactError('changed', '文件已在桌面修改，请重新打开。')
}

function mimeType(name) {
	return MIME_TYPES.get(posix.extname(name).toLowerCase()) ?? 'application/octet-stream'
}

function metadata(name, contentType, size, ...identity) {
	if (!Number.isSafeInteger(size) || size < 0) throw unavailable()
	if (size > MAX_ARTIFACT_BYTES) throw artifactError('too-large', '文件超过 128 MiB 下载上限。')
	const version = createHash('sha256').update(JSON.stringify(identity)).digest('base64url')
	return { name, mimeType: contentType, size, version, rangeReads: true }
}

function requestReference({ sessionId, ref }) {
	if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
		throw artifactError('bad-request', '无效的会话。')
	}
	if (ref?.kind === 'path' && typeof ref.path === 'string' && ref.path.trim() && ref.path.length <= 4096
		&& !UNSAFE_PATH_CHARACTERS.test(ref.path)) return { sessionId, ref }
	if (ref?.kind === 'attachment' && typeof ref.attachmentId === 'string' && ATTACHMENT_ID.test(ref.attachmentId)) {
		return { sessionId, ref }
	}
	throw artifactError('bad-request', '无效的文件引用。')
}

function visibleWorkspacePath(paths, root, target) {
	const relative = paths.relative(root, target)
	return relative && !paths.isAbsolute(relative)
		&& relative.split(paths.sep).every(part => !part.startsWith('.') && !part.includes(':'))
}

async function resolveWorkspaceFile(fs, cwd, path, signal) {
	const paths = /^[a-z]:[\\/]|^\\\\/i.test(cwd) ? win32 : posix
	if (path.split(/[\\/]/).includes('..') || !visibleWorkspacePath(paths, cwd, paths.resolve(cwd, path))) {
		throw unavailable()
	}
	const root = await fs.resolve(cwd, { signal })
	const entry = await fs.lstat(path, { cwd }, signal)
	if (entry?.type !== 'file') throw unavailable()
	const target = await fs.resolve(path, { cwd, signal })
	const rootPath = fs.processPath(root)
	const pathOnHost = fs.processPath(target)
	if (!fs.contains(root, target) || !visibleWorkspacePath(paths, rootPath, pathOnHost)) throw unavailable()
	const info = await fs.stat(target, signal)
	if (info?.type !== 'file') throw unavailable()
	return { target, pathOnHost, name: paths.basename(pathOnHost), info }
}

async function workspaceFile(ctx, sessionId, path, signal) {
	const fs = ctx.get('fs')
	const active = ctx.get('sessions')?.get(sessionId)?.header
	const header = active ?? (await ctx.get('sessionPersistence')?.stat(sessionId, { signal }))?.header
	if (!fs || typeof header?.cwd !== 'string' || !header.cwd) throw unavailable()
	const locate = () => resolveWorkspaceFile(fs, header.cwd, path, signal)
	const { target, pathOnHost, name, info } = await locate()
	const local = fs.processPathFromHostPath?.(pathOnHost) === pathOnHost
	if (!local) throw unavailable()
	const native = await lstat(pathOnHost, { bigint: true })
	if (!native.isFile() || Number(native.size) !== info.size || await realpath(pathOnHost) !== pathOnHost) throw unavailable()
	const identity = fileIdentity(native)
	const meta = metadata(name, mimeType(name), info.size, sessionId, target.targetKey, info.version, identity)
	return {
		meta,
		async read(offset, length) {
			const data = await readLocalRange(pathOnHost, identity, offset, length, signal)
			const current = await locate()
			if (current.target.targetKey !== target.targetKey || current.info.version !== info.version) throw changed()
			return data
		},
	}
}

function referencedAttachment(events, attachmentId) {
	for (let i = events.length - 1; i >= 0; i--) {
		const { type, data } = events[i]
		const content = type === 'user/message' ? data?.content
			: type === 'assistant/message' || type === 'tool/result' ? data?.message?.content : undefined
		if (!Array.isArray(content)) continue
		for (const block of content) {
			if ((block?.type === 'image' || block?.type === 'file') && block.attachment?.attachmentId === attachmentId) return block
		}
	}
}

async function verifyAttachment(ctx, sessionId, attachmentId, signal) {
	const query = ctx.get('sessionQuery')
	if (typeof query?.observeSession !== 'function') throw unavailable()
	const observation = await query.observeSession(sessionId, { signal, projectionMode: 'none' })
	try {
		return referencedAttachment(observation.events, attachmentId)
	} finally {
		observation[Symbol.dispose]()
	}
}

function fileIdentity(info) {
	return [info.dev, info.ino, info.ctimeNs, info.mtimeNs, info.size].map(String).join(':')
}

async function readLocalRange(path, identity, offset, length, signal) {
	const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
	const handle = await open(path, flags)
	try {
		const opened = await handle.stat({ bigint: true })
		if (!opened.isFile() || fileIdentity(opened) !== identity) throw changed()
		const data = Buffer.alloc(length)
		let read = 0
		while (read < length) {
			signal.throwIfAborted()
			const { bytesRead } = await handle.read(data, read, length - read, offset + read)
			if (!bytesRead) throw changed()
			read += bytesRead
		}
		if (fileIdentity(await handle.stat({ bigint: true })) !== identity) throw changed()
		return data
	} finally {
		await handle.close()
	}
}

async function attachmentFile(ctx, sessionId, attachmentId, signal) {
	const block = await verifyAttachment(ctx, sessionId, attachmentId, signal)
	const store = ctx.get('attachments')
	if (!block || !store) throw unavailable()
	const ref = block.attachment
	const extension = block.type === 'image' ? IMAGE_EXTENSIONS.get(ref.mediaType) : undefined
	const path = extension ? store.imageHostPath?.(ref) : store.fileHostPath?.(ref)
	if (typeof path !== 'string' || !isAbsolute(path)) throw unavailable()
	const info = await lstat(path, { bigint: true })
	if (!info.isFile() || !Number.isSafeInteger(ref.bytes) || info.size !== BigInt(ref.bytes)) throw unavailable()
	const name = typeof ref.name === 'string' && ref.name ? win32.basename(ref.name) : extension ? `image.${extension}` : 'file'
	const identity = fileIdentity(info)
	const meta = metadata(name, extension ? ref.mediaType : mimeType(name), ref.bytes, sessionId, attachmentId, identity)
	return { meta, read: (offset, length) => readLocalRange(path, identity, offset, length, signal) }
}

export function supportsArtifactDownloads(ctx) {
	return typeof ctx.get('fs')?.lstat === 'function' && typeof ctx.get('sessionQuery')?.observeSession === 'function'
}

export async function invokeArtifactDownload(ctx, method, args) {
	const { sessionId, ref } = requestReference(args)
	const { offset, version, length = CHUNK_BYTES } = args
	const isRead = method === 'readArtifact'
	if (isRead && (!Number.isSafeInteger(offset) || offset < 0 || typeof version !== 'string' || version.length !== 43
		|| !Number.isSafeInteger(length) || length < 1 || length > CHUNK_BYTES)) {
		throw artifactError('bad-request', '无效的文件分段。')
	}
	const signal = AbortSignal.timeout(8000)
	try {
		const { meta, read } = ref.kind === 'path'
			? await workspaceFile(ctx, sessionId, ref.path, signal)
			: await attachmentFile(ctx, sessionId, ref.attachmentId, signal)
		if (!isRead) return meta
		if (version !== meta.version) throw changed()
		if (offset > meta.size) throw artifactError('bad-request', '文件分段超出了文件末尾。')
		const bytesToRead = Math.min(length, meta.size - offset)
		if (!bytesToRead) return { data: '' }
		const bytes = await read(offset, bytesToRead)
		if (bytes?.byteLength !== bytesToRead) throw changed()
		const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		return { data: args.encoding === 'binary' ? data : data.toString('base64') }
	} catch (error) {
		if (typeof error?.code === 'string' && error.code.startsWith('narwal/artifact-')) throw error
		throw unavailable()
	}
}
