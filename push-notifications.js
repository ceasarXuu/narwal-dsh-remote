import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { notificationPreview, notificationTitles } from './notification-content.js?push'
import { LIVE_ACTIVITY_METHODS, LiveActivities } from './live-activities.js'

const hex = (value, size) => typeof value === 'string' && value.length === size && /^[a-f0-9]+$/.test(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const derive = (seed, purpose) => createHmac('sha256', Buffer.from(seed, 'hex')).update(purpose).digest('hex')
const expiry = 120
const PREVIEW_DOMAIN = 'narwal/push/preview/v1'
const PREVIEW_MAX_LENGTH = 1_600
const PREVIEW_ENVELOPE_MAX_LENGTH = 3_200
const PREVIEW_SOURCE_MAX_LENGTH = 2_048
const taskKinds = new Set(['task-complete', 'agent-question', 'task-failed', 'tool-approval'])

function credentials(record) {
	const { seed } = record
	return {
		binding: derive(seed, 'narwal/push/binding').slice(0, 32),
		phone: derive(seed, 'narwal/push/phone'),
		desktop: derive(seed, 'narwal/push/desktop'),
		seal: derive(seed, 'narwal/push/seal'),
		previewKey: derive(seed, PREVIEW_DOMAIN),
	}
}

function sealLink(key, payload) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
	const plaintext = JSON.stringify({
		kind: payload.kind, sessionId: payload.sessionId, eventId: payload.eventId,
		...(payload.callId ? { callId: payload.callId } : {}),
	})
	return Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]).toString('base64')
}

function sealPreview(key, binding, eventKey, content) {
	const iv = randomBytes(12)
	const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv)
	cipher.setAAD(Buffer.from(`${PREVIEW_DOMAIN}:${binding}:${eventKey}`, 'utf8'))
	return Buffer.concat([
		iv, cipher.update(JSON.stringify(content), 'utf8'), cipher.final(), cipher.getAuthTag(),
	]).toString('base64')
}

function previewContent(payload) {
	const content = notificationPreview({
		workspaceTitle: payload.workspaceTitle,
		sessionTitle: payload.sessionTitle,
		summary: payload.kind === 'task-complete' || payload.kind === 'agent-question' ? payload.preview : undefined,
	})
	const fields = Object.entries(content).filter(([, value]) => typeof value === 'string' && value.length)
	return fields.length ? Object.fromEntries(fields) : undefined
}

function load(file) {
	try {
		const stat = lstatSync(file)
		if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe push state permissions')
		const data = JSON.parse(readFileSync(file, 'utf8'))
		if (data?.format !== 1 || !Array.isArray(data.bindings) || !Array.isArray(data.events)) throw new Error('Invalid push state')
		return { bindings: new Map(data.bindings), events: new Map(data.events) }
	} catch (error) {
		if (error?.code !== 'ENOENT') throw error
		return { bindings: new Map(), events: new Map() }
	}
}

export class PushNotifications {
	constructor({ ctx, url, clientUrl, admission, directory, pairings, devices, send, log }) {
		this.url = url
		this.clientUrl = clientUrl
		this.admission = admission
		this.pairings = pairings
		this.devices = devices
		this.send = send
		this.log = log
		this.file = join(directory, 'push-v1.json')
		Object.assign(this, load(this.file))
		this.offers = new Map()
		this.liveActivities = new LiveActivities(ctx, {
			binding: id => this.bindings.get(id),
			bindings: () => this.bindings,
			set: (id, activity) => {
				const record = this.bindings.get(id)
				if (record && !record.revoked && record.activity !== activity) {
					this.save(new Map(this.bindings).set(id, { ...record, activity }))
				}
			},
			paired: id => Boolean(this.pairings().paired(id) && !this.bindings.get(id)?.revoked),
			provision: id => this.enroll(id),
			request: (id, path, method, role, data, signal) => {
				const record = this.bindings.get(id)
				if (!record || record.revoked) return 410
				const keys = credentials(record)
				return this.request(keys.binding, path, method, keys[role], data, signal)
			},
		})
	}

	close() { this.liveActivities.close() }

	save(bindings = this.bindings, events = this.events) {
		const tmp = this.file + '.' + randomBytes(8).toString('hex') + '.tmp'
		try {
			writeFileSync(tmp, JSON.stringify({ format: 1, bindings: [...bindings], events: [...events] }),
				{ mode: 0o600, flag: 'wx', flush: true })
			renameSync(tmp, this.file)
		} finally {
			rmSync(tmp, { force: true })
		}
		this.bindings = bindings
		this.events = events
	}

	localDevice(foreground, taskActions) {
		if (typeof foreground !== 'boolean') return
		return { pushLocal: true, pushTaskActions: taskActions === true, pushUntil: foreground ? Date.now() + 15_000 : 0 }
	}

	request(binding, suffix, method, token, data, signal) {
		const timeout = AbortSignal.timeout(5_000)
		return fetch(this.url + '/v1/bindings/' + binding + suffix, {
			method, redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
			body: data === undefined ? undefined : JSON.stringify(data),
		}).then(r => r.status)
	}

	async enroll(id) {
		if (!this.pairings().paired(id)) return null
		let record = this.bindings.get(id)
		if (!record) {
			record = { seed: randomBytes(32).toString('hex'), enabled: false }
			this.save(new Map(this.bindings).set(id, record))
		}
		const keys = credentials(record)
		const status = await this.request(keys.binding, '', 'PUT', this.admission, {
			phoneHash: digest(keys.phone), desktopHash: digest(keys.desktop),
		})
		if (status !== 204 || !this.pairings().paired(id)) return null
		return {
			binding: keys.binding, registration: keys.phone, seal: keys.seal,
			url: this.clientUrl, previewKey: keys.previewKey,
		}
	}

	handle(device, method, args) {
		if (!device.transport || !device.peer || !this.pairings().paired(device.tokenId)) return false
		const id = device.tokenId
		if (LIVE_ACTIVITY_METHODS.has(method)) return this.liveActivities.handle(id, device.active === true, method, args)
		if (!device.pushLocal) return false
		if (method === 'pushEnroll') return this.enroll(id)
		if (method === 'pushPresence') {
			const record = this.bindings.get(id)
			if (typeof args.foreground !== 'boolean') return false
			if (record) {
				const enabled = record.enabled || args.registered === true
				const taskActions = device.pushTaskActions
				const preview = typeof args.preview === 'boolean' ? args.preview : record.preview === true
				const previewChanged = typeof args.preview === 'boolean' && preview !== record.preview
				if (enabled !== record.enabled || taskActions !== Boolean(record.taskActions) || previewChanged) {
					this.save(new Map(this.bindings).set(id, {
						...record, enabled, taskActions, ...(typeof args.preview === 'boolean' ? { preview } : {}),
					}))
				}
			}
			device.pushUntil = args.foreground ? Date.now() + 15_000 : 0
			return true
		}
		const offer = this.offers.get(args.eventKey)
		if (!offer || offer.device !== device || !(device.pushUntil > Date.now())) return false
		offer.finish(true)
		return true
	}

	publish(payload) {
		if (!payload.eventId || typeof payload.sessionId !== 'string' || payload.sessionId.length > 512
			|| !taskKinds.has(payload.kind)) return
		for (const pair of this.pairings().list()) {
			if (pair.phoneKey) void this.deliver(pair.id, payload).catch(() => this.log.warn('Push delivery could not be submitted'))
		}
	}

	async deliver(id, payload) {
		const time = Date.now()
		const connected = [...this.devices()].find(value => value.pushLocal && !value.disposed && value.tokenId === id)
		const device = connected && connected.pushUntil > time ? connected : undefined
		let record = this.bindings.get(id)
		if ((payload.kind === 'tool-approval' || payload.kind === 'task-failed')
			&& !(connected?.pushTaskActions ?? record?.taskActions)) return
		if (!record?.enabled && !device) return
		if (!record) {
			record = { seed: randomBytes(32).toString('hex'), enabled: false }
			this.save(new Map(this.bindings).set(id, record))
		}
		const keys = credentials(record)
		const identity = JSON.stringify([payload.kind, payload.sessionId, payload.eventId])
		const eventKey = derive(keys.seal, identity)
		if (this.events.has(eventKey)) return
		const events = new Map([...this.events].filter(([, recorded]) => time - recorded < 86_400_000))
		if (events.size >= 16_384) return
		// The journal is written before either side can produce a visible notification.
		this.save(this.bindings, events.set(eventKey, time))
		if (device && await this.offer(device, eventKey, payload)) return
		if (!record.enabled || !this.pairings().paired(id) || Date.now() >= time + expiry * 1_000) return
		const envelope = sealLink(keys.seal, payload)
		const expiresAt = Math.floor(time / 1_000) + expiry
		let preview
		if (record.preview === true) {
			const content = previewContent(payload)
			if (content) {
				preview = sealPreview(keys.previewKey, keys.binding, eventKey, content)
				if (preview.length > PREVIEW_MAX_LENGTH
					|| preview.length + envelope.length > PREVIEW_ENVELOPE_MAX_LENGTH) {
					preview = undefined
				}
			}
		}
		const data = { eventKey, envelope, expiresAt, ...(preview ? { preview } : {}) }
		let status = await this.request(keys.binding, '/deliveries', 'POST', keys.desktop, data)
		if (status === 422 && preview) {
			// Older gateways reject the preview field before admitting the delivery.
			status = await this.request(keys.binding, '/deliveries', 'POST', keys.desktop, { eventKey, envelope, expiresAt })
		}
		if (status !== 202 && status !== 409 && status !== 410) this.log.warn('Push service did not accept a delivery (%d)', status)
	}

	offer(device, eventKey, notification) {
		return new Promise(resolve => {
			const finish = accepted => {
				clearTimeout(timer)
				this.offers.delete(eventKey)
				resolve(accepted)
			}
			const timer = setTimeout(() => finish(false), 500)
			this.offers.set(eventKey, { device, finish })
			this.send(device, { event: 'narwal/pushOffer', payload: { eventKey, notification } })
		})
	}

	revoke(id) {
		const record = this.bindings.get(id)
		if (!record) return
		this.save(new Map(this.bindings).set(id, { ...record, revoked: true, activity: undefined }))
		this.liveActivities.forget(id)
	}

	flushRevocations() {
		if (this.revoking) return
		this.revoking = true
		void (async () => {
			for (const [id, record] of this.bindings) {
				if (!record.revoked || this.pairings().paired(id)) continue
				try {
					const keys = credentials(record)
					const status = await this.request(keys.binding, '', 'DELETE', keys.desktop)
					if (status === 204 || status === 404) {
						const remaining = new Map(this.bindings)
						remaining.delete(id)
						this.save(remaining)
					}
				} catch { /* Retry on the next heartbeat. */ }
			}
		})().finally(() => { this.revoking = false })
	}
}

export function listenForPushRequests(bridge, listen) {
	const transient = new WeakMap()
	function publish(request, kind, callId) {
		const session = request.agent?.session
		if (bridge.stopping || typeof session?.id !== 'string' || session.header?.origin === 'subagent' || request.signal?.aborted) return
		const eventId = callId || transient.get(request) || randomBytes(16).toString('hex')
		if (!callId) transient.set(request, eventId)
		const question = kind === 'agent-question' && Array.isArray(request.questions)
			? request.questions.find(item => item?.intent?.kind !== 'approval' && typeof item?.question === 'string' && item.question.trim())
			: undefined
		bridge.push.publish({
			kind, sessionId: session.id, callId, eventId,
			...notificationTitles(bridge.ctx, session.id, session),
			...(question ? { preview: question.question.slice(0, PREVIEW_SOURCE_MAX_LENGTH) } : {}),
		})
	}
	const options = { global: true, prepend: true }
	listen('approval/request', (request, next) => {
		publish(request, 'tool-approval')
		return next()
	}, options)
	listen('user-questions/request', (request, next) => {
		if (Array.isArray(request.questions) && request.questions.length) {
			const approval = request.questions.some(question => question?.intent?.kind === 'approval')
			const callId = request.wait?.callId
			publish(request, approval ? 'tool-approval' : 'agent-question',
				!approval && typeof callId === 'string' && callId.length <= 512 ? callId : undefined)
		}
		return next()
	}, options)
	bridge.push.liveActivities?.install(listen)
}

function origin(value) {
	const url = new URL(value)
	const loopback = url.hostname === '127.0.0.1' && url.protocol === 'http:'
	if ((!loopback && url.protocol !== 'https:') || url.href !== url.origin + '/') throw new Error('Invalid push URL')
	return url.origin
}

export function createPushNotifications(bridge) {
	const file = process.env.NARWAL_PUSH_ADMISSION_FILE
	const endpoint = process.env.NARWAL_PUSH_URL
	if (!file || !endpoint || !bridge.relayV2) return
	try {
		const stat = lstatSync(file)
		if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error('Unsafe push admission file')
		const admission = readFileSync(file, 'utf8').trim()
		if (!hex(admission, 64)) throw new Error('Invalid push admission key')
		return new PushNotifications({
			ctx: bridge.ctx,
			url: origin(endpoint), clientUrl: origin(process.env.NARWAL_PUSH_CLIENT_URL ?? endpoint),
			admission, directory: bridge.store.dir, log: bridge.log,
			pairings: () => bridge.relayV2.pairings, devices: () => bridge.devices.values(),
			send: (device, frame) => bridge.send(device, frame),
		})
	} catch { bridge.log.warn('Unable to initialize Narwal Push') }
}
