//SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "./DeployHelpers.s.sol";

/**
 * @notice Main deployment script for all contracts
 * @dev Contracts are already deployed on Base mainnet:
 *      APICredits: 0x595463222a592416BCbdADb297Bf7D050c09a44E
 *
 *      DO NOT redeploy — use this only if deploying to a new chain.
 *
 * Example: yarn deploy # runs this script(without`--file` flag)
 */
contract DeployScript is ScaffoldETHDeploy {
  function run() external {
    // Contracts already deployed on Base mainnet
    // See packages/foundry/deployments/ for addresses
  }
}
