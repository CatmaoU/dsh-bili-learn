// dsh-bili-learn build:client —— client.js 为手写内置产物（官方 __ModuleLoader__.load
// 契约，无需 esbuild 构建链）。此脚本做契约完整性校验，保证 dev_build_plugin 全链路不失败。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const CLIENT = resolve(ROOT, '.dsh-plugin', 'client.js')

function check() {
  const src = readFileSync(CLIENT, 'utf8')
  const must = [
    "window.__ModuleLoader__.load({",
    "id: 'dsh-bili-learn'",
    "module.exports = { name: 'dsh-bili-learn', inject: ['slots'], apply }",
    "return module.exports",
  ]
  const missing = must.filter((m) => !src.includes(m))
  if (missing.length > 0) {
    console.error('[build-client] client.js 契约不完整，缺少:', missing.join(' | '))
    process.exit(1)
  }
  console.log('[build-client] client.js 契约 OK（手写内置产物，无需构建）')
}

check()