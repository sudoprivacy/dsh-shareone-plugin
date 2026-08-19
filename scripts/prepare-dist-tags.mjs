import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const name = process.env.npm_package_name
const version = process.env.npm_package_version

if (!name || !version?.includes('-rc.')) process.exit(0)

let beta = null
try {
  beta = JSON.parse(execFileSync('npm', ['view', name, 'dist-tags.beta', '--json'], { encoding: 'utf8' }))
} catch {
  beta = null
}

fs.writeFileSync('.npm-dist-tags.json', JSON.stringify({ beta }, null, 2))
