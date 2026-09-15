Implementation of contracts for [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) account abstraction via alternative mempool.

# Monad reserve and fee policy

Reserve status must be clean when a bundle enters EntryPoint and after each UserOperation validation. Aggregator signature validation retains v0.7 static calls, so aggregators cannot change reserve state. A validation reserve violation rejects the bundle, including in simulation. An execution reserve violation rolls back that operation's execution, consumes its validated nonce, and permits later operations to continue. A paymaster that returned context receives one `postOp(opReverted)` settlement attempt after execution rollback. A callback that reverts or violates reserves is rolled back and is not retried.

Unused `callGasLimit` and `paymasterPostOpGasLimit` are charged at 100%, with no threshold. This includes the entire postOp allowance when validation returns empty context; no callback runs in that case. Normal settlement and reserve-rejection settlement use `min(maxFeePerGas, maxPriorityFeePerGas + block.basefee)`. The prefund is reserved at `maxFeePerGas`, and the remainder is refunded. If final accounting exceeds the prefund, execution is rolled back and the charge is capped at the prefund.

Unused account and paymaster verification gas remain refundable. Bundlers must estimate the complete bundle and price its overhead through `preVerificationGas`; summing every declared verification limit does not guarantee reimbursement. Leave sufficient verification-gas slack for final accounting and reserve checks, and simulate the complete operation: increasing `preVerificationGas` alone increases both the prefund and the charge equally, so it cannot cure a prefund shortfall. Integrations must inspect `UserOperationEvent.success`, including `UserOperationPrefundTooLow` and `UserOperationReserveBalanceViolated` failures, even when the bundle transaction succeeds.

This branch preserves the v0.7 UserOperation hash and account interfaces. The upstream EntryPoint v0.7 deployment address does not apply to this modified Monad build. Its deterministic address depends on the compiled bytecode and deployment salt; use the deployment record produced for the selected network. Existing deployment records describe their original builds and do not update when source code changes.

To run native reserve integration tests, start Monad Anvil with `anvil --monad --hardfork MonadNine`, then run `MONAD_TEST_RPC=http://127.0.0.1:8545 yarn test test/entrypoint-monad.test.ts`. These tests use Anvil state controls to delegate an EOA to the v0.7 `SimpleAccount` implementation and exercise the native reserve precompile. They are skipped when `MONAD_TEST_RPC` is unset.

# Resources

[Vitalik's post on account abstraction without Ethereum protocol changes](https://medium.com/infinitism/erc-4337-account-abstraction-without-ethereum-protocol-changes-d75c9d94dc4a)

[Discord server](http://discord.gg/fbDyENb6Y9)

[Bundler reference implementation](https://github.com/eth-infinitism/bundler)

[Bundler specification test suite](https://github.com/eth-infinitism/bundler-spec-tests)
