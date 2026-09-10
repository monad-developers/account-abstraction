import { Create2Factory } from '../src/Create2Factory'
import { ethers } from 'hardhat'
import { expect } from 'chai'
import { TestToken__factory } from '../typechain'
import { Provider } from '@ethersproject/providers'

describe('test Create2Factory', () => {
  let factory: Create2Factory
  let provider: Provider

  if (process.env.COVERAGE != null) {
    return
  }

  before(async () => {
    provider = ethers.provider
    factory = new Create2Factory(provider)
  })
  it('should wait for funding to be mined before deploying the factory', async () => {
    expect(await factory._isFactoryDeployed()).to.equal(false, 'factory exists before test deploy')
    const signer = ethers.provider.getSigner()
    const sender = await signer.getAddress()
    const nonce = await provider.getTransactionCount(sender)
    await ethers.provider.send('evm_setAutomine', [false])
    const deployment = factory.deployFactory(signer).then(() => undefined, error => error)
    try {
      while (await provider.getTransactionCount(sender, 'pending') === nonce) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(await provider.getBalance(Create2Factory.factoryDeployer)).to.equal(0)
      expect(await provider.getTransactionCount(Create2Factory.factoryDeployer, 'pending')).to.equal(0)
    } finally {
      await ethers.provider.send('evm_mine', [])
      await ethers.provider.send('evm_setAutomine', [true])
    }
    expect(await deployment).to.equal(undefined)
    expect(await factory._isFactoryDeployed()).to.equal(true, 'factory failed to deploy')
  })

  it('should deploy to known address', async () => {
    const initCode = TestToken__factory.bytecode

    const addr = Create2Factory.getDeployedAddress(initCode, 0)

    expect(await provider.getCode(addr).then(code => code.length)).to.equal(2)
    await factory.deploy(initCode, 0)
    expect(await provider.getCode(addr).then(code => code.length)).to.gt(100)
  })
  it('should deploy to different address based on salt', async () => {
    const initCode = TestToken__factory.bytecode

    const addr = Create2Factory.getDeployedAddress(initCode, 123)

    expect(await provider.getCode(addr).then(code => code.length)).to.equal(2)
    await factory.deploy(initCode, 123)
    expect(await provider.getCode(addr).then(code => code.length)).to.gt(100)
  })
})
