const NAME = '@ceasarxuu/dsh-github-projects'
const VERSION = '1.0.2'
const REGISTRY = 'https://registry.npmjs.org'

export function createGitHubProjectsInstaller(getManager) {
	let active
	let outcome

	async function loadBundle() {
		const manager = getManager()
		if (typeof manager?.listBundles !== 'function') return { kind: 'unavailable' }
		const bundles = await manager.listBundles()
		if (!Array.isArray(bundles)) return { kind: 'unavailable' }
		const bundle = bundles.find(entry => entry.name === NAME)
		if (!bundle?.installed) {
			return { kind: typeof manager.installBundle === 'function' ? 'missing' : 'unavailable', manager }
		}
		if (!bundle.enabled) {
			return { kind: typeof manager.setBundleEnabled === 'function' ? 'disabled' : 'unavailable', manager }
		}
		return { kind: 'registered', manager }
	}

	return {
		async availability() {
			if (active) return { kind: active }
			try {
				const { kind } = await loadBundle()
				return { kind: active ?? (kind === outcome?.when ? outcome.kind : kind) }
			} catch {
				return { kind: active ?? 'unavailable' }
			}
		},
		start(action) {
			if (active) return { kind: active }
			const install = action === 'install'
			const expected = install ? 'missing' : 'disabled'
			const pending = install ? 'installing' : 'enabling'
			const failure = install ? 'install-failed' : 'enable-failed'
			active = pending
			outcome = undefined
			void (async () => {
				try {
					const { kind, manager } = await loadBundle()
					if (kind !== expected) return
					const result = install
						? await manager.installBundle(`${NAME}@${VERSION}`, {
							enabled: true, saveExact: true, registry: REGISTRY, expected: { name: NAME, version: VERSION },
						})
						: await manager.setBundleEnabled(NAME, true)
					if (result?.application === 'restart-required') {
						outcome = { when: 'registered', kind: 'restart' }
					} else if (result?.application !== 'applied') {
						outcome = { when: (await loadBundle()).kind, kind: failure }
					}
				} catch {
					outcome = { when: expected, kind: failure }
				} finally {
					active = undefined
				}
			})()
			return { kind: pending }
		},
	}
}
