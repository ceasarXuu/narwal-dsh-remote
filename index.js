/**
 * Narwal Server — host 半区·引导壳。
 *
 * DSH 自带的 hmr 只热更配置（`root: []`，模块热重载默认关闭），改 node_modules
 * 下的插件代码不会被重新加载。为了改代码不用重启 DSH，这里把实现全部放进
 * `impl.js`，由本壳负责：
 *
 *   1. 监听 impl.js 的 mtime
 *   2. 变化时用 `?v=<timestamp>` 重新 import（绕开 ESM 模块缓存）
 *   3. 先停旧 bridge 释放端口，再起新 bridge，失败则记录并保留空闲状态
 *
 * 因此：改 impl.js / client.js 都不需要重启 DSH。
 * 只有改本文件（壳）本身才需要重启 —— 壳应该保持极小且稳定。
 */
import { watch } from 'node:fs'
import { fileURLToPath } from 'node:url'

const IMPL = fileURLToPath(new URL('./impl.js', import.meta.url))
const RELOAD_DEBOUNCE_MS = 300
/** 旧 server 关闭到新 server bind 之间的让位时间，避免偶发 EADDRINUSE。 */
const PORT_RELEASE_MS = 150

export function apply(ctx, config) {
	const log = (msg, error) => {
		const line = `[narwal] ${msg}${error ? `: ${error && error.stack ? error.stack : String(error)}` : ''}`
		try {
			process.stderr.write(line + '\n')
		} catch {
			/* nop */
		}
		try {
			ctx.logger('narwal-server').warn('%s%s', msg, error ? `: ${String(error)}` : '')
		} catch {
			/* logger 不可用时静默 */
		}
	}

	let stopped = false
	let loading = false
	let pending = false
	let current = null
	let debounce = null
	let watcher = null

	const load = async () => {
		if (stopped) return
		if (loading) {
			pending = true
			return
		}
		loading = true

		/* 先放掉旧实例，端口才能被新实例绑定 */
		const previous = current
		current = null
		try {
			previous?.stop?.()
		} catch (error) {
			log('previous instance stop failed', error)
		}
		if (previous) await new Promise((resolve) => setTimeout(resolve, PORT_RELEASE_MS))

		try {
			const url = new URL(`./impl.js?v=${Date.now()}`, import.meta.url).href
			const impl = await import(url)
			if (stopped) return
			current = await impl.start(ctx, config)
			log('bridge started')
		} catch (error) {
			log('bridge start failed', error)
		} finally {
			loading = false
			if (pending && !stopped) {
				pending = false
				void load()
			}
		}
	}

	void load()

	/* 监听实现文件；编辑器保存常触发多次事件，做一次防抖 */
	try {
		watcher = watch(IMPL, () => {
			if (debounce) clearTimeout(debounce)
			debounce = setTimeout(() => {
				debounce = null
				log('impl.js changed — reloading')
				if (current) {
					/* 停掉再重载：load() 内部会先释放旧实例 */
				}
				void load()
			}, RELOAD_DEBOUNCE_MS)
		})
		watcher.on('error', (error) => log('watcher error', error))
	} catch (error) {
		log('watcher unavailable; hot reload disabled', error)
	}

	return () => {
		stopped = true
		if (debounce) clearTimeout(debounce)
		try {
			watcher?.close()
		} catch {
			/* nop */
		}
		try {
			current?.stop?.()
		} catch {
			/* nop */
		}
		current = null
	}
}

export const inject = ['connection', 'typertGateway']
