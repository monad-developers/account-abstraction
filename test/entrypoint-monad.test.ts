import './aa.init'
import { expect } from 'chai'
import { providers, Wallet } from 'ethers'
import { hexConcat, hexValue, parseEther } from 'ethers/lib/utils'
import {
  EntryPoint,
  EntryPoint__factory,
  IReserveBalance__factory,
  Simple7702Account,
  Simple7702Account__factory,
  TestCounter,
  TestCounter__factory,
  TestNativeReserveProbe__factory,
  TestReservePaymaster__factory
} from '../typechain'
import { fillSignAndPack } from './UserOp'
import { UserOperationEventEvent } from '../typechain/contracts/interfaces/IEntryPoint'
import { RESERVE_BALANCE_PRECOMPILE } from './testutils'

const nativeMonadRpc = process.env.MONAD_TEST_RPC

describe('EntryPoint native Monad reserve checks', function () {
  let provider: providers.JsonRpcProvider
  let entryPoint: EntryPoint
  let account: Simple7702Account
  let owner: Wallet
  let counter: TestCounter
  let recipient: string
  let snapshot: string

  before(function () {
    if (nativeMonadRpc == null) this.skip()
    provider = new providers.JsonRpcProvider(nativeMonadRpc)
  })

  beforeEach(async () => {
    snapshot = await provider.send('evm_snapshot', [])
    const signer = provider.getSigner()
    entryPoint = await new EntryPoint__factory(signer).deploy()
    const delegate = await new Simple7702Account__factory(signer).deploy(entryPoint.address)
    owner = Wallet.createRandom().connect(provider)
    await provider.send('anvil_setCode', [owner.address, hexConcat(['0xef0100', delegate.address])])
    await provider.send('anvil_setBalance', [owner.address, hexValue(parseEther('10'))])
    account = Simple7702Account__factory.connect(owner.address, signer)
    counter = await new TestCounter__factory(signer).deploy()
    recipient = Wallet.createRandom().address
    await entryPoint.depositTo(account.address, { value: parseEther('1') })
  })

  afterEach(async () => {
    await provider.send('evm_revert', [snapshot])
  })

  it('requires the exact selector and CALL at the native precompile', async () => {
    const probe = await new TestNativeReserveProbe__factory(provider.getSigner()).deploy()
    const selector = IReserveBalance__factory.createInterface().getSighash('dippedIntoReserve')
    const clean = await probe.callStatic.query(selector, false)
    expect(clean.success).to.equal(true)
    expect(clean.result).to.equal(hexConcat([new Uint8Array(32)]))
    expect(clean.gasUsed).to.be.lt(1000)

    for (const data of ['0x', selector + '00']) {
      expect((await probe.callStatic.query(data, false)).success).to.equal(false)
    }
    expect((await probe.callStatic.query(selector, true)).success).to.equal(false)
    expect(await IReserveBalance__factory.connect(RESERVE_BALANCE_PRECOMPILE, provider).callStatic.dippedIntoReserve()).to.equal(false)
  })

  for (const postOpDip of [false, true]) {
    it(postOpDip
      ? 'rolls back a native postOp reserve dip and continues the bundle'
      : 'settles a native execution reserve rejection and continues the bundle', async () => {
      const signer = provider.getSigner()
      const implementation = await new TestReservePaymaster__factory(signer)
        .deploy(entryPoint.address, recipient, postOpDip ? 1 : 0, false)
      let paymaster = implementation
      if (postOpDip) {
        const delegatedPaymaster = Wallet.createRandom().address
        await provider.send('anvil_setCode', [delegatedPaymaster, hexConcat(['0xef0100', implementation.address])])
        await provider.send('anvil_setBalance', [delegatedPaymaster, hexValue(parseEther('10'))])
        paymaster = TestReservePaymaster__factory.connect(delegatedPaymaster, signer)
      }
      await entryPoint.depositTo(paymaster.address, { value: parseEther('1') })
      const count = account.interface.encodeFunctionData('execute', [counter.address, 0, counter.interface.encodeFunctionData('count')])
      const operation = {
        sender: account.address,
        nonce: 0,
        callData: postOpDip ? count : account.interface.encodeFunctionData('execute', [recipient, 1, '0x']),
        verificationGasLimit: 1_000_000,
        callGasLimit: 100_000,
        preVerificationGas: 60_000,
        maxFeePerGas: 1,
        maxPriorityFeePerGas: 1
      }
      const ops = [
        await fillSignAndPack({
          ...operation,
          paymaster: paymaster.address,
          paymasterVerificationGasLimit: 100_000,
          paymasterPostOpGasLimit: 150_000
        }, owner, entryPoint),
        await fillSignAndPack({ ...operation, nonce: 1, callData: count }, owner, entryPoint)
      ]
      const beneficiary = Wallet.createRandom().address
      const gasLimit = await entryPoint.estimateGas.handleOps(ops, beneficiary)
      const receipt = await entryPoint.handleOps(ops, beneficiary, { gasLimit }).then(async tx => tx.wait())
      const events = receipt.events?.filter(event => event.event === 'UserOperationEvent') as UserOperationEventEvent[]
      expect(events.map(event => event.args.success)).to.deep.equal([false, true])
      expect(receipt.events?.filter(event => event.event === 'UserOperationReserveBalanceViolated')).to.have.lengthOf(1)
      expect(await counter.counters(account.address)).to.equal(1)
      expect(await account.getNonce()).to.equal(2)
      expect(await provider.getBalance(account.address)).to.equal(parseEther('10'))
      expect(await provider.getBalance(recipient)).to.equal(0)
      expect(await paymaster.postOpCalls()).to.equal(postOpDip ? 0 : 1)
      expect(await paymaster.lastMode()).to.equal(postOpDip ? 0 : 1)
      if (postOpDip) expect(await provider.getBalance(paymaster.address)).to.equal(parseEther('10'))
      expect(await entryPoint.balanceOf(paymaster.address)).to.equal(parseEther('1').sub(events[0].args.actualGasCost))
      expect(await provider.getBalance(beneficiary)).to.equal(events[0].args.actualGasCost.add(events[1].args.actualGasCost))
      expect(await IReserveBalance__factory.connect(RESERVE_BALANCE_PRECOMPILE, provider).callStatic.dippedIntoReserve()).to.equal(false)
    })
  }
})
