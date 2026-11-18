const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** Resolve the active provider's effective desktop settings before reading its credential. */
export async function readApiBalances(ctx) {
	try {
		const llm = ctx.get('llm')
		const settings = ctx.get('settings')
		const environment = ctx.get('launchEnvironment')
		if (!llm?.listConfigurableProviders || !settings?.describe || !environment) return { status: 'unsupported' }
		const provider = llm.listConfigurableProviders().find((entry) => entry.provider === 'deepseek-official')
		if (!provider) return { status: 'unsupported' }
		let profile = settings.describe({ redactSecrets: true }).find((entry) => entry.ns === provider.settingsNs)?.value
		for (const part of provider.settingsPath) profile = profile?.[part]
		if (!profile || typeof profile !== 'object') return { status: 'unsupported' }

		const [adapter, credentials] = await Promise.all([
			import('@deepseek-ai/dsh-llm-deepseek-api-key').catch(() => null),
			import('@deepseek-ai/dsh-llm-deepseek').catch(() => null),
		])
		if (!adapter?.resolveAdapterOptions || !credentials?.resolveDeepSeekApiKey) return { status: 'unsupported' }
		const { baseURL, apiKeyEnv } = adapter.resolveAdapterOptions(profile, environment)
		if (new URL(baseURL).origin !== DEEPSEEK_ORIGIN) return { status: 'unsupported' }
		const key = await credentials.resolveDeepSeekApiKey(ctx, apiKeyEnv)
		if (!key) return { status: 'unconfigured' }

		const response = await fetch(`${DEEPSEEK_ORIGIN}/user/balance`, {
			headers: { Authorization: `Bearer ${key}` },
			redirect: 'error',
			signal: AbortSignal.timeout(5000),
		})
		if (!response.ok) return { status: 'failed' }
		const { balance_infos: entries } = await response.json()
		if (!Array.isArray(entries) || entries.length > 2) return { status: 'failed' }
		const balances = []
		for (const entry of entries) {
			const { currency, total_balance: balance } = entry ?? {}
			if ((currency !== 'CNY' && currency !== 'USD') || typeof balance !== 'string'
				|| balance.length > 128 || !DECIMAL.test(balance)) return { status: 'failed' }
			balances.push({ provider: 'DeepSeek API', currency, balance })
		}
		return { status: 'ready', balances }
	} catch {
		return { status: 'failed' }
	}
}
