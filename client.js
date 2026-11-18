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
			sectionDesc: 'Pair the Narwal iOS app to drive this DeepSeek Harness from your phone.',
			addDevice: 'Add device',
			emptyTitle: 'No device paired yet',
			emptyDesc: 'Generate a QR code, then scan it with Narwal on your phone.',
			emptyAction: 'Generate pairing QR code',
			devices: 'Paired devices',
			online: 'Online',
			offline: 'Not connected',
			showQr: 'QR code',
			hideQr: 'Hide',
			scanHint: 'Open Narwal on your phone and scan this code.',
			remove: 'Remove',
			removeConfirm: 'Remove this device? It will be disconnected and must be paired again.',
			deviceName: 'device',
			rename: 'Rename',
			unavailable: 'Narwal service is starting up…',
			failed: 'Operation failed',
			trafficTitle: 'Traffic usage',
			trafficRange: 'Last 30 days · desktop to phone',
			trafficWifi: 'Wi-Fi',
			trafficRelay: 'Relay',
			trafficUnavailable: 'Traffic usage is unavailable.',
			trafficDetails: 'Daily breakdown',
			trafficDate: 'Date',
		}
		const zh = {
			nav: 'Narwal',
			sectionDesc: '配对 Narwal iOS 客户端，在手机上操控这台 DeepSeek Harness。',
			addDevice: '添加设备',
			emptyTitle: '还没有配对设备',
			emptyDesc: '生成二维码，用手机上的 Narwal 扫描即可连接。',
			emptyAction: '生成配对二维码',
			devices: '已配对设备',
			online: '在线',
			offline: '未连接',
			showQr: '二维码',
			hideQr: '收起',
			scanHint: '打开手机上的 Narwal，扫描此二维码。',
			remove: '移除',
			removeConfirm: '移除该设备？它会被断开，需要重新配对。',
			deviceName: 'device',
			rename: '重命名',
			unavailable: 'Narwal 服务正在启动…',
			failed: '操作失败',
			trafficTitle: '流量统计',
			trafficRange: '最近 30 天 · 桌面发送到手机',
			trafficWifi: 'Wi-Fi 直连',
			trafficRelay: 'Relay 中转',
			trafficUnavailable: '暂时无法读取流量数据。',
			trafficDetails: '按日明细',
			trafficDate: '日期',
		}

		/* ------------------------------------------------------------------ */
		/* styles(inline,theme-agnostic)                                      */
		/* ------------------------------------------------------------------ */
		const border = '0.5px solid var(--dsw-alias-border-l2, #ddd)'
		const sub = { color: 'var(--dsw-alias-label-secondary, #888)', fontSize: 12, lineHeight: '18px' }
		const title = { fontSize: 14, lineHeight: '20px', fontWeight: 600 }
		const btn = { padding: '5px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'transparent', color: 'inherit' }
		const btnDanger = { ...btn, color: '#e5484d' }
		const card = { border, borderRadius: 10, overflow: 'hidden' }
		const wifiColor = '#5785df'
		const relayColor = '#3a9e80'
		const trafficNumber = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 })

		function formatMegabytes(bytes) {
			const megabytes = bytes / 1_000_000
			return megabytes > 0 && megabytes < 0.01
				? `<${trafficNumber.format(0.01)} MB`
				: `${trafficNumber.format(megabytes)} MB`
		}

		/* ------------------------------------------------------------------ */
		/* components                                                          */
		/* ------------------------------------------------------------------ */
		function QrBlock(props) {
			const { token, port, t } = props
			return React.createElement('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '8px 0 20px' } },
				React.createElement('img', {
					src: `http://${bridgeHost}:${port}/qr.svg?token=${encodeURIComponent(token.secret)}`,
					alt: 'Narwal pairing QR', width: 176, height: 176,
					style: { imageRendering: 'pixelated', background: '#fff', padding: 8, borderRadius: 10 }
				}),
				React.createElement('div', { style: sub }, t('scanHint')))
		}

		function DeviceName(props) {
			const { token, t, onRename } = props
			const [draft, setDraft] = useState(null)
			const name = token.label || token.id
			const commit = () => {
				const next = (draft ?? '').trim()
				setDraft(null)
				if (next && next !== name) onRename(token.id, next)
			}
			if (draft !== null) {
				return React.createElement('input', {
					autoFocus: true, value: draft, maxLength: 24,
					style: { ...title, width: '100%', boxSizing: 'border-box', padding: '1px 6px', margin: '-2px -7px', border: '1px solid var(--dsw-alias-border-l2, #ccc)', borderRadius: 6, background: 'transparent', color: 'inherit', outline: 'none' },
					onChange: (e) => setDraft(e.target.value),
					onBlur: commit,
					onKeyDown: (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setDraft(null) }
				})
			}
			return React.createElement('div', { style: { ...title, cursor: 'text', display: 'inline-flex', alignItems: 'center', gap: 6 }, title: t('rename'), onClick: () => setDraft(name) },
				name, React.createElement('span', { style: { ...sub, fontWeight: 400 } }, '\u270E'))
		}

		function DeviceRow(props) {
			const { token, online, open, first, port, t, onToggle, onRemove, onRename } = props
			return React.createElement('div', { style: first ? null : { borderTop: border } },
				React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px' } },
					React.createElement('span', { style: { width: 8, height: 8, borderRadius: 4, flex: 'none', background: online ? '#2f9e5e' : '#c4c4c4' } }),
					React.createElement('div', { style: { flex: 1, minWidth: 0 } },
						React.createElement(DeviceName, { token, t, onRename }),
						React.createElement('div', { style: sub }, online ? t('online') : t('offline'))),
					React.createElement('button', { style: btn, onClick: onToggle }, open ? t('hideQr') : t('showQr')),
					React.createElement('button', { style: btnDanger, onClick: onRemove }, t('remove'))),
				open ? React.createElement(QrBlock, { token, port, t }) : null)
		}

		function TrafficSummary({ label, color, bytes }) {
			return React.createElement('div', { style: { minWidth: 0 } },
				React.createElement('div', { style: { ...sub, display: 'flex', alignItems: 'center', gap: 6 } },
					React.createElement('span', { 'aria-hidden': true, style: { width: 7, height: 7, borderRadius: 4, background: color } }), label),
				React.createElement('div', { style: { fontSize: 20, marginTop: 3, fontWeight: 600, fontVariantNumeric: 'tabular-nums' } }, formatMegabytes(bytes)))
		}

		function TrafficChart({ days, wifiLabel, relayLabel }) {
			const max = Math.max(1, ...days.map(day => day.wifiBytes + day.relayBytes))
			return React.createElement('div', { 'aria-hidden': true, style: { marginTop: 16 } },
				React.createElement('div', { style: { display: 'flex', height: 50, gap: 3, borderBottom: border } },
					days.map(day => React.createElement('div', {
						key: day.date, title: `${day.date}\n${wifiLabel} ${formatMegabytes(day.wifiBytes)}\n${relayLabel} ${formatMegabytes(day.relayBytes)}`,
						style: { display: 'flex', flexDirection: 'column-reverse', flex: 1, borderRadius: '2px 2px 0 0', overflow: 'hidden', alignSelf: 'end', height: (day.wifiBytes + day.relayBytes) / max * 100 + '%' },
					},
					React.createElement('span', { style: { flex: day.wifiBytes, backgroundColor: wifiColor } }),
					React.createElement('span', { style: { flex: day.relayBytes, backgroundColor: relayColor } })))),
				React.createElement('div', { style: { ...sub, display: 'flex', justifyContent: 'space-between', marginTop: 4 } },
					days[0].date.slice(5), days.at(-1).date.slice(5)))
		}

		function TrafficSection({ traffic, t }) {
			const days = traffic?.days
			const wifiLabel = t('trafficWifi')
			const relayLabel = t('trafficRelay')
			const heading = React.createElement('div', { style: title }, t('trafficTitle'))
			const range = React.createElement('div', { style: { ...sub, margin: '3px 0 10px' } }, t('trafficRange'))
			const content = Array.isArray(days) && days.length
				? React.createElement('div', { style: { ...card, padding: 16 } },
					React.createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 } },
						React.createElement(TrafficSummary, { label: wifiLabel, color: wifiColor, bytes: days.reduce((sum, day) => sum + day.wifiBytes, 0) }),
						React.createElement(TrafficSummary, { label: relayLabel, color: relayColor, bytes: days.reduce((sum, day) => sum + day.relayBytes, 0) })),
					React.createElement(TrafficChart, { days, wifiLabel, relayLabel }),
					React.createElement(TrafficDetails, { days, columnLabels: [t('trafficDate'), wifiLabel, relayLabel], label: t('trafficDetails') }))
				: React.createElement('div', { style: { ...card, ...sub, padding: 16 } }, t('trafficUnavailable'))
			return React.createElement('section', { style: { marginTop: 24 }, 'aria-label': t('trafficTitle') }, heading, range, content)
		}

		function TrafficDetails({ days, columnLabels, label }) {
			const cell = { textAlign: 'start', padding: '6px 4px', borderBottom: border, fontWeight: 'inherit' }
			const columns = columnLabels.map(text => React.createElement('th', { key: text, scope: 'col', style: cell }, text))
			const rows = [...days].reverse().map(day => React.createElement('tr', { key: day.date },
				React.createElement('th', { scope: 'row', style: cell }, day.date),
				React.createElement('td', { style: cell }, formatMegabytes(day.wifiBytes)),
				React.createElement('td', { style: cell }, formatMegabytes(day.relayBytes))))
			return React.createElement('details', { style: { ...sub, marginTop: 12 } },
				React.createElement('summary', { style: { cursor: 'pointer' } }, label),
				React.createElement('div', { style: { maxHeight: 256, overflowY: 'auto', marginTop: 8 } },
					React.createElement('table', { style: { borderCollapse: 'collapse', width: '100%', fontVariantNumeric: 'tabular-nums' } },
						React.createElement('thead', null, React.createElement('tr', null, columns)),
						React.createElement('tbody', null, rows))))
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
					}, 'Narwal panel failed to render:\n' + String(this.state.error && this.state.error.stack || this.state.error))
				}
				return this.props.children
			}
		}

		function NarwalSection(props) {
			const { t, form } = props
			let snapshot = null
			try { snapshot = (typeof form.getSnapshot === 'function' ? form.getSnapshot() : form.get?.()) } catch {}
			const port = Number(snapshot?.value?.port) || 48317
			const [tokens, setTokens] = useState(null)
			const [online, setOnline] = useState([])
			const [traffic, setTraffic] = useState(null)
			const [openId, setOpenId] = useState(null)
			const [failed, setFailed] = useState(false)
			const stopRef = useRef(false)
			const secretRef = useRef('')
			const base = `http://${bridgeHost}:${port}`

			const refresh = useCallback(async () => {
				const qs = secretRef.current ? `?token=${encodeURIComponent(secretRef.current)}` : ''
				try {
					const res = await fetch(`${base}/tokens${qs}`)
					if (!res.ok) throw new Error(String(res.status))
					const body = await res.json()
					const list = Array.isArray(body?.tokens) ? body.tokens : []
					secretRef.current = list[0]?.secret ?? ''
					if (stopRef.current) return
					setTokens(list)
					const statsQuery = secretRef.current ? `?token=${encodeURIComponent(secretRef.current)}` : ''
					const stats = await fetch(`${base}/stats${statsQuery}`)
					const info = stats.ok ? await stats.json() : null
					if (!stopRef.current) {
						setOnline(Array.isArray(info?.devices) ? info.devices.map((d) => d.tokenId) : [])
						setTraffic(info?.traffic ?? null)
					}
				} catch {
					if (!stopRef.current) setTokens(null)
				}
			}, [base])

			useEffect(() => {
				stopRef.current = false
				void refresh()
				const timer = setInterval(refresh, 5000)
				return () => { stopRef.current = true; clearInterval(timer) }
			}, [refresh])

			/* 本机面板免 secret：host 端对 loopback + DSH Origin 放行 */
			const post = useCallback(async (payload) => {
				const qs = secretRef.current ? `?token=${encodeURIComponent(secretRef.current)}` : ''
				try {
					const res = await fetch(`${base}/tokens${qs}`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(payload)
					})
					if (!res.ok) throw new Error(String(res.status))
					setFailed(false)
					return await res.json().catch(() => null)
				} catch {
					setFailed(true)
					return null
				}
			}, [base])

			const addDevice = async () => {
				const used = new Set((tokens ?? []).map((x) => x.label))
				let n = 1
				while (used.has(`${t('deviceName')}(${n})`)) n += 1
				const created = await post({ action: 'create', label: `${t('deviceName')}(${n})` })
				if (created?.id) {
					if (created.secret && !secretRef.current) secretRef.current = created.secret
					setOpenId(created.id)
				}
				await refresh()
			}
			const rename = async (id, label) => {
				await post({ action: 'relabel', id, label })
				await refresh()
			}
			const remove = async (token) => {
				if (typeof window.confirm === 'function' && !window.confirm(t('removeConfirm'))) return
				await post({ action: 'revoke', id: token.id })
				if (openId === token.id) setOpenId(null)
				await refresh()
			}

			return React.createElement('div', { style: { maxWidth: 560 } },
				React.createElement('p', { style: { ...sub, marginTop: 0, marginBottom: 16 } }, t('sectionDesc')),
				tokens === null
					? React.createElement('div', { style: sub }, t('unavailable'))
					: tokens.length === 0
						? React.createElement('div', { style: { ...card, padding: '32px 16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 } },
							React.createElement('div', { style: title }, t('emptyTitle')),
							React.createElement('div', { style: sub }, t('emptyDesc')),
							React.createElement('button', { style: { ...btn, marginTop: 8 }, onClick: () => { void addDevice() } }, t('emptyAction')))
						: React.createElement('div', null,
							React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
								React.createElement('div', { style: title }, t('devices')),
								React.createElement('button', { style: btn, onClick: () => { void addDevice() } }, t('addDevice'))),
							React.createElement('div', { style: card },
								tokens.map((tok, i) => React.createElement(DeviceRow, {
									key: tok.id, token: tok, port, t, first: i === 0,
									online: online.includes(tok.id),
									open: openId === tok.id,
									onToggle: () => setOpenId(openId === tok.id ? null : tok.id),
									onRemove: () => { void remove(tok) },
					onRename: (id, label) => { void rename(id, label) }
								})))),
				failed ? React.createElement('div', { style: { ...sub, color: '#e5484d', marginTop: 10 } }, t('failed')) : null,
				React.createElement(TrafficSection, { traffic, t })
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
