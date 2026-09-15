import '@nomiclabs/hardhat-waffle'
import '@typechain/hardhat'
import { HardhatUserConfig, task } from 'hardhat/config'
import 'hardhat-deploy'
import '@nomiclabs/hardhat-etherscan'

import 'solidity-coverage'

import * as fs from 'fs'

const SALT = '0x90d8084deab30c2a37c45e8d47f49f2f7965183cb6990a98943ef94940681de3'
process.env.SALT = process.env.SALT ?? SALT

task('deploy', 'Deploy contracts')
  .addFlag('simpleAccountFactory', 'deploy sample factory (by default, enabled only on localhost)')

const mnemonicFileName = process.env.MNEMONIC_FILE
const explicitAccounts = process.env.PRIVATE_KEY != null
  ? [process.env.PRIVATE_KEY]
  : mnemonicFileName != null && fs.existsSync(mnemonicFileName)
    ? { mnemonic: fs.readFileSync(mnemonicFileName, 'ascii').trim() }
    : undefined
const accounts = explicitAccounts ?? { mnemonic: 'test '.repeat(11) + 'junk' }

function getNetwork1 (url: string): { url: string, accounts: string[] | { mnemonic: string } } {
  return {
    url,
    accounts
  }
}

function getNetwork (name: string): { url: string, accounts: string[] | { mnemonic: string } } {
  return getNetwork1(`https://${name}.infura.io/v3/${process.env.INFURA_ID}`)
  // return getNetwork1(`wss://${name}.infura.io/ws/v3/${process.env.INFURA_ID}`)
}

const optimizedComilerSettings = {
  version: '0.8.23',
  settings: {
    optimizer: { enabled: true, runs: 1000000 },
    viaIR: true
  }
}

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{
      version: '0.8.23',
      settings: {
        optimizer: { enabled: true, runs: 1000000 }
      }
    }],
    overrides: {
      'contracts/core/EntryPoint.sol': optimizedComilerSettings,
      'contracts/samples/SimpleAccount.sol': optimizedComilerSettings
    }
  },
  networks: {
    dev: { url: 'http://localhost:8545' },
    // Docker Compose starts localgeth for gas calculations.
    localgeth: { url: 'http://localgeth:8545' },
    goerli: getNetwork('goerli'),
    sepolia: getNetwork('sepolia'),
    'monad-testnet': getNetwork1('https://testnet-rpc.monad.xyz'),
    monad: { url: 'https://rpc.monad.xyz', accounts: explicitAccounts ?? [] },
    proxy: getNetwork1('http://localhost:8545')
  },
  mocha: {
    timeout: 10000
  },
  // @ts-ignore
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY
  }

}

// coverage chokes on the "compilers" settings
if (process.env.COVERAGE != null) {
  // @ts-ignore
  config.solidity = config.solidity.compilers[0]
}

export default config
