import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_WORKSPACE_EXPANSION_BYTES = 256 * 1024
const snapshots = new WeakMap()

function normalize(expanded) {
	if (!expanded || typeof expanded !== 'object' || Array.isArray(expanded)) throw new TypeError('Expected a workspace expansion map')
	const entries = Object.entries(expanded)
	if (entries.length > 4096 || entries.some(([id, open]) => id.length > 128 || typeof open !== 'boolean')) {
		throw new TypeError('Invalid workspace expansion map')
	}
	entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
	return { expanded: Object.fromEntries(entries) }
}

function expansionFile(bridge) {
	return join(bridge.store.dir, 'workspace-expansion.json')
}

export function readWorkspaceExpansion(bridge) {
	if (!snapshots.has(bridge)) {
		let snapshot = { expanded: null }
		try {
			snapshot = normalize(JSON.parse(readFileSync(expansionFile(bridge), 'utf8')).expanded)
		} catch (error) {
			if (error?.code !== 'ENOENT') bridge.log.warn('Could not read saved workspace expansion: %s', error?.message)
		}
		snapshots.set(bridge, { snapshot, json: JSON.stringify(snapshot) })
	}
	return snapshots.get(bridge).snapshot
}

export function publishWorkspaceExpansion(bridge, value) {
	const snapshot = normalize(value?.expanded)
	const json = JSON.stringify(snapshot)
	readWorkspaceExpansion(bridge)
	if (snapshots.get(bridge).json === json) return
	const path = expansionFile(bridge)
	mkdirSync(bridge.store.dir, { recursive: true, mode: 0o700 })
	writeFileSync(`${path}.tmp`, json, { mode: 0o600 })
	renameSync(`${path}.tmp`, path)
	snapshots.set(bridge, { snapshot, json })
	for (const device of bridge.devices.values()) {
		if (device.active) bridge.send(device, { event: 'narwal/workspaceExpansion', payload: snapshot })
	}
}
