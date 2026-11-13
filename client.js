window.__ModuleLoader__.load({
	id: 'narwal-dsh-remote',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require('react')
		const { useState, useCallback, useEffect, useRef } = React

		/* ------------------------------------------------------------------ */
		/* locale(inline dictionaries —— official session-log precedent)       */
		/* ------------------------------------------------------------------ */
		const en = {
			nav: 'Narwal',
			sectionDesc: 'Pair your iOS client to drive this DeepSeek Harness instance.',
			port: 'Server port',
			portDesc: 'Local WebSocket port of the Narwal bridge.',
			advertise: 'Advertised name',
			advertiseDesc: 'Name shown on your phone when pairing.',
			tokens: 'Pairing tokens',
			tokenDesc: 'One token per device. Tokens are long-lived credentials — revoke immediately when a device is lost.',
			createToken: 'Create token',
			tokenLabel: 'Device label',
			copied: 'Copied',
			copy: 'Copy',
			pairingUsage: 'Open Narwal on the phone, choose “Add host”, and paste the payload below (QR scan coming next iteration).',
			revoke: 'Revoke',
			relayTitle: 'Relay (experimental)',
			relayDesc: 'Route the phone through a relay when it is away from this network.',
			relayEnabled: 'Enable relay',
			relayTicketHint: 'Relay ticket',
			liveDevices: 'Connected devices',
			noDevices: 'No device connected.',
			createHint: 'Create the first token here — it is the credential every device will use.',
			failed: 'Save failed',
			noTokens: 'No devices paired yet.',
			lanHost: 'LAN host (IP)',
			lanHostDesc: 'IP your phone reaches on the WiFi — used in pairing payloads (leave empty to auto-detect: 127.0.0.1 is never usable from a phone).'
		}
		const zh = {
			nav: 'Narwal',
			sectionDesc: '把 iOS 客户端配对到这台 DeepSeek Harness。',
			port: '服务端口',
			portDesc: 'Narwal 桥接的本地 WebSocket 端口。',
			advertise: '广播名称',
			advertiseDesc: '配对时手机上显示的名称。',
			tokens: '配对令牌',
			tokenDesc: '每台设备一枚。令牌是长期凭证 —— 设备遗失请立即吊销。',
			createToken: '创建令牌',
			tokenLabel: '设备标签',
			copied: '已复制',
			copy: '复制',
			pairingUsage: '在手机 Narwal 应用里选「添加主机」,粘贴下方配对串(下一版提供扫码)。',
			revoke: '吊销',
			relayTitle: 'Relay（实验）',
			relayDesc: '手机不在同一网络时，通过 relay 中转流量。',
			relayEnabled: '启用 relay',
			relayTicketHint: 'Relay ticket',
			liveDevices: '在线设备',
			noDevices: '当前没有设备连接。',
			createHint: '先在这里创建第一枚令牌 —— 它就是你手机连接用的凭证。',
			failed: '保存失败',
			noTokens: '还没有配对的设备。',
			lanHost: '局域网地址(IP)',
			lanHostDesc: '手机在 WiFi 内可直达的本机 IP —— 用于配对串(留空自动探测;127.0.0.1 手机不可用)。'
		}

		/* ------------------------------------------------------------------ */
		/* helpers                                                             */
		/* ------------------------------------------------------------------ */
		function buildPayload(secret, host, port, advertise, relay) {
			const params = new URLSearchParams({ v: '1', host, port: String(port), token: secret })
			if (advertise) params.set('name', advertise)
			if (relay?.enabled && relay.url && relay.ticket) {
				/* phone 直接走 relay;LAN 信息保留做后备展示 */
				params.set('relay', relay.url)
				params.set('ticket', relay.ticket)
			}
			return `narwal://pair?${params}`
		}

		/* ------------------------------------------------------------------ */
		/* styles(inline,theme-agnostic)                                      */
		/* ------------------------------------------------------------------ */
		const sub = { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 12, lineHeight: '18px', wordBreak: 'break-all' }
		const title = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
		const row = { borderBottom: '0.5px solid var(--dsw-alias-border-l2, #ddd)', justifyContent: 'space-between', alignItems: 'center', gap: 24, padding: '16px 0', display: 'flex' }
		const btn = { padding: '4px 10px', fontSize: 12, cursor: 'pointer' }
		const btnDanger = { ...btn, color: '#c00' }
		const input = { padding: '6px 8px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2, #ccc)', borderRadius: 6, width: 180 }
		const createRow = { display: 'flex', gap: 8, marginTop: 8 }

		/* ------------------------------------------------------------------ */
		/* components                                                          */
		/* ------------------------------------------------------------------ */
		function TokenRow(props) {
			const { token, host, port, advertise, t, onRevoke, onRelabel, relay } = props
			const payload = buildPayload(token.secret, host, port, advertise, relay)
			const [copied, setCopied] = useState(false)
			const copy = useCallback(() => {
				try { navigator.clipboard?.writeText(payload) } catch {}
				setCopied(true)
				setTimeout(() => setCopied(false), 1500)
			}, [payload])
			return React.createElement('div', { style: row },
				React.createElement('div', { style: { flex: 1, minWidth: 0 } },
					React.createElement('div', { style: title }, token.label || token.id),
					React.createElement('div', { style: sub }, payload),
					React.createElement('img', {
						src: `http://${bridgeHost}:${port}/qr.svg?token=${encodeURIComponent(token.secret)}`,
						alt: 'narwal pairing QR', width: 132, height: 132,
						style: { marginTop: 8, imageRendering: 'pixelated', background: '#fff', padding: 4, borderRadius: 6 }
					})),
				React.createElement('button', { style: btn, onClick: copy, title: payload }, copied ? t('copied') : t('copy')),
				React.createElement('button', { style: btn, onClick: () => {
					const next = window.prompt?.('重命名设备标签', token.label ?? '') ?? null
					if (next && next.trim()) void onRelabel(token.id, next)
				} }, '✎'),
				React.createElement('button', { style: btnDanger, onClick: () => onRevoke(token) }, t('revoke')),
			)
		}

		/*
		 * 渲染错误边界。设置面板一旦抛错，整个 slot 会渲染成空白 ——
		 * 之前 hooks 漏解构就是这么白屏的，日志里什么都看不到。
		 */
		class SectionBoundary extends React.Component {
			constructor(props) {
				super(props)
				this.state = { error: null }
			}
			static getDerivedStateFromError(error) {
				return { error }
			}
			render() {
				if (this.state.error) {
					return React.createElement('div', {
						style: { padding: 16, fontSize: 13, lineHeight: 1.6, color: '#e5484d', fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' }
					}, 'Narwal 面板渲染失败：\n' + String(this.state.error && this.state.error.stack || this.state.error))
				}
				return this.props.children
			}
		}

		function NarwalSection(props) {
			const { t, form, write } = props
			let snapshot = null
			try { snapshot = (typeof form.getSnapshot === 'function' ? form.getSnapshot() : form.get?.()) } catch {}
			const value = snapshot?.value ?? { port: 48317, advertiseName: 'narwal', tokens: [] }
			const [label, setLabel] = useState('')
			const [failed, setFailed] = useState(false)
			const [devices, setDevices] = useState(null)
			const [result, setResult] = useState(null)
			const [relayState, setRelayState] = useState(null)

			const statsTokenHint = useCallback(() => (Array.isArray(result?.tokens) ? result.tokens : (value.tokens ?? []))[0]?.secret ?? '', [value, result])

			const refreshTokens = useCallback(async () => {
				const secret = statsTokenHint()
				const qs = secret ? `?token=${encodeURIComponent(secret)}` : ''
				try {
					const res = await fetch(`http://${bridgeHost}:${value.port}/tokens${qs}`)
					if (!res.ok) { setResult(null); return }
					const body = await res.json()
					if (!stopRef.current) setResult(body)
				} catch { if (!stopRef.current) setResult(null) }
			}, [statsTokenHint, value.port])

			const kickDevice = useCallback(async (sessionId) => {
				const secret = statsTokenHint()
				if (!secret) return false
				try {
					const res = await fetch(`http://${bridgeHost}:${value.port}/devices?token=${encodeURIComponent(secret)}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId }),
					})
					return res.ok
				} catch { return false }
			}, [statsTokenHint, value.port])

			const adminAction = useCallback(async (payload) => {
				const secret = statsTokenHint()
				/* 本机面板免 secret：host 端对 loopback + DSH Origin 放行 */
				const qs = secret ? `?token=${encodeURIComponent(secret)}` : ''
				try {
					const res = await fetch(`http://${bridgeHost}:${value.port}/tokens${qs}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload),
					})
					if (!res.ok) {
						setFailed(`HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`)
						return false
					}
					if (payload?.action === 'create') {
						/* 新令牌需要立刻进入本地快照，否则后续调用仍然没有 secret 可用 */
						const created = await res.json().catch(() => null)
						if (created && created.secret) {
							setResult((prev) => ({ tokens: [...(prev?.tokens ?? []), created] }))
						}
					}
					await refreshTokens()
					return true
				} catch {
					setFailed(true)
					return false
				}
			}, [statsTokenHint, value.port, refreshTokens])

			// 设备动态/重载用例
			const stopRef = useRef(false)
			useEffect(() => () => { stopRef.current = true }, [])
			useEffect(() => {
				let stop = false
				const poll = async () => {
					const secret = statsTokenHint()
					void refreshTokens()
					if (!secret) { setDevices(null); setRelayState(null); return }
					try {
						const res = await fetch(`http://${bridgeHost}:${value.port}/stats?token=${encodeURIComponent(secret)}`)
						if (!res.ok) { setDevices(null); return }
						const body = await res.json()
						if (!stop) setDevices(Array.isArray(body?.devices) ? body.devices : [])
					} catch {
						if (!stop) setDevices(null)
					}
					try {
						const rs = await fetch(`http://${bridgeHost}:${value.port}/relay-status?token=${encodeURIComponent(secret)}`)
						if (rs.ok) {
							const body = await rs.json()
							if (!stop) setRelayState(body?.enabled ? body : null)
						}
					} catch {
						if (!stop) setRelayState(null)
					}
				}
				void poll()
				const timer = setInterval(poll, 5000)
				return () => { stop = true; clearInterval(timer) }
			}, [statsTokenHint, value.port])

			const hostCard = () => {
				const meta = result
				if (!meta) return null
				return React.createElement('div', { style: { ...row, borderBottom: 'none', padding: '10px 0' } },
					React.createElement('div', { style: { flex: 1, minWidth: 0 } },
						React.createElement('div', { style: title }, `${meta.pairHost ?? '?'}:${meta.port ?? value.port}`),
						React.createElement('div', { style: sub },
							`${meta.advertiseName ?? ''} · 令牌 ${meta.tokens ?? '?'} 枚 · 在线设备 ${Array.isArray(devices) ? devices.length : '?'} 台 · ${hostLabelNow()}`)))
			}
			const hostLabelNow = () => (value.advertiseName || 'narwal')

			const create = () => {
				const name = (label || 'iPhone').trim()
				setLabel('')
				void adminAction({ action: 'create', label: name })
			}

			const autoHost = (globalThis.location && bridgeHost) || 'lan-host'
			const host = value.lanHost || (autoHost === '127.0.0.1' || autoHost === 'localhost' ? '' : autoHost) || 'LAN-IP-未设置'
			return React.createElement('div', { style: { maxWidth: 640 } },
				React.createElement('p', { style: sub }, t('sectionDesc')),
				hostCard(),
				React.createElement('div', { style: row },
					React.createElement('div', null,
						React.createElement('div', { style: title }, t('port')),
						React.createElement('div', { style: sub }, t('portDesc'))),
					React.createElement('input', {
						style: input, value: value.port ?? '',
						onChange: (e) => write('port', Number(e.target.value) || 0)
					})),
				React.createElement('div', { style: row },
					React.createElement('div', null,
						React.createElement('div', { style: title }, t('advertise')),
						React.createElement('div', { style: sub }, t('advertiseDesc'))),
					React.createElement('input', {
						style: input, value: value.advertiseName ?? '',
						onChange: (e) => write('advertiseName', e.target.value)
					})),
				React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 16, marginTop: 18 } },
					React.createElement('div', null,
						React.createElement('div', { style: title }, t('lanHost')),
						React.createElement('div', { style: sub }, t('lanHostDesc'))),
					React.createElement('input', {
						style: { ...input, width: 220 }, value: value.lanHost ?? '',
						placeholder: '自动检测',
						onChange: (e) => write('lanHost', e.target.value)
					})),
				React.createElement('div', { style: { ...title, marginTop: 24 } }, t('tokens')),
				React.createElement('div', { style: sub }, t('tokenDesc')),
				React.createElement('div', { style: createRow },
					React.createElement('input', {
						style: { ...input, width: 140 }, placeholder: t('tokenLabel'),
						value: label, onChange: (e) => setLabel(e.target.value)
					}),
					React.createElement('button', { style: btn, onClick: create }, t('createToken'))),
				failed
					? React.createElement('div', { style: { color: '#e5484d', marginTop: 8, fontSize: 12, whiteSpace: 'pre-wrap' } },
						typeof failed === 'string' ? failed : t('failed'))
					: null,
				!((result?.tokens) ?? []).length
					? React.createElement('p', { style: sub }, t('noTokens'))
					: (result.tokens ?? [{ id: 'unknown', label: '(刷新中)', secret: '' }]).map((tok) => React.createElement(TokenRow, {
						key: tok.id, token: tok, host, port: value.port, advertise: value.advertiseName, t,
						onRevoke: (dead) => { void adminAction({ action: 'revoke', id: dead.id }) },
						onRelabel: (id, label) => { void adminAction({ action: 'relabel', id, label }).then(() => void refreshTokens()) }
					})),
				React.createElement('div', { style: { ...title, marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 } },
					React.createElement('div', { style: title }, t('relayTitle')),
					React.createElement('div', { style: sub }, t('relayDesc')),
					relayState && React.createElement('div', { style: { ...sub, color: relayState.state === 'connected' ? '#2f9e5e' : '#bbb' } },
						relayState.state === 'connected'
							? `已连接 ${relayState.url} ✓`
							: `状态 ${relayState.state}${relayState.hasTicket ? '' : '(缺 ticket)'}`),
					React.createElement('label', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
						React.createElement('input', {
							type: 'checkbox',
							checked: value.relay?.enabled === true,
							onChange: (e) => write('relay.enabled', e.target.checked),
						}),
						React.createElement('span', { style: { fontSize: 13 } }, t('relayEnabled'))),
					React.createElement('input', {
						style: { ...input, width: 320 }, placeholder: 'wss://relay.example.com', value: value.relay?.url ?? '',
						onChange: (e) => write('relay.url', e.target.value)
					}),
					React.createElement('input', {
						style: { ...input, width: 320 }, placeholder: t('relayTicketHint'), value: value.relay?.ticket ?? '',
						onChange: (e) => write('relay.ticket', e.target.value)
					})),
				React.createElement('div', { style: { ...title, marginTop: 24 } }, t('liveDevices')),
				React.createElement('div', null, Array.isArray(devices)
					? devices.length === 0 ? React.createElement('div', { style: sub }, t('noDevices'))
						: devices.map((d) => React.createElement('div', { key: d.sessionId, style: { ...sub, display: 'flex', gap: 8, alignItems: 'center' } },
							React.createElement('span', { style: { flex: 1 } },
								`${d.label ?? d.sessionId} · ${d.streams} 条实时流${d.connectedAt ? ' · ' + new Date(d.connectedAt).toLocaleTimeString() : ''}`),
							React.createElement('button', {
								style: { ...btnDanger, fontSize: 11, padding: '2px 8px' },
								onClick: () => { void kickDevice(d.sessionId) },
								title: '断开该设备(其自动重连会因鉴权不清而重试)'
							}, '断开')))
					: React.createElement('div', { style: sub }, '…')),
				React.createElement('p', { style: { ...sub, marginTop: 20 } }, t('pairingUsage'))
			)
		}

		// 32 px export of apps/mobile/assets/images/icon.png, embedded for the standalone DSH client.
		const appIcon = 'data:image/png;base64,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'

		function NarwalIcon(props) {
			const size = props?.size || 16
			return React.createElement('img', {
				src: appIcon,
				alt: '',
				width: size,
				height: size,
				style: { borderRadius: size / 4 }
			})
		}

		/* ------------------------------------------------------------------ */
		/* activation —— { inject, apply }(official settings.*  precedent)     */
		/* ------------------------------------------------------------------ */
		const inject = ['slots', 'locale', 'configForms']
		const NS = 'settings.narwal'

		/**
		 * 桥的访问主机。
		 * Electron 里页面可能是 dsh-app://app，此时 bridgeHost 是 "app"，
		 * 拼出来的 http://app:48318 无法解析 —— 回退到 127.0.0.1。
		 */
		const bridgeHost = (() => {
			try {
				const h = globalThis.location?.hostname ?? ''
				if (/^(127\.0\.0\.1|localhost|\[::1\]|\d{1,3}(\.\d{1,3}){3})$/.test(h)) return h
			} catch { /* nop */ }
			return '127.0.0.1'
		})()

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }))
			const form = ctx.configForms.get('narwal-server')
			/** single-path write; returns true on accepted write */
			const write = (key, value) => {
				try { void form.set(key, value); return true } catch { return false }
			}
			ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
				name: 'settings.section',
				id: 'narwal',
				order: 25,
				label: () => ctx.locale.bind(NS)('nav'),
				locale: NS,
				inject: () => ({ form, write, locale: ctx.locale.bind(NS), t: ctx.locale.bind(NS) })
			}, (props) => React.createElement(SectionBoundary, null, React.createElement(NarwalSection, props)))))
			ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
				name: 'settings.section.icon',
				id: 'narwal'
			}, NarwalIcon)))
		}

		exports.inject = inject
		exports.apply = apply
		return module.exports
	}
})
