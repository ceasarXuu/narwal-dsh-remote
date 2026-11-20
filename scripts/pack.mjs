#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAID_ARCHIVE, verifyMaidArchive } from '../maid-install.js'

const src = fileURLToPath(new URL('../', import.meta.url))
const dest = resolve(process.argv[2] ?? tmpdir())
const staging = mkdtempSync(join(tmpdir(), 'narwal-dsh-pack-'))
const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'))
const noiseDirectory = process.env.NARWAL_NOISE_DIR
const maidPackage = process.env.NARWAL_MAID_PACKAGE

function stageNoiseRuntime(directory) {
  if (!directory.trim()) throw new Error('NARWAL_NOISE_DIR must point to a built Narwal Noise Node runtime')
  const vendorPath = 'vendor/relay-crypto'
  mkdirSync(join(staging, vendorPath), { recursive: true })
  for (const file of ['index.mjs', 'node.mjs', 'narwal_noise.node']) {
    const input = resolve(directory, file)
    const asset = lstatSync(input, { throwIfNoEntry: false })
    if (!asset?.isFile() || !asset.size) {
      throw new Error(`Missing or invalid Narwal Noise runtime file: ${input}`)
    }
    const relative = `${vendorPath}/${file}`
    cpSync(input, join(staging, relative))
    pkg.files.push(relative)
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { pathToFileURL } from 'node:url'
    const { loadNodeNoise } = await import(pathToFileURL(process.argv[1]).href)
    const { privateKey, publicKey } = loadNodeNoise().generateKeypair()
    if (![privateKey, publicKey].every(key => /^[0-9a-f]{64}$/.test(key))) {
      throw new Error('Invalid keypair from staged Narwal Noise runtime')
    }
  `, join(staging, vendorPath, 'node.mjs')], { stdio: 'inherit' })
  pkg.private = true
  delete pkg.publishConfig
  pkg.os = [process.platform]
  pkg.cpu = [process.arch]
}

try {
  for (const file of pkg.files) {
    const output = join(staging, file)
    mkdirSync(dirname(output), { recursive: true })
    cpSync(join(src, file), output)
  }
  if (noiseDirectory !== undefined) stageNoiseRuntime(noiseDirectory)
  if (maidPackage !== undefined) {
    if (noiseDirectory === undefined) throw new Error('NARWAL_MAID_PACKAGE is only supported in private Narwal packages')
    const bytes = readFileSync(maidPackage)
    verifyMaidArchive(bytes)
    writeFileSync(join(staging, MAID_ARCHIVE), bytes)
    pkg.files.push(MAID_ARCHIVE)
  }

  // Preserve module paths used by DSH and the host hot reloader.
  const runtimeFiles = ['index.js', 'runtime-updates.js', 'client.js', ...pkg.narwalRuntime.files]
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

  if (noiseDirectory === undefined) delete pkg.private
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
