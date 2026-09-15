import './aa.init'
import { BigNumber, BigNumberish, Event, Wallet } from 'ethers'
import { expect } from 'chai'
import {
  SimpleAccount,
  SimpleAccountFactory,
  TestAggregatedAccount__factory,
  TestAggregatedAccountFactory__factory,
  TestCounter,
  TestCounter__factory,
  TestExpirePaymaster,
  TestExpirePaymaster__factory,
  TestExpiryAccount,
  TestExpiryAccount__factory,
  TestPaymasterAcceptAll,
  TestPaymasterAcceptAll__factory,
  TestRevertAccount__factory,
  TestReserveAggregator__factory,
  TestReserveBalance__factory,
  TestReservePaymaster__factory,
  TestAggregatedAccount,
  TestSignatureAggregator,
  TestSignatureAggregator__factory,
  MaliciousAccount__factory,
  TestWarmColdAccount__factory,
  TestPaymasterRevertCustomError__factory,
  IEntryPoint__factory,
  SimpleAccountFactory__factory,
  IStakeManager__factory,
  INonceManager__factory,
  EntryPoint,
  TestPaymasterWithPostOp__factory,
  TestPaymasterWithPostOp
} from '../typechain'
import {
  AddressZero,
  createAccountOwner,
  fund,
  checkForGeth,
  rethrow,
  tostr,
  getAccountInitCode,
  calcGasUsage,
  ONE_ETH,
  TWO_ETH,
  deployEntryPoint,
  getBalance,
  createAddress,
  getAccountAddress,
  HashZero,
  createAccount,
  getAggregatedAccountInitCode,
  decodeRevertReason, parseValidationData, findUserOpWithMin,
  RESERVE_BALANCE_PRECOMPILE, setDippedIntoReserve, unpackAccountGasLimits
} from './testutils'
import { DefaultsForUserOp, fillAndSign, fillSignAndPack, getUserOpHash, packUserOp, simulateValidation } from './UserOp'
import { PackedUserOperation, UserOperation } from './UserOperation'
import { PopulatedTransaction } from 'ethers/lib/ethers'
import { ethers } from 'hardhat'
import { arrayify, defaultAbiCoder, hexZeroPad, parseEther } from 'ethers/lib/utils'
import { debugTransaction } from './debugTx'
import { BytesLike } from '@ethersproject/bytes'
import { toChecksumAddress } from 'ethereumjs-util'
import { getERC165InterfaceID } from '../src/Utils'
import { UserOperationEventEvent } from '../typechain/contracts/interfaces/IEntryPoint'

describe('EntryPoint', function () {
  let entryPoint: EntryPoint
  let simpleAccountFactory: SimpleAccountFactory

  let accountOwner: Wallet
  const ethersSigner = ethers.provider.getSigner()
  let account: SimpleAccount

  const globalUnstakeDelaySec = 2
  const paymasterStake = ethers.utils.parseEther('2')

  before(async function () {
    this.timeout(20000)
    await checkForGeth()

    const chainId = await ethers.provider.getNetwork().then(net => net.chainId)

    await setDippedIntoReserve(false)
    entryPoint = await deployEntryPoint()

    accountOwner = createAccountOwner();
    ({
      proxy: account,
      accountFactory: simpleAccountFactory
    } = await createAccount(ethersSigner, await accountOwner.getAddress(), entryPoint.address))
    await fund(account)

    // sanity: validate helper functions
    const sampleOp = await fillAndSign({ sender: account.address }, accountOwner, entryPoint)
    const packedOp = packUserOp(sampleOp)
    expect(getUserOpHash(sampleOp, entryPoint.address, chainId)).to.eql(await entryPoint.getUserOpHash(packedOp))
  })

  describe('Stake Management', () => {
    let addr: string
    before(async () => {
      addr = await ethersSigner.getAddress()
    })

    it('should deposit for transfer into EntryPoint', async () => {
      const signer2 = ethers.provider.getSigner(2)
      await signer2.sendTransaction({ to: entryPoint.address, value: ONE_ETH })
      expect(await entryPoint.balanceOf(await signer2.getAddress())).to.eql(ONE_ETH)
      expect(await entryPoint.getDepositInfo(await signer2.getAddress())).to.eql({
        deposit: ONE_ETH,
        staked: false,
        stake: 0,
        unstakeDelaySec: 0,
        withdrawTime: 0
      })
    })

    describe('without stake', () => {
      it('should fail to stake without value', async () => {
        await expect(entryPoint.addStake(2)).to.revertedWith('no stake specified')
      })
      it('should fail to stake without delay', async () => {
        await expect(entryPoint.callStatic.addStake(0, { value: ONE_ETH })).to.revertedWith('must specify unstake delay')
      })
      it('should fail to unlock', async () => {
        await expect(entryPoint.callStatic.unlockStake()).to.revertedWith('not staked')
      })
    })
    describe('with stake of 2 eth', () => {
      before(async () => {
        await entryPoint.addStake(2, { value: TWO_ETH })
      })
      it('should report "staked" state', async () => {
        const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
        expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
          stake: parseEther('2'),
          staked: true,
          unstakeDelaySec: 2,
          withdrawTime: 0
        })
      })

      it('should succeed to stake again', async () => {
        const { stake } = await entryPoint.getDepositInfo(addr)
        await entryPoint.addStake(2, { value: ONE_ETH })
        const { stake: stakeAfter } = await entryPoint.getDepositInfo(addr)
        expect(stakeAfter).to.eq(stake.add(ONE_ETH))
      })
      it('should fail to withdraw before unlock', async () => {
        await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith('must call unlockStake() first')
      })
      describe('with unlocked stake', () => {
        before(async () => {
          await entryPoint.unlockStake()
        })
        it('should report as "not staked"', async () => {
          expect(await entryPoint.getDepositInfo(addr).then(info => info.staked)).to.eq(false)
        })
        it('should report unstake state', async () => {
          const withdrawTime1 = await ethers.provider.getBlock('latest').then(block => block.timestamp) + globalUnstakeDelaySec
          const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
          expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
            stake: parseEther('3'),
            staked: false,
            unstakeDelaySec: 2,
            withdrawTime: withdrawTime1
          })
        })
        it('should fail to withdraw before unlock timeout', async () => {
          await expect(entryPoint.withdrawStake(AddressZero)).to.revertedWith('Stake withdrawal is not due')
        })
        it('should fail to unlock again', async () => {
          await expect(entryPoint.callStatic.unlockStake()).to.revertedWith('already unstaking')
        })
        describe('after unstake delay', () => {
          before(async () => {
            // dummy transaction and increase time by 2 seconds
            await ethers.provider.send('evm_increaseTime', [2])
            await ethersSigner.sendTransaction({ to: addr })
          })
          it('adding stake should reset "unlockStake"', async () => {
            let snap
            try {
              snap = await ethers.provider.send('evm_snapshot', [])

              await ethersSigner.sendTransaction({ to: addr })
              await entryPoint.addStake(2, { value: ONE_ETH })
              const { stake, staked, unstakeDelaySec, withdrawTime } = await entryPoint.getDepositInfo(addr)
              expect({ stake, staked, unstakeDelaySec, withdrawTime }).to.eql({
                stake: parseEther('4'),
                staked: true,
                unstakeDelaySec: 2,
                withdrawTime: 0
              })
            } finally {
              await ethers.provider.send('evm_revert', [snap])
            }
          })

          it('should fail to unlock again', async () => {
            await expect(entryPoint.callStatic.unlockStake()).to.revertedWith('already unstaking')
          })
          it('should succeed to withdraw', async () => {
            const { stake } = await entryPoint.getDepositInfo(addr)
            const addr1 = createAddress()
            await entryPoint.withdrawStake(addr1)
            expect(await ethers.provider.getBalance(addr1)).to.eq(stake)
            const { stake: stakeAfter, withdrawTime, unstakeDelaySec } = await entryPoint.getDepositInfo(addr)

            expect({ stakeAfter, withdrawTime, unstakeDelaySec }).to.eql({
              stakeAfter: BigNumber.from(0),
              unstakeDelaySec: 0,
              withdrawTime: 0
            })
          })
        })
      })
    })
    describe('with deposit', () => {
      let account: SimpleAccount
      before(async () => {
        ({ proxy: account } = await createAccount(ethersSigner, await ethersSigner.getAddress(), entryPoint.address, simpleAccountFactory))
        await account.addDeposit({ value: ONE_ETH })
        expect(await getBalance(account.address)).to.equal(0)
        expect(await account.getDeposit()).to.eql(ONE_ETH)
      })
      it('should be able to withdraw', async () => {
        const depositBefore = await account.getDeposit()
        await account.withdrawDepositTo(account.address, ONE_ETH)
        expect(await getBalance(account.address)).to.equal(1e18)
        expect(await account.getDeposit()).to.equal(depositBefore.sub(ONE_ETH))
      })
    })
  })
  describe('#simulateValidation', () => {
    const accountOwner1 = createAccountOwner()

    // note: for the actual opcode and storage rule restrictions see the reference bundler ValidationManager
    it('should not use banned ops during simulateValidation', async () => {
      const op1 = await fillSignAndPack({
        initCode: getAccountInitCode(accountOwner1.address, simpleAccountFactory),
        sender: await getAccountAddress(accountOwner1.address, simpleAccountFactory)
      }, accountOwner1, entryPoint)
      await fund(op1.sender)
      await simulateValidation(op1, entryPoint.address, { gasLimit: 10e6 })
      // TODO: can't do opcode banning with EntryPointSimulations (since its not on-chain) add when we can debug_traceCall
      // const block = await ethers.provider.getBlock('latest')
      // const hash = block.transactions[0]
      // await checkForBannedOps(hash, false)
    })
  })

  describe('flickering account validation', () => {
    it('should prevent leakage of basefee', async function () {
      if (process.env.COVERAGE != null) {
        // coverage disables block.baseFee, which breaks this test...
        // it also doesn't add to EntryPoint's coverage
        this.skip()
      }

      const maliciousAccount = await new MaliciousAccount__factory(ethersSigner).deploy(entryPoint.address,
        { value: parseEther('1') })

      const snap = await ethers.provider.send('evm_snapshot', [])
      await ethers.provider.send('evm_mine', [])
      const block = await ethers.provider.getBlock('latest')
      await ethers.provider.send('evm_revert', [snap])

      if (block.baseFeePerGas == null) {
        expect.fail(null, null, 'test error: no basefee')
      }

      const userOp: UserOperation = {
        sender: maliciousAccount.address,
        nonce: await entryPoint.getNonce(maliciousAccount.address, 0),
        signature: defaultAbiCoder.encode(['uint256'], [block.baseFeePerGas]),
        initCode: '0x',
        callData: '0x',
        callGasLimit: '0x' + 1e5.toString(16),
        verificationGasLimit: '0x' + 1e5.toString(16),
        preVerificationGas: '0x' + 1e5.toString(16),
        // we need maxFeeperGas > block.basefee + maxPriorityFeePerGas so requiredPrefund onchain is basefee + maxPriorityFeePerGas
        maxFeePerGas: block.baseFeePerGas.mul(3),
        maxPriorityFeePerGas: block.baseFeePerGas,
        paymaster: AddressZero,
        paymasterData: '0x',
        paymasterVerificationGasLimit: 0,
        paymasterPostOpGasLimit: 0
      }
      const userOpPacked = packUserOp(userOp)
      try {
        await simulateValidation(userOpPacked, entryPoint.address, { gasLimit: 1e6 })

        console.log('after first simulation')
        await ethers.provider.send('evm_mine', [])
        await expect(simulateValidation(userOpPacked, entryPoint.address, { gasLimit: 1e6 }))
          .to.revertedWith('Revert after first validation')
        // if we get here, it means the userOp passed first sim and reverted second
        expect.fail(null, null, 'should fail on first simulation')
      } catch (e: any) {
        expect(decodeRevertReason(e)).to.include('Revert after first validation')
      }
    })

    it('should limit revert reason length before emitting it', async () => {
      const revertLength = 1e5
      const REVERT_REASON_MAX_LEN = 2048
      const testRevertAccount = await new TestRevertAccount__factory(ethersSigner).deploy(entryPoint.address, { value: parseEther('1') })
      const badData = await testRevertAccount.populateTransaction.revertLong(revertLength + 1)
      const badOp: UserOperation = {
        ...DefaultsForUserOp,
        sender: testRevertAccount.address,
        callGasLimit: 1e5,
        maxFeePerGas: 1,
        nonce: await entryPoint.getNonce(testRevertAccount.address, 0),
        verificationGasLimit: 1e5,
        callData: badData.data!
      }
      const beneficiaryAddress = createAddress()
      const badOpPacked = packUserOp(badOp)
      await simulateValidation(badOpPacked, entryPoint.address, { gasLimit: 3e5 })

      const tx = await entryPoint.handleOps([badOpPacked], beneficiaryAddress) // { gasLimit: 3e5 })
      const receipt = await tx.wait()
      const userOperationRevertReasonEvent = receipt.events?.find(event => event.event === 'UserOperationRevertReason')
      expect(userOperationRevertReasonEvent?.event).to.equal('UserOperationRevertReason')
      const revertReason = Buffer.from(arrayify(userOperationRevertReasonEvent?.args?.revertReason))
      expect(revertReason.length).to.equal(REVERT_REASON_MAX_LEN)
    })
    describe('warm/cold storage detection in simulation vs execution', () => {
      const TOUCH_GET_AGGREGATOR = 1
      const TOUCH_PAYMASTER = 2
      it('should prevent detection through getAggregator()', async () => {
        const testWarmColdAccount = await new TestWarmColdAccount__factory(ethersSigner).deploy(entryPoint.address,
          { value: parseEther('1') })
        const badOp: UserOperation = {
          ...DefaultsForUserOp,
          nonce: TOUCH_GET_AGGREGATOR,
          sender: testWarmColdAccount.address
        }
        const badOpPacked = packUserOp(badOp)
        const beneficiaryAddress = createAddress()
        try {
          await simulateValidation(badOpPacked, entryPoint.address, { gasLimit: 1e6 })
          throw new Error('should revert')
        } catch (e: any) {
          if ((e as Error).message.includes('ValidationResult')) {
            const tx = await entryPoint.handleOps([badOpPacked], beneficiaryAddress, { gasLimit: 1e6 })
            await tx.wait()
          } else {
            expect(decodeRevertReason(e)).to.include('AA23 reverted')
          }
        }
      })

      it('should prevent detection through paymaster.code.length', async () => {
        const testWarmColdAccount = await new TestWarmColdAccount__factory(ethersSigner).deploy(entryPoint.address,
          { value: parseEther('1') })
        const paymaster = await new TestPaymasterAcceptAll__factory(ethersSigner).deploy(entryPoint.address)
        await paymaster.deposit({ value: ONE_ETH })
        const badOp: UserOperation = {
          ...DefaultsForUserOp,
          nonce: TOUCH_PAYMASTER,
          paymaster: paymaster.address,
          paymasterVerificationGasLimit: 150000,
          sender: testWarmColdAccount.address
        }
        const beneficiaryAddress = createAddress()
        const badOpPacked = packUserOp(badOp)
        try {
          await simulateValidation(badOpPacked, entryPoint.address, { gasLimit: 1e6 })
          throw new Error('should revert')
        } catch (e: any) {
          if ((e as Error).message.includes('ValidationResult')) {
            const tx = await entryPoint.handleOps([badOpPacked], beneficiaryAddress, { gasLimit: 1e6 })
            await tx.wait()
          } else {
            expect(decodeRevertReason(e)).to.include('AA23 reverted')
          }
        }
      })
    })
  })

  describe('2d nonces', () => {
    const beneficiaryAddress = createAddress()
    let sender: string
    const key = 1
    const keyShifted = BigNumber.from(key).shl(64)

    before(async () => {
      const { proxy } = await createAccount(ethersSigner, accountOwner.address, entryPoint.address)
      sender = proxy.address
      await fund(sender)
    })

    it('should fail nonce with new key and seq!=0', async () => {
      const op = await fillSignAndPack({
        sender,
        nonce: keyShifted.add(1)
      }, accountOwner, entryPoint)
      await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress)).to.revertedWith('AA25 invalid account nonce')
    })

    describe('with key=1, seq=1', () => {
      before(async () => {
        const op = await fillSignAndPack({
          sender,
          nonce: keyShifted
        }, accountOwner, entryPoint)
        await entryPoint.handleOps([op], beneficiaryAddress)
      })

      it('should get next nonce value by getNonce', async () => {
        expect(await entryPoint.getNonce(sender, key)).to.eql(keyShifted.add(1))
      })

      it('should allow to increment nonce of different key', async () => {
        const op = await fillSignAndPack({
          sender,
          nonce: await entryPoint.getNonce(sender, key)
        }, accountOwner, entryPoint)
        await entryPoint.callStatic.handleOps([op], beneficiaryAddress)
      })

      it('should allow manual nonce increment', async () => {
        // must be called from account itself
        const incNonceKey = 5
        const incrementCallData = entryPoint.interface.encodeFunctionData('incrementNonce', [incNonceKey])
        const callData = account.interface.encodeFunctionData('execute', [entryPoint.address, 0, incrementCallData])
        const op = await fillSignAndPack({
          sender,
          callData,
          nonce: await entryPoint.getNonce(sender, key)
        }, accountOwner, entryPoint)
        await entryPoint.handleOps([op], beneficiaryAddress)

        expect(await entryPoint.getNonce(sender, incNonceKey)).to.equal(BigNumber.from(incNonceKey).shl(64).add(1))
      })
      it('should fail with nonsequential seq', async () => {
        const op = await fillSignAndPack({
          sender,
          nonce: keyShifted.add(3)
        }, accountOwner, entryPoint)
        await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress)).to.revertedWith('AA25 invalid account nonce')
      })
    })
  })

  describe('without paymaster (account pays in eth)', () => {
    describe('#handleOps', () => {
      let counter: TestCounter
      let accountExecFromEntryPoint: PopulatedTransaction

      before(async () => {
        counter = await new TestCounter__factory(ethersSigner).deploy()
        const count = await counter.populateTransaction.count()
        accountExecFromEntryPoint = await account.populateTransaction.execute(counter.address, 0, count.data!)
      })

      it('should revert on signature failure', async () => {
        // wallet-reported signature failure should revert in handleOps
        const wrongOwner = createAccountOwner()
        const op = await fillSignAndPack({
          sender: account.address
        }, wrongOwner, entryPoint)
        const beneficiaryAddress = createAddress()
        await expect(entryPoint.estimateGas.handleOps([op], beneficiaryAddress)).to.revertedWith('AA24 signature error')
      })

      describe('reserve balance precompile', () => {
        let snap: string
        let reserveRecipient: string

        beforeEach(async () => {
          snap = await ethers.provider.send('evm_snapshot', [])
          reserveRecipient = createAddress()
          await installReserveMock(reserveRecipient)
        })

        afterEach(async () => {
          await ethers.provider.send('evm_revert', [snap])
        })

        async function installReserveMock (monitored: string, minimumBalance: BigNumberish = 0): Promise<void> {
          const mock = await new TestReserveBalance__factory(ethersSigner).deploy(monitored, minimumBalance)
          await ethers.provider.send('hardhat_setCode', [RESERVE_BALANCE_PRECOMPILE, await ethers.provider.getCode(mock.address)])
        }

        async function countOp (overrides: Partial<UserOperation> = {}): Promise<PackedUserOperation> {
          return await fillSignAndPack({
            sender: account.address,
            callData: accountExecFromEntryPoint.data,
            verificationGasLimit: 1e6,
            callGasLimit: 1e6,
            maxFeePerGas: 1,
            maxPriorityFeePerGas: 1,
            ...overrides
          }, accountOwner, entryPoint)
        }

        async function dipCallData (): Promise<string> {
          return account.interface.encodeFunctionData('executeBatch', [
            [counter.address, reserveRecipient],
            [0, 1],
            [counter.interface.encodeFunctionData('count'), '0x']
          ])
        }

        function requiredPrefund (op: PackedUserOperation): BigNumber {
          const { verificationGasLimit, callGasLimit } = unpackAccountGasLimits(op.accountGasLimits as string)
          const maxFeePerGas = BigNumber.from(op.gasFees).mask(128)
          return BigNumber.from(verificationGasLimit).add(callGasLimit).add(op.preVerificationGas).mul(maxFeePerGas)
        }

        it('should reject external calls to reserve recovery settlement', async () => {
          const sender = await ethersSigner.getAddress()
          const depositBefore = await entryPoint.balanceOf(sender)
          const opInfo = {
            mUserOp: {
              sender,
              nonce: 0,
              verificationGasLimit: 0,
              callGasLimit: 0,
              paymasterVerificationGasLimit: 0,
              paymasterPostOpGasLimit: 0,
              preVerificationGas: 0,
              paymaster: AddressZero,
              maxFeePerGas: 0,
              maxPriorityFeePerGas: 0
            },
            userOpHash: HashZero,
            prefund: ONE_ETH,
            contextOffset: 0,
            preOpGas: 0
          }
          await expect(entryPoint.innerPostOpAfterReserveRollback(opInfo, '0x', 0)).to.be.revertedWith('AA92 internal call only')
          expect(await entryPoint.balanceOf(sender)).to.equal(depositBefore)
        })

        it('should execute the userOp when the reserve was not dipped into', async () => {
          const op = await countOp()
          const countBefore = await counter.counters(account.address)
          const rcpt = await entryPoint.handleOps([op], createAddress(), { gasLimit: 1e7 }).then(async t => await t.wait())
          const userOpEvent = rcpt.events?.find(e => e.event === 'UserOperationEvent') as UserOperationEventEvent

          expect(userOpEvent.args.success).to.equal(true)
          expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
        })

        it('should accept only the native reserve selector and input length', async () => {
          const data = TestReserveBalance__factory.createInterface().encodeFunctionData('dippedIntoReserve')
          for (const dipped of [false, true]) {
            await setDippedIntoReserve(dipped)
            expect(await ethers.provider.call({ to: RESERVE_BALANCE_PRECOMPILE, data }))
              .to.equal(defaultAbiCoder.encode(['bool'], [dipped]))
            for (const invalid of ['0x', '0x12345678', data + '00', data.slice(0, -2)]) {
              await expect(ethersSigner.sendTransaction({ to: RESERVE_BALANCE_PRECOMPILE, data: invalid })).to.be.reverted
            }
          }
        })

        for (const route of ['ordinary', 'aggregated', 'simulation']) {
          it(`should reject a pre-existing reserve violation before ${route} validation`, async () => {
            const op = await countOp()
            await entryPoint.depositTo(account.address, { value: ONE_ETH })
            const depositBefore = await entryPoint.balanceOf(account.address)
            const nonceBefore = await entryPoint.getNonce(account.address, 0)
            const countBefore = await counter.counters(account.address)
            await ethersSigner.sendTransaction({ to: reserveRecipient, value: 1 })
            const call = route === 'simulation'
              ? simulateValidation(op, entryPoint.address, { gasLimit: 1e7 })
              : route === 'aggregated'
                ? entryPoint.handleAggregatedOps([{ userOps: [op], aggregator: AddressZero, signature: '0x' }], createAddress())
                : entryPoint.handleOps([op], createAddress())

            await expect(call).to.be.revertedWith('InitialReserveBalanceViolated')
            expect(await entryPoint.balanceOf(account.address)).to.equal(depositBefore)
            expect(await entryPoint.getNonce(account.address, 0)).to.equal(nonceBefore)
            expect(await counter.counters(account.address)).to.equal(countBefore)
            expect(await getBalance(reserveRecipient)).to.equal(1)
          })
        }

        it('should roll back execution and settle at the effective gas price after a reserve dip', async () => {
          await entryPoint.depositTo(account.address, { value: ONE_ETH })
          const op = await countOp({ callData: await dipCallData(), maxFeePerGas: 1000 })
          const beneficiary = createAddress()
          const depositBefore = await entryPoint.balanceOf(account.address)
          const balanceBefore = await ethers.provider.getBalance(account.address)
          const nonceBefore = await entryPoint.getNonce(account.address, 0)
          const countBefore = await counter.counters(account.address)
          await ethers.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0'])
          const rcpt = await entryPoint.handleOps([op], beneficiary, { gasLimit: 1e7 }).then(async t => await t.wait())
          const violated = rcpt.events?.filter(e => e.event === 'UserOperationReserveBalanceViolated') ?? []
          const userOpEvent = rcpt.events?.find(e => e.event === 'UserOperationEvent') as UserOperationEventEvent

          expect(violated.length).to.equal(1)
          expect(violated[0].args?.userOpHash).to.equal(userOpEvent.args.userOpHash)
          expect(violated[0].args?.sender).to.equal(account.address)
          expect(violated[0].args?.nonce).to.equal(nonceBefore)
          expect(userOpEvent.args.success).to.equal(false)
          expect(userOpEvent.args.actualGasCost).to.equal(userOpEvent.args.actualGasUsed)
          expect(userOpEvent.args.actualGasCost).to.be.lt(requiredPrefund(op))
          expect(await ethers.provider.getBalance(beneficiary)).to.equal(userOpEvent.args.actualGasCost)
          expect(depositBefore.sub(await entryPoint.balanceOf(account.address))).to.equal(userOpEvent.args.actualGasCost)
          expect(await ethers.provider.getBalance(account.address)).to.equal(balanceBefore)
          expect(await getBalance(reserveRecipient)).to.equal(0)
          expect(await counter.counters(account.address)).to.equal(countBefore)
          expect(await entryPoint.getNonce(account.address, 0)).to.equal(nonceBefore.add(1))
        })

        it('should revert only the offending userOp, and let the rest of the bundle through', async () => {
          const beneficiaryAddress = createAddress()
          const owner2 = createAccountOwner()
          const { proxy: account2 } = await createAccount(ethersSigner, owner2.address, entryPoint.address, simpleAccountFactory)
          await fund(account2)
          const countBefore = await counter.counters(account.address)
          const count = await counter.populateTransaction.count()
          const op1 = await countOp({ callData: await dipCallData() })
          const op2 = await fillSignAndPack({
            sender: account2.address,
            callData: (await account2.populateTransaction.execute(counter.address, 0, count.data!)).data,
            verificationGasLimit: 1e6,
            callGasLimit: 1e6,
            maxFeePerGas: 1,
            maxPriorityFeePerGas: 1
          }, owner2, entryPoint)

          const rcpt = await entryPoint.handleOps([op1, op2], beneficiaryAddress, { gasLimit: 2e7 }).then(async t => await t.wait())
          const violated = rcpt.events?.filter(e => e.event === 'UserOperationReserveBalanceViolated') ?? []
          const userOpEvents = rcpt.events?.filter(e => e.event === 'UserOperationEvent') ?? []

          expect(violated.map(e => e.args?.sender)).to.eql([account.address])
          expect(userOpEvents.map(e => e.args?.success)).to.eql([false, true])
          expect(await getBalance(reserveRecipient)).to.equal(0)
          expect(await counter.counters(account.address)).to.equal(countBefore)
          expect(await counter.counters(account2.address)).to.equal(1)
        })

        it('should settle the paymaster once in opReverted mode after rolling back an account reserve dip', async () => {
          const paymaster = await new TestReservePaymaster__factory(ethersSigner).deploy(entryPoint.address, reserveRecipient, 0, false)
          await entryPoint.depositTo(paymaster.address, { value: ONE_ETH })
          const depositBefore = await entryPoint.balanceOf(paymaster.address)
          const countBefore = await counter.counters(account.address)
          const op = await countOp({
            callData: await dipCallData(),
            paymaster: paymaster.address,
            paymasterVerificationGasLimit: 1e5,
            paymasterPostOpGasLimit: 2e5
          })
          const beneficiary = createAddress()
          const rcpt = await entryPoint.handleOps([op], beneficiary, { gasLimit: 1e7 }).then(async t => await t.wait())
          const event = rcpt.events?.find(e => e.event === 'UserOperationEvent') as UserOperationEventEvent

          expect(event.args.success).to.equal(false)
          expect(rcpt.events?.filter(e => e.event === 'UserOperationReserveBalanceViolated').length).to.equal(1)
          expect(await paymaster.postOpCalls()).to.equal(1)
          expect(await paymaster.lastMode()).to.equal(1)
          expect(await paymaster.settledGasCost()).to.be.gt(0)
          expect(await paymaster.settledGasCost()).to.be.lt(event.args.actualGasCost)
          expect(depositBefore.sub(await entryPoint.balanceOf(paymaster.address))).to.equal(event.args.actualGasCost)
          expect(await ethers.provider.getBalance(beneficiary)).to.equal(event.args.actualGasCost)
          expect(event.args.actualGasCost).to.be.lt(requiredPrefund(op).add(3e5))
          expect(await getBalance(reserveRecipient)).to.equal(0)
          expect(await counter.counters(account.address)).to.equal(countBefore)
        })

        it('should cap recovery settlement at prefund and roll back its callback when verification slack is too small', async () => {
          const paymaster = await new TestReservePaymaster__factory(ethersSigner).deploy(entryPoint.address, reserveRecipient, 0, false)
          await entryPoint.depositTo(paymaster.address, { value: ONE_ETH })
          const depositBefore = await entryPoint.balanceOf(paymaster.address)
          const countBefore = await counter.counters(account.address)
          const callData = await dipCallData()
          const nonce = await entryPoint.getNonce(account.address, 0)
          const makeOp = async (verificationGasLimit: number, paymasterVerificationGasLimit: number): Promise<UserOperation> => await fillAndSign({
            sender: account.address,
            nonce,
            callData,
            verificationGasLimit,
            callGasLimit: 1e5,
            paymaster: paymaster.address,
            paymasterVerificationGasLimit,
            paymasterPostOpGasLimit: 2e5,
            maxFeePerGas: 1,
            maxPriorityFeePerGas: 1
          }, accountOwner, entryPoint)
          const minAccountGas = await findUserOpWithMin(async gas => await makeOp(gas, 1e5), false, entryPoint, 5000, 2e5) + 100
          const minPaymasterGas = await findUserOpWithMin(async gas => await makeOp(minAccountGas, gas), false, entryPoint, 1, 1e5)
          const op1 = packUserOp(await makeOp(minAccountGas, minPaymasterGas - 100))
          const op2 = await countOp({ nonce: nonce.add(1) })
          const rcpt = await entryPoint.handleOps([op1, op2], createAddress(), { gasLimit: 1e7 }).then(async t => await t.wait())
          const events = rcpt.events?.filter(e => e.event === 'UserOperationEvent') as UserOperationEventEvent[]
          const prefund = requiredPrefund(op1).add(minPaymasterGas - 100).add(2e5)
          const trace = await debugTransaction(rcpt.transactionHash)
          const paymasterCalls = trace.structLogs.filter(log => log.op === 'CALL' &&
            log.stack[log.stack.length - 2].slice(-40).toLowerCase() === paymaster.address.slice(2).toLowerCase())

          expect(paymasterCalls.length).to.equal(2, 'one validation call and one postOp call')
          expect(events.map(e => e.args.success)).to.eql([false, true])
          expect(events[0].args.actualGasCost).to.equal(prefund)
          expect(depositBefore.sub(await entryPoint.balanceOf(paymaster.address))).to.equal(prefund)
          expect(rcpt.events?.filter(e => e.event === 'UserOperationReserveBalanceViolated').length).to.equal(1)
          expect(rcpt.events?.filter(e => e.event === 'UserOperationPrefundTooLow').length).to.equal(1)
          expect(rcpt.events?.filter(e => e.event === 'PostOpRevertReason').length).to.equal(0)
          expect(await paymaster.postOpCalls()).to.equal(0)
          expect(await getBalance(reserveRecipient)).to.equal(0)
          expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
        })

        for (const accountDips of [false, true]) {
          for (const [action, label] of [[1, 'dips reserves'], [2, 'reverts'], [3, 'exhausts its gas allowance'], [4, 'returns oversized revert data']] as const) {
            it(`should isolate a ${accountDips ? 'recovery' : 'normal'} postOp that ${label}, without retrying it`, async () => {
              const paymaster = await new TestReservePaymaster__factory(ethersSigner).deploy(entryPoint.address, reserveRecipient, action, false, { value: 1 })
              await entryPoint.depositTo(paymaster.address, { value: ONE_ETH })
              const depositBefore = await entryPoint.balanceOf(paymaster.address)
              const countBefore = await counter.counters(account.address)
              const op1 = await countOp({
                callData: accountDips ? await dipCallData() : accountExecFromEntryPoint.data,
                paymaster: paymaster.address,
                paymasterVerificationGasLimit: 1e5,
                paymasterPostOpGasLimit: 2e5
              })
              const op2 = await countOp({ nonce: BigNumber.from(op1.nonce).add(1) })
              const rcpt = await entryPoint.handleOps([op1, op2], createAddress(), { gasLimit: 1e7 }).then(async t => await t.wait())
              const events = rcpt.events?.filter(e => e.event === 'UserOperationEvent') as UserOperationEventEvent[]
              const trace = await debugTransaction(rcpt.transactionHash)
              // Trace calls because state counters in failed callbacks are rolled back.
              const paymasterCalls = trace.structLogs.filter(log => log.op === 'CALL' &&
                log.stack[log.stack.length - 2].slice(-40).toLowerCase() === paymaster.address.slice(2).toLowerCase())

              expect(events.map(e => e.args.success)).to.eql([false, true])
              expect(paymasterCalls.length).to.equal(2, 'one validation call and one postOp call')
              expect(await paymaster.postOpCalls()).to.equal(0)
              expect(await getBalance(paymaster.address)).to.equal(1)
              expect(await getBalance(reserveRecipient)).to.equal(0)
              expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
              expect(await entryPoint.getNonce(account.address, 0)).to.equal(BigNumber.from(op1.nonce).add(2))
              expect(depositBefore.sub(await entryPoint.balanceOf(paymaster.address))).to.equal(events[0].args.actualGasCost)
              expect(events[0].args.actualGasCost).to.be.gt(0)
              expect(events[0].args.actualGasCost).to.be.lte(requiredPrefund(op1).add(3e5))
              expect(rcpt.events?.filter(e => e.event === 'UserOperationReserveBalanceViolated').length).to.equal(accountDips || action === 1 ? 1 : 0)
              const failures = rcpt.events?.filter(e => e.event === 'PostOpRevertReason') ?? []
              if (action !== 1) {
                expect(failures.length).to.equal(1)
                expect(arrayify(failures[0].args?.revertReason).length).to.be.lte(2048)
              }
            })
          }
        }

        for (const accountDips of [false, true]) {
          for (const callGasLimit of [100_000, 1_000_000]) {
            for (const [action, label] of [[1, 'violates reserves'], [2, 'reverts'], [3, 'runs out of gas']] as const) {
              it(`charges a failed ${accountDips ? 'recovery' : 'normal'} postOp allowance only once when it ${label}, call limit ${callGasLimit}`, async () => {
                const paymaster = await new TestReservePaymaster__factory(ethersSigner)
                  .deploy(entryPoint.address, reserveRecipient, action, false, { value: 1 })
                await entryPoint.depositTo(paymaster.address, { value: ONE_ETH })
                const paymasterPostOpGasLimit = 600_000
                const preVerificationGas = 60_000
                const minimumExecutionCharge = callGasLimit + paymasterPostOpGasLimit + preVerificationGas

                async function execute (gasToBurn: number): Promise<{ charge: BigNumber, gasUsed: BigNumber, prefund: BigNumber, prefundFailures: number }> {
                  const snapshot = await ethers.provider.send('evm_snapshot', [])
                  try {
                    await paymaster.setGasToBurn(gasToBurn)
                    const depositBefore = await entryPoint.balanceOf(paymaster.address)
                    const countBefore = await counter.counters(account.address)
                    const op1 = await countOp({
                      callData: accountDips ? await dipCallData() : accountExecFromEntryPoint.data,
                      verificationGasLimit: 200_000,
                      callGasLimit,
                      preVerificationGas,
                      paymaster: paymaster.address,
                      paymasterVerificationGasLimit: 100_000,
                      paymasterPostOpGasLimit
                    })
                    const op2 = await countOp({ nonce: BigNumber.from(op1.nonce).add(1) })
                    const beneficiary = createAddress()
                    const receipt = await entryPoint.handleOps([op1, op2], beneficiary, { gasLimit: 10_000_000 })
                      .then(async tx => tx.wait())
                    const events = receipt.events?.filter(event => event.event === 'UserOperationEvent') as UserOperationEventEvent[]
                    const charge = events[0].args.actualGasCost
                    const prefund = requiredPrefund(op1).add(100_000).add(paymasterPostOpGasLimit)
                    expect(events.map(event => event.args.success)).to.eql([false, true])
                    expect(charge).to.be.gte(minimumExecutionCharge)
                    expect(depositBefore.sub(await entryPoint.balanceOf(paymaster.address))).to.equal(charge)
                    expect(await ethers.provider.getBalance(beneficiary)).to.equal(charge.add(events[1].args.actualGasCost))
                    expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
                    expect(await entryPoint.getNonce(account.address, 0)).to.equal(BigNumber.from(op1.nonce).add(2))
                    expect(await paymaster.postOpCalls()).to.equal(0)
                    expect(await ethers.provider.getBalance(paymaster.address)).to.equal(1)
                    expect(await ethers.provider.getBalance(reserveRecipient)).to.equal(0)
                    expect(receipt.events?.filter(event => event.event === 'UserOperationReserveBalanceViolated'))
                      .to.have.lengthOf(accountDips || action === 1 ? 1 : 0)
                    return {
                      charge,
                      gasUsed: events[0].args.actualGasUsed,
                      prefund,
                      prefundFailures: receipt.events?.filter(event => event.event === 'UserOperationPrefundTooLow').length ?? 0
                    }
                  } finally {
                    await ethers.provider.send('evm_revert', [snapshot])
                  }
                }

                const results = [await execute(0)]
                if (action !== 3) {
                  results.push(await execute(400_000))
                  // Both callbacks reserve the same execution and postOp allowances at 100%.
                  expect(results[1].charge.sub(results[0].charge).toNumber()).to.be.closeTo(0, 10_000)
                }
                for (const result of results) {
                  expect(result.prefundFailures).to.equal(0)
                  expect(result.charge).to.be.lt(result.prefund)
                  expect(result.charge).to.equal(result.gasUsed)
                }
              })
            }
          }
        }

        for (const actor of ['account', 'paymaster']) {
          for (const route of ['ordinary', 'aggregated', 'simulation']) {
            it(`should reject ${actor} validation reserve dips through ${route}`, async () => {
              let validationAccount = account
              let op: PackedUserOperation
              let paymasterAddress: string | undefined
              if (actor === 'account') {
                const owner = createAccountOwner()
                validationAccount = (await createAccount(ethersSigner, owner.address, entryPoint.address, simpleAccountFactory)).proxy
                await fund(validationAccount)
                op = await fillSignAndPack({
                  sender: validationAccount.address,
                  callData: accountExecFromEntryPoint.data,
                  verificationGasLimit: 1e6,
                  callGasLimit: 1e6,
                  maxFeePerGas: 1,
                  maxPriorityFeePerGas: 1
                }, owner, entryPoint)
                const balance = await ethers.provider.getBalance(validationAccount.address)
                await installReserveMock(validationAccount.address, balance.sub(requiredPrefund(op)).add(1))
              } else {
                const paymaster = await new TestReservePaymaster__factory(ethersSigner).deploy(entryPoint.address, reserveRecipient, 0, true, { value: 1 })
                paymasterAddress = paymaster.address
                await entryPoint.depositTo(paymaster.address, { value: ONE_ETH })
                op = await countOp({ paymaster: paymaster.address, paymasterVerificationGasLimit: 1e5, paymasterPostOpGasLimit: 2e5 })
              }
              const accountBalance = await ethers.provider.getBalance(validationAccount.address)
              const nonceBefore = await entryPoint.getNonce(validationAccount.address, 0)
              const depositBefore = await entryPoint.balanceOf(paymasterAddress ?? validationAccount.address)
              const countBefore = await counter.counters(validationAccount.address)
              const call = route === 'simulation'
                ? simulateValidation(op, entryPoint.address, { gasLimit: 1e7 })
                : route === 'aggregated'
                  ? entryPoint.handleAggregatedOps([{ userOps: [op], aggregator: AddressZero, signature: '0x' }], createAddress())
                  : entryPoint.handleOps([op], createAddress())

              await expect(call).to.be.revertedWith('AA27 reserve violation during validation')
              expect(await entryPoint.getNonce(validationAccount.address, 0)).to.equal(nonceBefore)
              expect(await entryPoint.balanceOf(paymasterAddress ?? validationAccount.address)).to.equal(depositBefore)
              expect(await ethers.provider.getBalance(validationAccount.address)).to.equal(accountBalance)
              expect(await getBalance(reserveRecipient)).to.equal(0)
              expect(await counter.counters(validationAccount.address)).to.equal(countBefore)
            })
          }
        }

        it('should reject aggregator state changes through static validation', async () => {
          const aggregator = await new TestReserveAggregator__factory(ethersSigner).deploy(reserveRecipient, { value: 1 })
          const account = await new TestAggregatedAccount__factory(ethersSigner).deploy(entryPoint.address, aggregator.address)
          await fund(account)
          const op = await fillSignAndPack({ sender: account.address, verificationGasLimit: 1e6 }, accountOwner, entryPoint)
          const nonceBefore = await entryPoint.getNonce(account.address, 0)
          const balanceBefore = await ethers.provider.getBalance(account.address)
          await expect(entryPoint.handleAggregatedOps([{
            userOps: [op], aggregator: aggregator.address, signature: '0x'
          }], createAddress())).to.be.revertedWith(`SignatureValidationFailed("${aggregator.address}")`)
          expect(await getBalance(aggregator.address)).to.equal(1)
          expect(await getBalance(reserveRecipient)).to.equal(0)
          expect(await ethers.provider.getBalance(account.address)).to.equal(balanceBefore)
          expect(await entryPoint.getNonce(account.address, 0)).to.equal(nonceBefore)
        })

        for (const [code, label] of [
          ['0x', 'is missing'],
          ['0x60006000f3', 'returns no data'],
          ['0x60006000fd', 'reverts'],
          ['0x600260005260206000f3', 'returns a noncanonical boolean'],
          ['0x600060005260406000f3', 'returns too much data']
        ]) {
          it(`should fail closed at admission when the precompile ${label}`, async () => {
            if (code === '0x') {
              // Hardhat 2.18 ignores empty setCode; SELFDESTRUCT clears code on its Shanghai VM.
              await ethers.provider.send('hardhat_setCode', [RESERVE_BALANCE_PRECOMPILE, '0x33ff'])
              await ethersSigner.sendTransaction({ to: RESERVE_BALANCE_PRECOMPILE })
            } else {
              await ethers.provider.send('hardhat_setCode', [RESERVE_BALANCE_PRECOMPILE, code])
            }
            expect(await ethers.provider.getCode(RESERVE_BALANCE_PRECOMPILE)).to.equal(code)
            const op = await countOp()
            if (label === 'returns a noncanonical boolean') {
              await expect(entryPoint.handleOps([op], createAddress())).to.be.reverted
            } else {
              await expect(entryPoint.handleOps([op], createAddress())).to.be.revertedWith('InitialReserveBalanceViolated')
            }
          })
        }
      })

      describe('should pay prefund and revert account if prefund is not enough', function () {
        const beneficiary = createAddress()
        const maxFeePerGas = 1
        const maxPriorityFeePerGas = 1
        let callData: string
        let nonce: number
        let paymaster: TestPaymasterWithPostOp
        let minCallGas: number

        async function createUserOpWithGas (vgl: number, pmVgl: number, cgl: number): Promise<UserOperation> {
          return fillAndSign({
            sender: account.address,
            nonce,
            callData,
            callGasLimit: cgl,
            paymaster: pmVgl > 0 ? paymaster.address : undefined,
            paymasterVerificationGasLimit: pmVgl > 0 ? pmVgl : undefined,
            maxFeePerGas,
            maxPriorityFeePerGas,
            verificationGasLimit: vgl
          }, accountOwner, entryPoint)
        }

        this.timeout(50000)
        before(async () => {
          const execCount = counter.interface.encodeFunctionData('count')
          callData = account.interface.encodeFunctionData('execute', [counter.address, 0, execCount])
          nonce = (await account.getNonce()).toNumber()
          paymaster = await new TestPaymasterWithPostOp__factory(ethersSigner).deploy(entryPoint.address)
          await entryPoint.depositTo(paymaster.address, { value: parseEther('1') })
          await entryPoint.depositTo(account.address, { value: parseEther('1') })

          // find minimum callGasLimit:
          minCallGas = await findUserOpWithMin(async (cgl: number) => createUserOpWithGas(5e5, 0, cgl), true, entryPoint, 1, 100000, 2)
        })

        let snapshot: any
        beforeEach(async () => {
          snapshot = await ethers.provider.send('evm_snapshot', [])
        })
        afterEach(async () => {
          await ethers.provider.send('evm_revert', [snapshot])
        })

        it('without paymaster', async function () {
          const vgl = await findUserOpWithMin(async (vgl: number) => createUserOpWithGas(vgl, 0, minCallGas), false, entryPoint, 5000, 100000, 2)

          const current = await counter.counters(account.address)
          // expect calldata to revert below minGas:
          const beneficiaryBalance = await ethers.provider.getBalance(beneficiary)
          const rcpt = await entryPoint.handleOps([packUserOp(await createUserOpWithGas(vgl - 1, 0, minCallGas))], beneficiary).then(async r => r.wait())
          expect(rcpt.events?.map(ev => ev.event)).to.eql([
            'BeforeExecution',
            'UserOperationPrefundTooLow',
            'UserOperationEvent'])
          const userOpEvent = rcpt.events?.find(e => e.event === 'UserOperationEvent') as UserOperationEventEvent
          const collected = (await ethers.provider.getBalance(beneficiary)).sub(beneficiaryBalance)
          expect(userOpEvent.args.actualGasCost).to.equal(collected)
          expect(await counter.counters(account.address)).to.eql(current, 'should revert account with prefund too low')
          expect(userOpEvent.args.success).to.eql(false)
        })

        it('with paymaster', async function () {
          const current = await counter.counters(account.address)

          const minVerGas = await findUserOpWithMin(async (vgl: number) => createUserOpWithGas(vgl, 1e5, minCallGas), false, entryPoint, 5000, 100000, 2)
          const minPmVerGas = await findUserOpWithMin(async (pmVgl: number) => createUserOpWithGas(minVerGas, pmVgl, minCallGas), false, entryPoint, 1, 100000, 2)

          const beneficiaryBalance = await ethers.provider.getBalance(beneficiary)
          const rcpt = await entryPoint.handleOps([packUserOp(await createUserOpWithGas(minVerGas, minPmVerGas - 1, minCallGas))], beneficiary)
            .then(async r => r.wait())
            .catch((e: Error) => { throw new Error(decodeRevertReason(e, false) as any) })
          expect(rcpt.events?.map(ev => ev.event)).to.eql([
            'BeforeExecution',
            'PostOpRevertReason',
            'UserOperationPrefundTooLow',
            'UserOperationEvent'])
          expect(await counter.counters(account.address)).to.eql(current, 'should revert account with prefund too low')
          const userOpEvent = rcpt.events?.find(e => e.event === 'UserOperationEvent') as UserOperationEventEvent
          const collected = (await ethers.provider.getBalance(beneficiary)).sub(beneficiaryBalance)
          expect(userOpEvent.args.actualGasCost).to.equal(collected)
          expect(userOpEvent.args.success).to.eql(false)
        })
      })

      it('account should pay for tx', async function () {
        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExecFromEntryPoint.data,
          verificationGasLimit: 1e6,
          callGasLimit: 1e6
        }, accountOwner, entryPoint)
        const beneficiaryAddress = createAddress()
        const countBefore = await counter.counters(account.address)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        // must specify at least on of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const countAfter = await counter.counters(account.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)

        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })

      it('account should pay for high gas usage tx', async function () {
        if (process.env.COVERAGE != null) {
          return
        }
        const iterations = 45
        const count = await counter.populateTransaction.gasWaster(iterations, '')
        const accountExec = await account.populateTransaction.execute(counter.address, 0, count.data!)
        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExec.data,
          verificationGasLimit: 1e5,
          callGasLimit: 11e5
        }, accountOwner, entryPoint)
        const beneficiaryAddress = createAddress()
        const offsetBefore = await counter.offset()
        console.log('  == offset before', offsetBefore)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        // must specify at least on of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 13e5
        }).then(async t => await t.wait())

        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)
        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)

        // check that the state of the counter contract is updated
        // this ensures that the `callGasLimit` is high enough
        // therefore this value can be used as a reference in the test below
        console.log('  == offset after', await counter.offset())
        expect(await counter.offset()).to.equal(offsetBefore.add(iterations))
      })

      it('account should not pay if too low gas limit was set', async function () {
        const iterations = 45
        const count = await counter.populateTransaction.gasWaster(iterations, '')
        const accountExec = await account.populateTransaction.execute(counter.address, 0, count.data!)
        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExec.data,
          verificationGasLimit: 1e5,
          callGasLimit: 11e5
        }, accountOwner, entryPoint)
        const inititalAccountBalance = await getBalance(account.address)
        const beneficiaryAddress = createAddress()
        const offsetBefore = await counter.offset()
        console.log('  == offset before', offsetBefore)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        // must specify at least on of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        // this transaction should revert as the gasLimit is too low to satisfy the expected `callGasLimit` (see test above)
        await expect(entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 12e5
        })).to.revertedWith('AA95 out of gas')

        // Make sure that the user did not pay for the transaction
        expect(await getBalance(account.address)).to.eq(inititalAccountBalance)
      })

      it('account should pay for any unused execution gas', async function () {
        if (process.env.COVERAGE != null) this.skip()
        const count = await counter.populateTransaction.gasWaster(10, '')
        const accountExec = await account.populateTransaction.execute(counter.address, 0, count.data!)
        const beneficiary = createAddress()
        await account.addDeposit({ value: ONE_ETH })
        await entryPoint.handleOps([await fillSignAndPack({
          sender: account.address,
          callData: accountExec.data
        }, accountOwner, entryPoint)], beneficiary)
        const callGasLimit = await ethersSigner.provider.estimateGas({
          from: entryPoint.address,
          to: account.address,
          data: accountExec.data
        })

        async function gasUsed (limit: BigNumberish): Promise<BigNumber> {
          const snapshot = await ethers.provider.send('evm_snapshot', [])
          try {
            const op = await fillSignAndPack({
              sender: account.address,
              callData: accountExec.data,
              verificationGasLimit: 1_000_000,
              callGasLimit: limit
            }, accountOwner, entryPoint)
            const receipt = await entryPoint.handleOps([op], beneficiary, { gasLimit: 10_000_000 })
              .then(async tx => tx.wait())
            const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), receipt.blockHash)
            expect(events).to.have.lengthOf(1)
            expect(events[0].args.success).to.equal(true)
            return events[0].args.actualGasUsed
          } finally {
            await ethers.provider.send('evm_revert', [snapshot])
          }
        }

        const baseline = await gasUsed(callGasLimit)
        for (const unusedGas of [4_000, 4_000_000]) {
          expect((await gasUsed(callGasLimit.add(unusedGas))).sub(baseline).toNumber()).to.be.closeTo(unusedGas, 500)
        }
      })

      it('legacy mode (maxPriorityFee==maxFeePerGas) should not use "basefee" opcode', async function () {
        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExecFromEntryPoint.data,
          maxPriorityFeePerGas: 10e9,
          maxFeePerGas: 10e9,
          verificationGasLimit: 1e6,
          callGasLimit: 1e6
        }, accountOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const ops = await debugTransaction(rcpt.transactionHash).then(tx => tx.structLogs.map(op => op.op))
        expect(ops).to.include('GAS')
        expect(ops).to.not.include('BASEFEE')
      })

      it('if account has a deposit, it should use it to pay', async function () {
        await account.addDeposit({ value: ONE_ETH })
        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExecFromEntryPoint.data,
          verificationGasLimit: 1e6,
          callGasLimit: 1e6
        }, accountOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        const countBefore = await counter.counters(account.address)
        // for estimateGas, must specify maxFeePerGas, otherwise our gas check fails
        console.log('  == est gas=', await entryPoint.estimateGas.handleOps([op], beneficiaryAddress, { maxFeePerGas: 1e9 }).then(tostr))

        const balBefore = await getBalance(account.address)
        const depositBefore = await entryPoint.balanceOf(account.address)
        // must specify at least one of maxFeePerGas, gasLimit
        // (gasLimit, to prevent estimateGas to fail on missing maxFeePerGas, see above..)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const countAfter = await counter.counters(account.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)

        const balAfter = await getBalance(account.address)
        const depositAfter = await entryPoint.balanceOf(account.address)
        expect(balAfter).to.equal(balBefore, 'should pay from stake, not balance')
        const depositUsed = depositBefore.sub(depositAfter)
        expect(await ethers.provider.getBalance(beneficiaryAddress)).to.equal(depositUsed)

        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })

      it('should pay for reverted tx', async () => {
        const op = await fillSignAndPack({
          sender: account.address,
          callData: '0xdeadface',
          verificationGasLimit: 1e6,
          callGasLimit: 1e6
        }, accountOwner, entryPoint)
        const beneficiaryAddress = createAddress()

        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          maxFeePerGas: 1e9,
          gasLimit: 1e7
        }).then(async t => await t.wait())

        const [log] = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), rcpt.blockHash)
        expect(log.args.success).to.eq(false)
        expect(await getBalance(beneficiaryAddress)).to.be.gte(1)
      })

      it('#handleOp (single)', async () => {
        const beneficiaryAddress = createAddress()

        const op = await fillSignAndPack({
          sender: account.address,
          callData: accountExecFromEntryPoint.data
        }, accountOwner, entryPoint)

        const countBefore = await counter.counters(account.address)
        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7
        }).then(async t => await t.wait())
        const countAfter = await counter.counters(account.address)
        expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)

        console.log('rcpt.gasUsed=', rcpt.gasUsed.toString(), rcpt.transactionHash)
        await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
      })

      it('should fail to call recursively into handleOps', async () => {
        const beneficiaryAddress = createAddress()

        const callHandleOps = entryPoint.interface.encodeFunctionData('handleOps', [[], beneficiaryAddress])
        const execHandlePost = account.interface.encodeFunctionData('execute', [entryPoint.address, 0, callHandleOps])
        const op = await fillSignAndPack({
          sender: account.address,
          callData: execHandlePost
        }, accountOwner, entryPoint)

        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7
        }).then(async r => r.wait())

        const error = rcpt.events?.find(ev => ev.event === 'UserOperationRevertReason')
        // console.log(rcpt.events!.map(e => ({ ev: e.event, ...objdump(e.args!) })))

        expect(decodeRevertReason(error?.args?.revertReason)).to.eql('ReentrancyGuardReentrantCall()', 'execution of handleOps inside a UserOp should revert')
      })
      it('should report failure on insufficient verificationGas after creation', async () => {
        const op0 = await fillSignAndPack({
          sender: account.address,
          verificationGasLimit: 5e5
        }, accountOwner, entryPoint)
        // must succeed with enough verification gas
        await simulateValidation(op0, entryPoint.address)

        const op1 = await fillSignAndPack({
          sender: account.address,
          verificationGasLimit: 10000
        }, accountOwner, entryPoint)
        await expect(simulateValidation(op1, entryPoint.address))
          .to.revertedWith('AA23 reverted')
      })
    })

    describe('create account', () => {
      let createOp: PackedUserOperation
      const beneficiaryAddress = createAddress() // 1

      it('should reject create if sender address is wrong', async () => {
        const op = await fillSignAndPack({
          initCode: getAccountInitCode(accountOwner.address, simpleAccountFactory),
          verificationGasLimit: 2e6,
          sender: '0x'.padEnd(42, '1')
        }, accountOwner, entryPoint)

        await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7
        })).to.revertedWith('AA14 initCode must return sender')
      })

      it('should reject create if account not funded', async () => {
        const op = await fillSignAndPack({
          initCode: getAccountInitCode(accountOwner.address, simpleAccountFactory, 100),
          verificationGasLimit: 2e6
        }, accountOwner, entryPoint)

        expect(await ethers.provider.getBalance(op.sender)).to.eq(0)

        await expect(entryPoint.callStatic.handleOps([op], beneficiaryAddress, {
          gasLimit: 1e7,
          gasPrice: await ethers.provider.getGasPrice()
        })).to.revertedWith('didn\'t pay prefund')

        // await expect(await ethers.provider.getCode(op.sender).then(x => x.length)).to.equal(2, "account exists before creation")
      })

      it('should succeed to create account after prefund', async () => {
        const salt = 20
        const preAddr = await getAccountAddress(accountOwner.address, simpleAccountFactory, salt)
        await fund(preAddr)
        createOp = await fillSignAndPack({
          initCode: getAccountInitCode(accountOwner.address, simpleAccountFactory, salt),
          callGasLimit: 1e6,
          verificationGasLimit: 2e6

        }, accountOwner, entryPoint)

        await expect(await ethers.provider.getCode(preAddr).then(x => x.length)).to.equal(2, 'account exists before creation')
        const ret = await entryPoint.handleOps([createOp], beneficiaryAddress, {
          gasLimit: 1e7
        })
        const rcpt = await ret.wait()
        const hash = await entryPoint.getUserOpHash(createOp)
        await expect(ret).to.emit(entryPoint, 'AccountDeployed')
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
          .withArgs(hash, createOp.sender, toChecksumAddress(createOp.initCode.toString().slice(0, 42)), AddressZero)

        await calcGasUsage(rcpt!, entryPoint, beneficiaryAddress)
      })

      it('should reject if account already created', async function () {
        const preAddr = await getAccountAddress(accountOwner.address, simpleAccountFactory)
        if (await ethers.provider.getCode(preAddr).then(x => x.length) === 2) {
          this.skip()
        }

        await expect(entryPoint.callStatic.handleOps([createOp], beneficiaryAddress, {
          gasLimit: 1e7
        })).to.revertedWith('sender already constructed')
      })
    })

    describe('batch multiple requests', function () {
      this.timeout(20000)
      if (process.env.COVERAGE != null) {
        return
      }
      /**
             * attempt a batch:
             * 1. create account1 + "initialize" (by calling counter.count())
             * 2. account2.exec(counter.count()
             *    (account created in advance)
             */
      let counter: TestCounter
      let accountExecCounterFromEntryPoint: PopulatedTransaction
      const beneficiaryAddress = createAddress()
      const accountOwner1 = createAccountOwner()
      let account1: string
      const accountOwner2 = createAccountOwner()
      let account2: SimpleAccount

      before('before', async () => {
        counter = await new TestCounter__factory(ethersSigner).deploy()
        const count = await counter.populateTransaction.count()
        accountExecCounterFromEntryPoint = await account.populateTransaction.execute(counter.address, 0, count.data!)
        account1 = await getAccountAddress(accountOwner1.address, simpleAccountFactory);
        ({ proxy: account2 } = await createAccount(ethersSigner, await accountOwner2.getAddress(), entryPoint.address))
        await fund(account1)
        await fund(account2.address)
        // execute and increment counter
        const op1 = await fillSignAndPack({
          initCode: getAccountInitCode(accountOwner1.address, simpleAccountFactory),
          callData: accountExecCounterFromEntryPoint.data,
          callGasLimit: 2e6,
          verificationGasLimit: 2e6
        }, accountOwner1, entryPoint)

        const op2 = await fillSignAndPack({
          callData: accountExecCounterFromEntryPoint.data,
          sender: account2.address,
          callGasLimit: 2e6,
          verificationGasLimit: 76000
        }, accountOwner2, entryPoint)

        await simulateValidation(op2, entryPoint.address)

        await fund(op1.sender)
        await fund(account2.address)
        await entryPoint.handleOps([op1!, op2], beneficiaryAddress).catch((rethrow())).then(async r => r!.wait())
        // console.log(ret.events!.map(e=>({ev:e.event, ...objdump(e.args!)})))
      })
      it('should execute', async () => {
        expect(await counter.counters(account1)).equal(1)
        expect(await counter.counters(account2.address)).equal(1)
      })
      it('should pay for tx', async () => {
        // const cost1 = prebalance1.sub(await ethers.provider.getBalance(account1))
        // const cost2 = prebalance2.sub(await ethers.provider.getBalance(account2.address))
        // console.log('cost1=', cost1)
        // console.log('cost2=', cost2)
      })
    })

    describe('aggregation tests', () => {
      const beneficiaryAddress = createAddress()
      let aggregator: TestSignatureAggregator
      let aggAccount: TestAggregatedAccount
      let aggAccount2: TestAggregatedAccount

      before(async () => {
        aggregator = await new TestSignatureAggregator__factory(ethersSigner).deploy()
        aggAccount = await new TestAggregatedAccount__factory(ethersSigner).deploy(entryPoint.address, aggregator.address)
        aggAccount2 = await new TestAggregatedAccount__factory(ethersSigner).deploy(entryPoint.address, aggregator.address)
        await ethersSigner.sendTransaction({ to: aggAccount.address, value: parseEther('0.1') })
        await ethersSigner.sendTransaction({ to: aggAccount2.address, value: parseEther('0.1') })
      })
      it('should fail to execute aggregated account without an aggregator', async () => {
        const userOp = await fillSignAndPack({
          sender: aggAccount.address
        }, accountOwner, entryPoint)

        // no aggregator is kind of "wrong aggregator"
        await expect(entryPoint.handleOps([userOp], beneficiaryAddress)).to.revertedWith('AA24 signature error')
      })
      it('should fail to execute aggregated account with wrong aggregator', async () => {
        const userOp = await fillSignAndPack({
          sender: aggAccount.address
        }, accountOwner, entryPoint)

        const wrongAggregator = await new TestSignatureAggregator__factory(ethersSigner).deploy()
        const sig = HashZero

        await expect(entryPoint.handleAggregatedOps([{
          userOps: [userOp],
          aggregator: wrongAggregator.address,
          signature: sig
        }], beneficiaryAddress)).to.revertedWith('AA24 signature error')
      })

      it('should reject non-contract (address(1)) aggregator', async () => {
        // this is just sanity check that the compiler indeed reverts on a call to "validateSignatures()" to nonexistent contracts
        const address1 = hexZeroPad('0x1', 20)
        const aggAccount1 = await new TestAggregatedAccount__factory(ethersSigner).deploy(entryPoint.address, address1)

        const userOp = await fillSignAndPack({
          sender: aggAccount1.address,
          maxFeePerGas: 0
        }, accountOwner, entryPoint)

        const sig = HashZero

        expect(await entryPoint.handleAggregatedOps([{
          userOps: [userOp],
          aggregator: address1,
          signature: sig
        }], beneficiaryAddress).catch(e => e.reason))
          .to.match(/invalid aggregator/)
        // (different error in coverage mode (because of different solidity settings)
      })

      it('should fail to execute aggregated account with wrong agg. signature', async () => {
        const userOp = await fillSignAndPack({
          sender: aggAccount.address
        }, accountOwner, entryPoint)

        const wrongSig = hexZeroPad('0x123456', 32)
        const aggAddress: string = aggregator.address
        await expect(
          entryPoint.handleAggregatedOps([{
            userOps: [userOp],
            aggregator: aggregator.address,
            signature: wrongSig
          }], beneficiaryAddress)).to.revertedWith(`SignatureValidationFailed("${aggAddress}")`)
      })

      it('should run with multiple aggregators (and non-aggregated-accounts)', async () => {
        const aggregator3 = await new TestSignatureAggregator__factory(ethersSigner).deploy()
        const aggAccount3 = await new TestAggregatedAccount__factory(ethersSigner).deploy(entryPoint.address, aggregator3.address)
        await ethersSigner.sendTransaction({ to: aggAccount3.address, value: parseEther('0.1') })

        const userOp1 = await fillSignAndPack({
          sender: aggAccount.address
        }, accountOwner, entryPoint)
        const userOp2 = await fillSignAndPack({
          sender: aggAccount2.address
        }, accountOwner, entryPoint)
        const userOp_agg3 = await fillSignAndPack({
          sender: aggAccount3.address
        }, accountOwner, entryPoint)
        const userOp_noAgg = await fillSignAndPack({
          sender: account.address
        }, accountOwner, entryPoint)

        // extract signature from userOps, and create aggregated signature
        // (not really required with the test aggregator, but should work with any aggregator
        const sigOp1 = await aggregator.validateUserOpSignature(userOp1)
        const sigOp2 = await aggregator.validateUserOpSignature(userOp2)
        userOp1.signature = sigOp1
        userOp2.signature = sigOp2
        const aggSig = await aggregator.aggregateSignatures([userOp1, userOp2])

        const aggInfos = [{
          userOps: [userOp1, userOp2],
          aggregator: aggregator.address,
          signature: aggSig
        }, {
          userOps: [userOp_agg3],
          aggregator: aggregator3.address,
          signature: HashZero
        }, {
          userOps: [userOp_noAgg],
          aggregator: AddressZero,
          signature: '0x'
        }]
        const rcpt = await entryPoint.handleAggregatedOps(aggInfos, beneficiaryAddress, { gasLimit: 3e6 }).then(async ret => ret.wait())
        const events = rcpt.events?.map((ev: Event) => {
          if (ev.event === 'UserOperationEvent') {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            return `userOp(${ev.args?.sender})`
          }
          if (ev.event === 'SignatureAggregatorChanged') {
            // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
            return `agg(${ev.args?.aggregator})`
          } else return null
        }).filter(ev => ev != null)
        // expected "SignatureAggregatorChanged" before every switch of aggregator
        expect(events).to.eql([
                    `agg(${aggregator.address})`,
                    `userOp(${userOp1.sender})`,
                    `userOp(${userOp2.sender})`,
                    `agg(${aggregator3.address})`,
                    `userOp(${userOp_agg3.sender})`,
                    `agg(${AddressZero})`,
                    `userOp(${userOp_noAgg.sender})`,
                    `agg(${AddressZero})`
        ])
      })

      describe('execution ordering', () => {
        let userOp1: UserOperation
        let userOp2: UserOperation
        before(async () => {
          userOp1 = await fillAndSign({
            sender: aggAccount.address
          }, accountOwner, entryPoint)
          userOp2 = await fillAndSign({
            sender: aggAccount2.address
          }, accountOwner, entryPoint)
          userOp1.signature = '0x'
          userOp2.signature = '0x'
        })

        context('create account', () => {
          let initCode: BytesLike
          let addr: string
          let userOp: PackedUserOperation
          before(async () => {
            const factory = await new TestAggregatedAccountFactory__factory(ethersSigner).deploy(entryPoint.address, aggregator.address)
            initCode = await getAggregatedAccountInitCode(entryPoint.address, factory)
            addr = await entryPoint.callStatic.getSenderAddress(initCode).catch(e => e.errorArgs.sender)
            await ethersSigner.sendTransaction({ to: addr, value: parseEther('0.1') })
            userOp = await fillSignAndPack({
              initCode
            }, accountOwner, entryPoint)
          })
          it('simulateValidation should return aggregator and its stake', async () => {
            await aggregator.addStake(entryPoint.address, 3, { value: TWO_ETH })
            const { aggregatorInfo } = await simulateValidation(userOp, entryPoint.address)
            expect(aggregatorInfo.aggregator).to.equal(aggregator.address)
            expect(aggregatorInfo.stakeInfo.stake).to.equal(TWO_ETH)
            expect(aggregatorInfo.stakeInfo.unstakeDelaySec).to.equal(3)
          })
          it('should create account in handleOps', async () => {
            await aggregator.validateUserOpSignature(userOp)
            const sig = await aggregator.aggregateSignatures([userOp])
            await entryPoint.handleAggregatedOps([{
              userOps: [{ ...userOp, signature: '0x' }],
              aggregator: aggregator.address,
              signature: sig
            }], beneficiaryAddress, { gasLimit: 3e6 })
          })
        })
      })
    })

    describe('with paymaster (account with no eth)', () => {
      let paymaster: TestPaymasterAcceptAll
      let counter: TestCounter
      let accountExecFromEntryPoint: PopulatedTransaction
      const account2Owner = createAccountOwner()

      before(async () => {
        paymaster = await new TestPaymasterAcceptAll__factory(ethersSigner).deploy(entryPoint.address)
        await paymaster.addStake(globalUnstakeDelaySec, { value: paymasterStake })
        counter = await new TestCounter__factory(ethersSigner).deploy()
        const count = await counter.populateTransaction.count()
        accountExecFromEntryPoint = await account.populateTransaction.execute(counter.address, 0, count.data!)
      })

      it('should fail with nonexistent paymaster', async () => {
        const pm = createAddress()
        const op = await fillSignAndPack({
          paymaster: pm,
          paymasterVerificationGasLimit: 3e6,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(account2Owner.address, simpleAccountFactory),
          verificationGasLimit: 3e6,
          callGasLimit: 1e6
        }, account2Owner, entryPoint)
        await expect(simulateValidation(op, entryPoint.address)).to.revertedWith('"AA30 paymaster not deployed"')
      })

      it('should fail if paymaster has no deposit', async function () {
        const op = await fillSignAndPack({
          paymaster: paymaster.address,
          paymasterVerificationGasLimit: 3e6,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(account2Owner.address, simpleAccountFactory),

          verificationGasLimit: 3e6,
          callGasLimit: 1e6
        }, account2Owner, entryPoint)
        const beneficiaryAddress = createAddress()
        await expect(entryPoint.handleOps([op], beneficiaryAddress)).to.revertedWith('"AA31 paymaster deposit too low"')
      })

      it('should not revert when paymaster reverts with custom error on postOp', async function () {
        const account3Owner = createAccountOwner()
        const errorPostOp = await new TestPaymasterRevertCustomError__factory(ethersSigner).deploy(entryPoint.address)
        await errorPostOp.setRevertType(0)
        await errorPostOp.addStake(globalUnstakeDelaySec, { value: paymasterStake })
        await errorPostOp.deposit({ value: ONE_ETH })

        const op = await fillSignAndPack({
          paymaster: errorPostOp.address,
          paymasterPostOpGasLimit: 1e5,
          paymasterVerificationGasLimit: 3e6,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(account3Owner.address, simpleAccountFactory),

          verificationGasLimit: 3e6,
          callGasLimit: 1e6
        }, account3Owner, entryPoint)
        const beneficiaryAddress = createAddress()
        const rcpt1 = await entryPoint.handleOps([op], beneficiaryAddress).then(async t => await t.wait())
        const logs1 = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), rcpt1.blockHash)
        const logs1postOpRevert = await entryPoint.queryFilter(entryPoint.filters.PostOpRevertReason(), rcpt1.blockHash)
        const postOpRevertReason = decodeRevertReason(logs1postOpRevert[0].args.revertReason, false)
        expect(logs1[0].args.success).to.be.false
        expect(postOpRevertReason).to.equal('PostOpReverted(CustomError("this is a long revert reason string we are looking for"))')
      })

      it('should not revert when paymaster reverts with known EntryPoint error in postOp', async function () {
        const account3Owner = createAccountOwner()
        const errorPostOp = await new TestPaymasterRevertCustomError__factory(ethersSigner).deploy(entryPoint.address)
        await errorPostOp.setRevertType(1)
        await errorPostOp.addStake(globalUnstakeDelaySec, { value: paymasterStake })
        await errorPostOp.deposit({ value: ONE_ETH })

        const op = await fillSignAndPack({
          paymaster: errorPostOp.address,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(account3Owner.address, simpleAccountFactory),

          verificationGasLimit: 3e6,
          callGasLimit: 1e6
        }, account3Owner, entryPoint)
        const beneficiaryAddress = createAddress()
        const rcpt1 = await entryPoint.handleOps([op], beneficiaryAddress).then(async t => await t.wait())
        const logs1 = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), rcpt1.blockHash)
        expect(logs1[0].args.success).to.be.false
      })

      it('paymaster should pay for tx', async function () {
        await paymaster.deposit({ value: ONE_ETH })
        const op = await fillSignAndPack({
          paymaster: paymaster.address,
          paymasterVerificationGasLimit: 1e6,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(account2Owner.address, simpleAccountFactory)
        }, account2Owner, entryPoint)
        const beneficiaryAddress = createAddress()

        const rcpt = await entryPoint.handleOps([op], beneficiaryAddress).then(async t => t.wait())

        const { actualGasCost } = await calcGasUsage(rcpt, entryPoint, beneficiaryAddress)
        const paymasterPaid = ONE_ETH.sub(await entryPoint.balanceOf(paymaster.address))
        expect(paymasterPaid).to.eql(actualGasCost)
      })
      it('charges unused postOp gas at the effective price when the paymaster returns empty context', async () => {
        const snapshot = await ethers.provider.send('evm_snapshot', [])
        await paymaster.deposit({ value: ONE_ETH })
        const countBefore = await counter.counters(account.address)

        async function execute (paymasterPostOpGasLimit: number, maxFeePerGas = 10, baseFee = 1): Promise<BigNumber> {
          const operationSnapshot = await ethers.provider.send('evm_snapshot', [])
          try {
            const op = await fillSignAndPack({
              sender: account.address,
              callData: accountExecFromEntryPoint.data,
              paymaster: paymaster.address,
              paymasterVerificationGasLimit: 100_000,
              paymasterPostOpGasLimit,
              verificationGasLimit: 1_000_000,
              callGasLimit: 100_000,
              preVerificationGas: 60_000,
              maxFeePerGas,
              maxPriorityFeePerGas: 2
            }, accountOwner, entryPoint)
            const depositBefore = await entryPoint.balanceOf(paymaster.address)
            const beneficiary = createAddress()
            await ethers.provider.send('hardhat_setNextBlockBaseFeePerGas', [ethers.utils.hexValue(baseFee)])
            const receipt = await entryPoint.handleOps([op], beneficiary, { gasLimit: 10_000_000, gasPrice: baseFee + 1 })
              .then(async tx => tx.wait())
            const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), receipt.blockHash)
            expect(events).to.have.lengthOf(1)
            const { success, actualGasCost, actualGasUsed } = events[0].args
            // This paymaster's postOp reverts, so success proves the callback was skipped.
            expect(success).to.equal(true)
            expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
            expect(actualGasCost).to.equal(actualGasUsed.mul(Math.min(maxFeePerGas, 2 + baseFee)))
            expect(depositBefore.sub(await entryPoint.balanceOf(paymaster.address))).to.equal(actualGasCost)
            expect(await ethers.provider.getBalance(beneficiary)).to.equal(actualGasCost)
            return actualGasCost
          } finally {
            await ethers.provider.send('evm_revert', [operationSnapshot])
          }
        }

        try {
          await execute(0)
          await execute(4_000, 4, 3)
          // Positive allowances take the same branch under coverage instrumentation.
          const minimumAllowance = await execute(1)
          for (const allowance of [4_000, 5_000_000]) {
            expect((await execute(allowance)).sub(minimumAllowance))
              .to.be.closeTo(BigNumber.from(allowance - 1).mul(3), 1_500)
          }
        } finally {
          await ethers.provider.send('evm_revert', [snapshot])
        }
      })

      it('includes unused execution gas in postOp settlement and charges unused postOp gas', async () => {
        const snapshot = await ethers.provider.send('evm_snapshot', [])
        const postOpPaymaster = await new TestPaymasterWithPostOp__factory(ethersSigner).deploy(entryPoint.address)
        await postOpPaymaster.deposit({ value: ONE_ETH })
        const countBefore = await counter.counters(account.address)

        async function execute (callGasLimit: number, paymasterPostOpGasLimit: number): Promise<{ paid: BigNumber, callbackCost: BigNumber }> {
          const operationSnapshot = await ethers.provider.send('evm_snapshot', [])
          try {
            const op = await fillSignAndPack({
              sender: account.address,
              callData: accountExecFromEntryPoint.data,
              paymaster: postOpPaymaster.address,
              paymasterVerificationGasLimit: 100_000,
              paymasterPostOpGasLimit,
              verificationGasLimit: 1_000_000,
              callGasLimit,
              preVerificationGas: 60_000,
              maxFeePerGas: 10,
              maxPriorityFeePerGas: 2
            }, accountOwner, entryPoint)
            const beneficiary = createAddress()
            const depositBefore = await entryPoint.balanceOf(postOpPaymaster.address)
            await ethers.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x1'])
            const receipt = await entryPoint.handleOps([op], beneficiary, { gasLimit: 10_000_000 })
              .then(async tx => tx.wait())
            const events = await entryPoint.queryFilter(entryPoint.filters.UserOperationEvent(), receipt.blockHash)
            expect(events).to.have.lengthOf(1)
            expect(events[0].args.success).to.equal(true)
            expect(await counter.counters(account.address)).to.equal(countBefore.add(1))
            const callbacks = await postOpPaymaster.queryFilter(postOpPaymaster.filters.PostOpActualGasCost(), receipt.blockHash)
            expect(callbacks).to.have.lengthOf(1)
            const paid = events[0].args.actualGasCost
            expect(paid).to.equal(events[0].args.actualGasUsed.mul(3))
            expect(depositBefore.sub(await entryPoint.balanceOf(postOpPaymaster.address))).to.equal(paid)
            expect(await ethers.provider.getBalance(beneficiary)).to.equal(paid)
            return { paid, callbackCost: callbacks[0].args.actualGasCost }
          } finally {
            await ethers.provider.send('evm_revert', [operationSnapshot])
          }
        }

        try {
          const baseline = await execute(100_000, 100_000)
          const extraCall = await execute(1_100_000, 100_000)
          expect(extraCall.paid.sub(baseline.paid).toNumber()).to.be.closeTo(3_000_000, 1_500)
          expect(extraCall.callbackCost.sub(baseline.callbackCost).toNumber()).to.be.closeTo(3_000_000, 1_500)
          const extraPostOp = await execute(100_000, 1_100_000)
          expect(extraPostOp.paid.sub(baseline.paid).toNumber()).to.be.closeTo(3_000_000, 1_500)
          expect(extraPostOp.callbackCost.toNumber()).to.be.closeTo(baseline.callbackCost.toNumber(), 1_500)
        } finally {
          await ethers.provider.send('evm_revert', [snapshot])
        }
      })

      it('simulateValidation should return paymaster stake and delay', async () => {
        await paymaster.deposit({ value: ONE_ETH })
        const anOwner = createAccountOwner()

        const op = await fillSignAndPack({
          paymaster: paymaster.address,
          paymasterVerificationGasLimit: 1e6,
          callData: accountExecFromEntryPoint.data,
          initCode: getAccountInitCode(anOwner.address, simpleAccountFactory)
        }, anOwner, entryPoint)

        const { paymasterInfo } = await simulateValidation(op, entryPoint.address)
        const {
          stake: simRetStake,
          unstakeDelaySec: simRetDelay
        } = paymasterInfo

        expect(simRetStake).to.eql(paymasterStake)
        expect(simRetDelay).to.eql(globalUnstakeDelaySec)
      })
    })

    describe('Validation time-range', () => {
      const beneficiary = createAddress()
      let account: TestExpiryAccount
      let now: number
      let sessionOwner: Wallet
      before('init account with session key', async () => {
        // create a test account. The primary owner is the global ethersSigner, so that we can easily add a temporaryOwner, below
        account = await new TestExpiryAccount__factory(ethersSigner).deploy(entryPoint.address)
        await account.initialize(await ethersSigner.getAddress())
        await ethersSigner.sendTransaction({ to: account.address, value: parseEther('0.1') })
        now = await ethers.provider.getBlock('latest').then(block => block.timestamp)
        sessionOwner = createAccountOwner()
        await account.addTemporaryOwner(sessionOwner.address, 100, now + 60)
      })

      describe('validateUserOp time-range', function () {
        it('should accept non-expired owner', async () => {
          const userOp = await fillSignAndPack({
            sender: account.address
          }, sessionOwner, entryPoint)
          const ret = await simulateValidation(userOp, entryPoint.address)
          const validationData = parseValidationData(ret.returnInfo.accountValidationData)
          expect(validationData.validUntil).to.eql(now + 60)
          expect(validationData.validAfter).to.eql(100)
        })

        it('should not reject expired owner', async () => {
          const expiredOwner = createAccountOwner()
          await account.addTemporaryOwner(expiredOwner.address, 123, now - 60)
          const userOp = await fillSignAndPack({
            sender: account.address
          }, expiredOwner, entryPoint)
          const ret = await simulateValidation(userOp, entryPoint.address)
          console.log(ret.returnInfo.accountValidationData.toHexString())
          const validationData = parseValidationData(ret.returnInfo.accountValidationData)
          console.log('validationdata=', validationData)
          expect(validationData.validUntil).eql(now - 60)
          expect(validationData.validAfter).to.eql(123)
        })
      })

      describe('validatePaymasterUserOp with deadline', function () {
        let paymaster: TestExpirePaymaster
        let now: number
        before('init account with session key', async function () {
          this.timeout(20000)
          paymaster = await new TestExpirePaymaster__factory(ethersSigner).deploy(entryPoint.address)
          await paymaster.addStake(1, { value: paymasterStake })
          await paymaster.deposit({ value: parseEther('0.1') })
          now = await ethers.provider.getBlock('latest').then(block => block.timestamp)
        })

        it('should accept non-expired paymaster request', async () => {
          const timeRange = defaultAbiCoder.encode(['uint48', 'uint48'], [123, now + 60])
          const userOp = await fillSignAndPack({
            sender: account.address,
            paymaster: paymaster.address,
            paymasterData: timeRange
          }, ethersSigner, entryPoint)
          const ret = await simulateValidation(userOp, entryPoint.address)
          const { validUntil, validAfter } = parseValidationData(ret.returnInfo.paymasterValidationData)
          expect(validUntil).to.eql(now + 60)
          expect(validAfter).to.eql(123)
        })

        it('should not reject expired paymaster request', async () => {
          const timeRange = defaultAbiCoder.encode(['uint48', 'uint48'], [321, now - 60])
          const userOp = await fillSignAndPack({
            sender: account.address,
            paymaster: paymaster.address,
            paymasterData: timeRange
          }, ethersSigner, entryPoint)
          const ret = await simulateValidation(userOp, entryPoint.address)
          const { validUntil, validAfter } = parseValidationData(ret.returnInfo.paymasterValidationData)
          expect(validUntil).to.eql(now - 60)
          expect(validAfter).to.eql(321)
        })
      })
      describe('handleOps should abort on time-range', () => {
        it('should revert on expired account', async () => {
          const expiredOwner = createAccountOwner()
          await account.addTemporaryOwner(expiredOwner.address, 1, 2)
          const userOp = await fillSignAndPack({
            sender: account.address
          }, expiredOwner, entryPoint)
          await expect(entryPoint.handleOps([userOp], beneficiary))
            .to.revertedWith('AA22 expired or not due')
        })

        it('should revert on date owner', async () => {
          const futureOwner = createAccountOwner()
          await account.addTemporaryOwner(futureOwner.address, now + 100, now + 200)
          const userOp = await fillSignAndPack({
            sender: account.address
          }, futureOwner, entryPoint)
          await expect(entryPoint.handleOps([userOp], beneficiary))
            .to.revertedWith('AA22 expired or not due')
        })
      })
    })
  })

  describe('ERC-165', function () {
    it('should return true for IEntryPoint interface ID', async function () {
      const iepInterface = IEntryPoint__factory.createInterface()
      const iepInterfaceID = getERC165InterfaceID([...iepInterface.fragments])
      expect(await entryPoint.supportsInterface(iepInterfaceID)).to.equal(true)
    })

    it('should return true for pure EntryPoint, IStakeManager and INonceManager interface IDs', async function () {
      const epInterface = IEntryPoint__factory.createInterface()
      const smInterface = IStakeManager__factory.createInterface()
      const nmInterface = INonceManager__factory.createInterface()
      // note: manually generating "pure", solidity-like "type(IEntryPoint).interfaceId" without inherited methods
      const inheritedMethods = new Set([...smInterface.fragments, ...nmInterface.fragments].map(f => f.name))
      const epPureInterfaceFunctions = [
        ...epInterface.fragments.filter(it => !inheritedMethods.has(it.name) && it.type === 'function')
      ]
      const epPureInterfaceID = getERC165InterfaceID(epPureInterfaceFunctions)
      const smInterfaceID = getERC165InterfaceID([...smInterface.fragments])
      const nmInterfaceID = getERC165InterfaceID([...nmInterface.fragments])
      expect(await entryPoint.supportsInterface(smInterfaceID)).to.equal(true)
      expect(await entryPoint.supportsInterface(nmInterfaceID)).to.equal(true)
      expect(await entryPoint.supportsInterface(epPureInterfaceID)).to.equal(true)
    })

    it('should return false for a wrong interface', async function () {
      const saInterface = SimpleAccountFactory__factory.createInterface()
      const entryPointInterfaceID = getERC165InterfaceID([...saInterface.fragments])
      expect(await entryPoint.supportsInterface(entryPointInterfaceID)).to.equal(false)
    })
  })
})
