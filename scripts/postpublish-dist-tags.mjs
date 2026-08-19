import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

const name = process.env.npm_package_name
const version = process.env.npm_package_version

if (!name || !version?.includes('-rc.')) process.exit(0)

const packageSpec = `${name}@${version}`
execFileSync('npm', ['dist-tag', 'add', packageSpec, 'rc'], { stdio: 'inherit' })
execFileSync('npm', ['dist-tag', 'add', packageSpec, 'latest'], { stdio: 'inherit' })

let previousBeta = null
try {
  previousBeta = JSON.parse(fs.readFileSync('.npm-dist-tags.json', 'utf8')).beta
} catch {
  previousBeta = null
}

if (previousBeta && previousBeta !== version) {
  execFileSync('npm', ['dist-tag', 'add', `${name}@${previousBeta}`, 'beta'], { stdio: 'inherit' })
}

fs.rmSync('.npm-dist-tags.json', { force: true })
