#!/usr/bin/env node
/**
 * client.js 静态自检。
 *
 * 之前踩过的坑：client 插件里用了 useEffect/useRef 但只从 React 解构了
 * useState/useCallback —— 运行时 ReferenceError 让整个设置面板渲染成空白，
 * 而打包、语法检查、eslint 全都发现不了（它是运行时才会炸的浏览器端脚本）。
 *
 * 这里把 factory 真正执行一遍，用最小 mock 替换 require，捕获这类错误。
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? new URL('../client.js', import.meta.url).pathname
const source = readFileSync(file, 'utf8')
const packed = process.argv.includes('--packed')

/* ---- 捕获 registration ---- */
let registration = null
globalThis.window = {
  __ModuleLoader__: {
    load(mod) {
      registration = mod
    },
  },
}

/* ---- 最小 mock：任何被 require 的模块都返回一个 Proxy ---- */
const reactMock = {
  useState: () => [undefined, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => {
    try {
      return fn()
    } catch {
      return undefined
    }
  },
  useRef: () => ({ current: undefined }),
  useSyncExternalStore: (_sub, get) => {
    try {
      return get()
    } catch {
      return undefined
    }
  },
  createElement: () => null,
  Fragment: 'Fragment',
  memo: (x) => x,
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  },
  PureComponent: class PureComponent {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  },
}

const requireMock = (name) => {
  if (name === 'react') return reactMock
  if (name === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  /* 其余依赖只被调用而不能被真正执行，用宽容 Proxy 兜住 */
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'then') return undefined
        return () => null
      },
    }
  )
}

/* ---- 静态检查：用到的 React hooks 必须都从 React 解构过 ---- */
const failures = []
{
  const destructure = /const\s*\{([^}]+)\}\s*=\s*React\b/.exec(source)
  const declared = destructure
    ? new Set(destructure[1].split(',').map((x) => x.trim()).filter(Boolean))
    : new Set()
  /* 只看形如 useXxx( 的调用，排除属性访问 ./已定义的方法名 */
  const used = new Set([...source.matchAll(/(?<![.\w])(use[A-Z][A-Za-z0-9]*)\s*\(/g)].map((m) => m[1]))
  for (const hook of used) {
    if (!declared.has(hook)) failures.push(`React hook used but not destructured: ${hook}`)
  }
}
try {
  // eslint-disable-next-line no-new-func
  const run = new Function('require', 'window', 'location', 'fetch', source)
  run(requireMock, globalThis.window, { hostname: '127.0.0.1' }, () => Promise.reject(new Error('no network')))
} catch (error) {
  failures.push(`factory threw: ${error.message}`)
}

if (!registration) failures.push('client.js did not call window.__ModuleLoader__.load')
else {
  if (typeof registration.factory !== 'function') failures.push('registration.factory is not a function')
  else {
    try {
      const exports = registration.factory(requireMock)
      if (typeof exports?.apply !== 'function') failures.push('exports.apply is not a function')
      if (!Array.isArray(exports?.inject)) failures.push('exports.inject is not an array')
      else {
        for (const dep of exports.inject) {
          if (typeof dep !== 'string') failures.push(`inject contains a non-string: ${String(dep)}`)
        }
      }
    } catch (error) {
      failures.push(`factory execution threw: ${error.message}`)
    }
  }
  const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  if (registration.id !== name) failures.push('registration.id must match the package name')
}

/* ---- 字典完整性：用了 t('x') 就必须在 en/zh 里都有定义 ---- */
if (!packed) {
  const dictKeys = (name) => {
    const m = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n\\t\\t\\}`).exec(source)
    if (!m) return null
    return new Set([...m[1].matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((x) => x[1]))
  }
  const en = dictKeys('en')
  const zh = dictKeys('zh')
  if (!en || !zh) failures.push('could not parse en/zh locale dictionaries')
  else {
    /* t('key') 以及 bind(NS)('key') 两种调用都要覆盖 */
    const used = new Set([
      ...[...source.matchAll(/\bt\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/bind\(NS\)\('([A-Za-z0-9_]+)'\)/g)].map((m) => m[1]),
    ])
    for (const key of used) {
      if (!en.has(key)) failures.push(`locale key missing in en: ${key}`)
      if (!zh.has(key)) failures.push(`locale key missing in zh: ${key}`)
    }
    for (const key of en) if (!zh.has(key)) failures.push(`locale key only in en: ${key}`)
    for (const key of zh) if (!en.has(key)) failures.push(`locale key only in zh: ${key}`)
  }
}

/* ---- 静态规则检查（no-undef 等）：漏定义变量是面板白屏的头号原因 ---- */
if (!packed) {
  const { spawnSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')

  let dir = dirname(fileURLToPath(import.meta.url))
  let eslint = null
  for (let i = 0; i < 6 && dir !== '/'; i += 1) {
    const candidate = join(dir, 'node_modules', '.bin', 'eslint')
    if (existsSync(candidate)) {
      eslint = candidate
      break
    }
    dir = dirname(dir)
  }
  if (!eslint) {
    console.warn('warning: eslint not found, skipped no-undef checks')
  } else {
    const result = spawnSync(eslint, [join(dirname(fileURLToPath(import.meta.url)), '..', 'client.js')], {
      encoding: 'utf8',
    })
    const out = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (result.status !== 0) {
      failures.push('eslint failed:\n' + out.trim())
    } else if (/error/i.test(out) && /\d+ error/.test(out)) {
      failures.push('eslint reported errors:\n' + out.trim())
    }
  }
}

if (failures.length) {
  console.error('client.js self-check FAILED:')
  for (const f of failures) console.error('  -', f)
  process.exit(1)
}
console.log(`client.js self-check OK (id=${registration.id})`)
