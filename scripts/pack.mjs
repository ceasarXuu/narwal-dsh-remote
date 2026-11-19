#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('../', import.meta.url))
const dest = resolve(process.argv[2] ?? tmpdir())
const staging = mkdtempSync(join(tmpdir(), 'narwal-dsh-pack-'))
const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))

try {
  for (const file of pkg.files) {
    const output = join(staging, file)
    mkdirSync(dirname(output), { recursive: true })
    cpSync(join(src, file), output)
  }

  // Preserve module paths used by DSH and the host hot reloader.
  const runtimeFiles = [
    'index.js', 'impl.js', 'api-balances.js', 'github-projects.js', 'github-projects-install.js',
    'traffic-usage.js', 'client.js', 'vendor/toqr.mjs',
  ]
  for (const file of runtimeFiles) {
    const output = join(staging, file)
    execFileSync('npm', [
      'exec', '--yes', '--registry=https://registry.npmjs.org', '--package=terser@5.51.2', '--',
      'terser', output, '--compress', '--mangle', '--comments', 'some', '--output', output,
    ], { stdio: 'inherit' })
    execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' })
  }

  execFileSync(process.execPath, [
    join(src, 'scripts/check-client.mjs'), join(staging, 'client.js'), '--packed',
  ], { stdio: 'inherit' })

  // Only the staged build may be published. Its development scripts are omitted.
  delete pkg.private
  delete pkg.scripts
  writeFileSync(join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
  mkdirSync(dest, { recursive: true })
  execFileSync('npm', ['pack', '--pack-destination', dest], {
    cwd: staging,
    stdio: 'inherit',
  })
} finally {
  rmSync(staging, { recursive: true, force: true })
}
