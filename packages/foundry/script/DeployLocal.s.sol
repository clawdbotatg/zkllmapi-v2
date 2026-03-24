//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Mock ERC20 token (CLAWD)
contract MockCLAWD is ERC20 {
    constructor() ERC20("CLAWDAO Token", "CLAWD") {
        // Mint 1 billion tokens to deployer
        _mint(msg.sender, 1_000_000_000e18);
    }
}

/// @notice Mock pricing oracle
contract MockCLAWDPricing {
    uint256 public pricePerCredit = 5e16; // $0.05 in CLAWD terms (1 CLAWD = $1)

    function getCreditPriceInCLAWD() external view returns (uint256) {
        return pricePerCredit;
    }
}

/// @notice Simple router that just calls APICredits.stakeAndRegister
/// Needed because the e2e test uses router.stakeAndRegister()
contract SimpleRouter {
    ERC20 public paymentToken;
    address public apiCredits;

    constructor(address _paymentToken, address _apiCredits) {
        paymentToken = ERC20(_paymentToken);
        apiCredits = _apiCredits;
    }

    function getCreditPriceInCLAWD() external view returns (uint256) {
        return MockCLAWDPricing(msg.sender).getCreditPriceInCLAWD();
    }

    function stakeAndRegister(uint256 amount, uint256[] calldata commitments) external {
        // Pull tokens from caller
        paymentToken.transferFrom(msg.sender, address(this), amount);
        paymentToken.approve(apiCredits, amount);
        APICredits(apiCredits).stakeAndRegister(amount, commitments);
    }
}

// Minimal APICredits interface for the router
interface APICredits {
    function stakeAndRegister(uint256 amount, uint256[] calldata commitments) external;
}

contract DeployLocalScript is Script {
    function run() external {
        // Use Anvil default key for chain 31337, allow override via PRIVATE_KEY env
        uint256 deployerPrivateKey = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
        // Allow PRIVATE_KEY override
        try vm.envUint("PRIVATE_KEY") returns (uint256 key) {
            deployerPrivateKey = key;
        } catch {}

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy mock CLAWD token
        MockCLAWD mockCLAWD = new MockCLAWD();
        console.log("MockCLAWD deployed:", address(mockCLAWD));

        // 2. Deploy mock pricing
        MockCLAWDPricing mockPricing = new MockCLAWDPricing();
        console.log("MockCLAWDPricing deployed:", address(mockPricing));

        // 3. Deploy APICredits
        APICreditsV2 apiCredits = new APICreditsV2();
        console.log("APICredits deployed:", address(apiCredits));

        // 4. Fund the test wallet with CLAWD tokens
        address testWallet = 0x44426C647c5C0d1e30aa9f965881E22739E566e9;
        mockCLAWD.transfer(testWallet, 100e18); // 100 CLAWD
        console.log("Funded test wallet with 100 CLAWD");

        vm.stopBroadcast();

        console.log("");
        console.log("=== Deployed Addresses ===");
        console.log("CLAWD_TOKEN=", address(mockCLAWD));
        console.log("CLAWD_PRICING=", address(mockPricing));
        console.log("API_CREDITS=", address(apiCredits));
    }
}

// Placeholder — deploy the real APICredits
contract APICreditsV2 {
    constructor() {}
}
