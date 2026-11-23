const DEEPSEEK_ORIGIN = 'https://api.deepseek.com'
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i

/** Read the wallet balance with the DeepSeek API key the Host releases for this one request. */
export async function readApiBalances(ctx) {
	try {
		const auth = ctx.get('deepseekAuth')
		if (!auth?.authorize) return { status: 'unsupported' }
		const request = {
			consumer: 'narwal-dsh-remote',
			accepts: ['api-key'],
			destination: { url: `${DEEPSEEK_ORIGIN}/user/balance` },
		}
		// A deployment that does not serve the official origin (a proxy, a custom baseURL) keeps the card hidden.
		if (typeof auth.candidates === 'function' && auth.candidates(request).length === 0) return { status: 'unsupported' }
		const authorization = await auth.authorize(request)
		if (!authorization) return { status: 'unconfigured' }

		const response = await fetch(authorization.endpoint, {
			headers: authorization.headers,
			redirect: 'error',
			signal: AbortSignal.timeout(5000),
		})
		if (response.status === 401) await authorization.reject?.()
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
