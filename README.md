
# Description

This repository contains the tools and resources for working with [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337) Account Abstraction smart contracts. This includes the code for the singleton `EntryPoint` contract that is deployed by our team on most EVM-compatible networks.

# Overview

Account abstraction allows users to interact with Ethereum using smart contract wallets instead of EOAs, without compromising decentralization, providing benefits like:

- Social recovery
- Batched transactions
- Sponsored transactions (gas abstraction)
- Signature abstraction
- Advanced authorization logic

# Repository Structure 

## Core Components

- **EntryPoint Contract** (`contracts/core/EntryPoint.sol`): The central contract that processes UserOperations
- **BaseAccount** (`contracts/core/BaseAccount.sol`): Base implementation for smart contract accounts
- **BasePaymaster** (`contracts/core/BasePaymaster.sol`): Helper class for creating a paymaster
- **StakeManager** (`contracts/core/StakeManager.sol`): Manages deposits and stakes for accounts and paymasters
- **NonceManager** (`contracts/core/NonceManager.sol`): Handles nonce management for accounts
- **UserOperationLib** (`contracts/core/UserOperationLib.sol`): Utilities for working with UserOperations
- **Helpers** (`contracts/core/Helpers.sol`): Common constants and helper functions


## Sample Implementations

- **SimpleAccount** (`contracts/accounts/SimpleAccount.sol`): Basic implementation of an ERC-4337 account

- **Simple7702Account** (`contracts/accounts/Simple7702Account.sol`): A minimal account to be used with EIP-7702 (for batching) and ERC-4337 (for gas sponsoring)

- **SimpleAccountFactory** (`contracts/accounts/SimpleAccountFactory.sol`): A sample factory contract for SimpleAccount

## Monad reserve and fee policy

Reserve status must be clean when a bundle enters EntryPoint and after each UserOperation validation or aggregator signature validation. A validation reserve violation rejects the bundle, including in simulation. An execution reserve violation rolls back that operation's execution, consumes its validated nonce, and permits later operations to continue. A paymaster that returned context receives one `postOp(opReverted)` settlement attempt after execution rollback. A callback that reverts or violates reserves is rolled back and is not retried.

Unused `callGasLimit` and `paymasterPostOpGasLimit` are charged at 100%, with no threshold. This includes the entire postOp allowance when validation returns empty context; no callback runs in that case. Normal settlement and reserve-rejection settlement use `min(maxFeePerGas, maxPriorityFeePerGas + block.basefee)`. The prefund is reserved at `maxFeePerGas`, and the remainder is refunded. If final accounting exceeds the prefund, execution is rolled back and the charge is capped at the prefund.

Unused account and paymaster verification gas remain refundable. [Monad charges the outer transaction's gas limit](https://blog.monad.xyz/blog/how-monad-works), so bundlers must estimate the complete bundle and price its overhead through `preVerificationGas`; summing every declared verification limit does not guarantee reimbursement. Leave sufficient verification-gas slack for final accounting and reserve checks, and simulate the complete operation: increasing `preVerificationGas` alone increases both the prefund and the charge equally, so it cannot cure a prefund shortfall. Integrations must inspect `UserOperationEvent.success`, including `UserOperationPrefundTooLow` and `UserOperationReserveBalanceViolated` failures, even when the bundle transaction succeeds.


# Developer setup

## Installation 

### Clone the repository:

````bash
git clone https://github.com/eth-infinitism/account-abstraction.git
cd account-abstraction
yarn install
````
### Compilation:

```bash
yarn compile
```

### Testing:

```bash
yarn test
``` 

To run the native reserve integration tests, start Monad Anvil with `anvil --monad --hardfork MonadNine`, then run `MONAD_TEST_RPC=http://127.0.0.1:8545 yarn test test/entrypoint-monad.test.ts`. These tests use Anvil state controls and the native reserve precompile; they are skipped when `MONAD_TEST_RPC` is unset.
	

## Entrypoint Deployment

The EntryPoint contract is the central hub for processing UserOperations. It:
- Validates UserOperations
- Handles account creation (if needed)
- Executes the requested operations
- Manages gas payments and refunds

The EntryPoint is deployed by using 

```bash
hardhat deploy --network {net}
```

The upstream EntryPoint v0.8 deployment address does not apply to this modified Monad build. Its deterministic address depends on the compiled bytecode and `SALT`; use the deployment record produced for the selected network. Existing deployment records describe their original builds and do not update when source code changes. `Simple7702Account` is constructed with that deployment's EntryPoint address.

This repository also includes a number of audited base classes and utilities that can simplify the development of AA related contracts.

## Usage
### For projects integrating the library 

If you are building a project that uses account abstraction and want to integrate our contracts:

```bash
yarn add @account-abstraction/contracts
```

### For Paymaster development

```solidity
import "@account-abstraction/contracts/core/BasePaymaster.sol";

contract MyCustomPaymaster is BasePaymaster {
    /// implement your gas payment logic here
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal virtual override returns (bytes memory context, uint256 validationData) {
        context = “”; // specify “context” if needed in postOp call. 
        validationData = _packValidationData(
            false,
            validUntil,
            validAfter
        );
    }
}

```



### For Smart Contract Account development

```bash
import "@account-abstraction/contracts/core/BaseAccount.sol";

contract MyAccount is BaseAccount {

    /// implement your authentication logic here
    function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
    internal override virtual returns (uint256 validationData) {

        // UserOpHash can be generated using eth_signTypedData_v4
        if (owner != ECDSA.recover(userOpHash, userOp.signature))
            return SIG_VALIDATION_FAILED;
        return SIG_VALIDATION_SUCCESS;
    }
}
```

# Resources

- [Homepage](https://www.erc4337.io/)
- [Blog](https://erc4337.mirror.xyz/)
- [X Account](https://x.com/erc4337)
- [YouTube Channel](https://www.youtube.com/@ERC-4337)
- [Bundlebear](https://www.bundlebear.com/overview/all)
- [Vitalik Buterin - a history of account abstraction](https://www.youtube.com/watch?v=iLf8qpOmxQc)
- [Beyond 4337: Vitalik Buterin's Vision for the Future of Account Abstraction](https://www.youtube.com/watch?v=zpqa1Z4UpiA)
- [Exploring the Future of Account Abstraction by Yoav Weiss](https://www.youtube.com/watch?v=63Wd5mPla-M)
- [Native Account Abstraction in Pectra, rollups and beyond](https://www.youtube.com/watch?v=FYanFF-yU6w)
- [Vitalik Buterin - account abstraction without Ethereum protocol changes](https://medium.com/infinitism/erc-4337-account-abstraction-without-ethereum-protocol-changes-d75c9d94dc4a)
- [Unified ERC-4337 mempool](https://notes.ethereum.org/@yoav/unified-erc-4337-mempool)
- [Bundler reference implementation](https://github.com/eth-infinitism/bundler)
- [Discord server](http://discord.gg/fbDyENb6Y9)
