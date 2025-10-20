// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.23;

interface ISscOpcodes {
    function accountsCreated() external view returns (uint256); // D0
    function accountsCleared() external view returns (uint256); // D1
    function slotsCreated() external view returns (uint256); // D2
    function slotsCleared() external view returns (uint256); // D3
    function codeCreated() external view returns (uint256); // D4
}