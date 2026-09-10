// SPDX-License-Identifier: GPL-3.0
/* solhint-disable one-contract-per-file, no-inline-assembly, avoid-low-level-calls */
pragma solidity ^0.8.28;

import "../interfaces/IReserveBalance.sol";
import "../interfaces/IAggregator.sol";
import "../core/BasePaymaster.sol";

contract TestReserveBalance is IReserveBalance {
    address public immutable monitored;
    uint256 public immutable minimumBalance;

    constructor(address account, uint256 minimum) {
        monitored = account;
        minimumBalance = minimum;
    }

    function dippedIntoReserve() external view returns (bool) {
        require(msg.data.length == 4, "invalid reserve input");
        return minimumBalance == 0 ? monitored.balance != 0 : monitored.balance < minimumBalance;
    }
}

contract TestReservePaymaster is BasePaymaster {
    enum Action { Settle, Dip, Revert, ExhaustGas, OversizedRevert }

    address payable public immutable recipient;
    Action public immutable action;
    bool public immutable dipDuringValidation;
    uint256 public postOpCalls;
    PostOpMode public lastMode;
    uint256 public settledGasCost;

    constructor(IEntryPoint ep, address payable target, Action postOpAction, bool validationDip)
        payable BasePaymaster(ep)
    {
        recipient = target;
        action = postOpAction;
        dipDuringValidation = validationDip;
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata, bytes32, uint256)
        internal override returns (bytes memory, uint256)
    {
        if (dipDuringValidation) {
            recipient.transfer(1);
        }
        return (abi.encode(recipient), 0);
    }

    function _postOp(PostOpMode mode, bytes calldata, uint256 actualGasCost, uint256)
        internal override
    {
        postOpCalls++;
        lastMode = mode;
        settledGasCost = actualGasCost;
        if (action == Action.Dip) {
            recipient.transfer(1);
        } else if (action == Action.Revert) {
            revert("reserve test postOp reverted");
        } else if (action == Action.ExhaustGas) {
            assembly ("memory-safe") {
                invalid()
            }
        } else if (action == Action.OversizedRevert) {
            assembly ("memory-safe") {
                revert(mload(0x40), 0x10000)
            }
        }
    }
}

contract TestReserveAggregator is IAggregator {
    address payable public immutable recipient;

    constructor(address payable target) payable {
        recipient = target;
    }

    function validateSignatures(PackedUserOperation[] calldata, bytes calldata) external {
        recipient.transfer(1);
    }

    function validateUserOpSignature(PackedUserOperation calldata) external pure returns (bytes memory) {
        return "";
    }

    function aggregateSignatures(PackedUserOperation[] calldata) external pure returns (bytes memory) {
        return "";
    }
}

contract TestNativeReserveProbe {
    function query(bytes calldata data, bool useStatic)
        external returns (bool success, bytes memory result, uint256 gasUsed)
    {
        uint256 preGas = gasleft();
        if (useStatic) {
            (success, result) = address(0x1001).staticcall{gas: 10000}(data);
        } else {
            (success, result) = address(0x1001).call{gas: 10000}(data);
        }
        gasUsed = preGas - gasleft();
    }
}
