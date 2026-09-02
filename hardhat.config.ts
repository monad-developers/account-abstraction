import '@nomiclabs/hardhat-waffle'
import '@typechain/hardhat'
import { HardhatUserConfig, task } from 'hardhat/config'
import 'hardhat-deploy'

import 'solidity-coverage'

import * as fs from 'fs'

const SALT = '0x84759d6302d4cfbc379cbf5e080a6a0db50ef8782a59586a025bd00aa81aafa2'
process.env.SALT = process.env.SALT ?? SALT

task('deploy', 'Deploy contracts')
  .addFlag('simpleAccountFactory', 'deploy sample factory (by default, enabled only on localhost)')

const mnemonicFileName = process.env.MNEMONIC_FILE!
let mnemonic = 'test '.repeat(11) + 'junk'
if (fs.existsSync(mnemonicFileName)) { mnemonic = fs.readFileSync(mnemonicFileName, 'ascii') }

const accounts = process.env.PRIVATE_KEY != null ? [process.env.PRIVATE_KEY] : { mnemonic }

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

const optimizedCompilerSettings = {
  version: '0.8.28',
  settings: {
    evmVersion: 'cancun',
    optimizer: { enabled: true, runs: 1000000 },
    viaIR: true
  }
}

// You need to export an object to set up your config
// Go to https://hardhat.org/config/ to learn more

const config: HardhatUserConfig = {
  solidity: {
    compilers: [{
      version: '0.8.28',
      settings: {
        evmVersion: 'cancun',
        viaIR: true,
        optimizer: { enabled: true, runs: 1000000 }
      }
    }],
    overrides: {
      'contracts/core/EntryPoint.sol': optimizedCompilerSettings,
      'contracts/core/EntryPointSimulations.sol': optimizedCompilerSettings,
      'contracts/accounts/SimpleAccount.sol': optimizedCompilerSettings
    }
  },
  networks: {
    dev: { url: 'http://localhost:8545' },
    // github action starts localgeth service, for gas calculations
    localgeth: { url: 'http://localgeth:8545' },
    sepolia: getNetwork('sepolia'),
    'monad-testnet': getNetwork1('https://testnet-rpc.monad.xyz'),
    monad: getNetwork1('https://rpc.monad.xyz'),
    proxy: getNetwork1('http://localhost:8545')
  },
  mocha: {
    timeout: 10000
  }
}

// coverage chokes on the "compilers" settings
if (process.env.COVERAGE != null) {
  // @ts-ignore
  config.solidity = config.solidity.compilers[0]
}

export default config
