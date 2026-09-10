// Verify hardhat-deploy'd contracts on Monad. There is no hardhat verify plugin here:
// @nomicfoundation/hardhat-verify 2.1.x (the first with Etherscan V2, which is the only
// API Monad exposes) wants hardhat ^2.26 and this repo is pinned to 2.22.
// Submitting the stored solcInput also avoids any recompile drift against what was deployed.
//
//   npx ts-node scripts/verify-monad.ts <etherscan|sourcify|both> [network] [contract...]
//
// etherscan targets MonadScan and needs ETHERSCAN_API_KEY. sourcify targets Monad Explorer
// and needs no key.

import * as fs from 'fs'
import * as path from 'path'

const SOURCIFY = 'https://sourcify-api-monad.blockvision.org'
const ETHERSCAN = 'https://api.etherscan.io/v2/api'

const target = process.argv[2]
if (!['etherscan', 'sourcify', 'both'].includes(target)) {
  throw new Error('usage: verify-monad.ts <etherscan|sourcify|both> [network] [contract...]')
}
const network = process.argv[3] ?? 'monad-testnet'
const dir = path.join(__dirname, '..', 'deployments', network)
const chainId = fs.readFileSync(path.join(dir, '.chainId'), 'utf8').trim()

function readJson (...p: string[]): any {
  return JSON.parse(fs.readFileSync(path.join(...p), 'utf8'))
}

async function sourcify (address: string, stdJsonInput: any, compilerVersion: string, contractIdentifier: string): Promise<void> {
  const res = await fetch(`${SOURCIFY}/v2/verify/${chainId}/${address}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stdJsonInput, compilerVersion, contractIdentifier })
  })
  const body = await res.json() as any
  if (body.verificationId == null) {
    console.log('  sourcify:', body)
    return
  }
  // the job is async; poll until it leaves the queue
  for (let i = 0; i < 60; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    const job = await fetch(`${SOURCIFY}/v2/verify/${String(body.verificationId)}`).then(async r => await r.json()) as any
    if (job.isJobCompleted === true) {
      console.log('  sourcify:', job.error ?? job.contract?.match ?? job)
      return
    }
  }
  console.log(`  sourcify: still running, check ${SOURCIFY}/v2/verify/${String(body.verificationId)}`)
}

async function etherscan (address: string, stdJsonInput: any, compilerVersion: string, contractIdentifier: string): Promise<void> {
  const apiKey = process.env.ETHERSCAN_API_KEY
  if (apiKey == null) {
    throw new Error('ETHERSCAN_API_KEY is not set')
  }
  const res = await fetch(`${ETHERSCAN}?chainid=${chainId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      apikey: apiKey,
      module: 'contract',
      action: 'verifysourcecode',
      codeformat: 'solidity-standard-json-input',
      contractaddress: address,
      contractname: contractIdentifier,
      compilerversion: `v${compilerVersion}`,
      sourceCode: JSON.stringify(stdJsonInput)
    })
  })
  console.log('  monadscan:', await res.json())
}

async function main (): Promise<void> {
  const names = process.argv.slice(4)
  const all = names.length > 0
    ? names
    : fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))

  for (const name of all) {
    const deployment = readJson(dir, `${name}.json`)
    const metadata = JSON.parse(deployment.metadata)
    const [source, contract] = Object.entries(metadata.settings.compilationTarget)[0]
    const identifier = `${source}:${String(contract)}`
    const stdJsonInput = readJson(dir, 'solcInputs', `${deployment.solcInputHash as string}.json`)

    console.log(`${name} ${deployment.address as string} (${identifier})`)
    if (target !== 'etherscan') {
      await sourcify(deployment.address, stdJsonInput, metadata.compiler.version, identifier)
    }
    if (target !== 'sourcify') {
      await etherscan(deployment.address, stdJsonInput, metadata.compiler.version, identifier)
    }
  }
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
