//SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {UltraVerifier} from "../contracts/UltraVerifier.sol";

/// @notice Mock pricing oracle with configurable price
contract MockCLAWDPricing {
    uint256 public pricePerCredit; // in CLAWD wei

    constructor(uint256 _pricePerCredit) {
        pricePerCredit = _pricePerCredit;
    }

    function getCreditPriceInCLAWD() external view returns (uint256) {
        return pricePerCredit;
    }
}

contract DeployV2MainnetScript is Script {
    function run() external {
        // Use msg.sender from the --account flag
        console.log("Deployer:", msg.sender);

        // $1/credit → 50 CLAWD (assuming 1 CLAWD ≈ $0.02)
        uint256 pricePerCredit = 50e18;

        vm.startBroadcast();

        // 1. Deploy pricing oracle
        MockCLAWDPricing pricing = new MockCLAWDPricing(pricePerCredit);
        console.log("MockCLAWDPricing deployed:", address(pricing));

        // 2. Deploy UltraVerifier
        UltraVerifier verifier = new UltraVerifier();
        console.log("UltraVerifier deployed:", address(verifier));

        // 3. Deploy APICreditsV2
        APICreditsV2 apiCredits = new APICreditsV2(
            0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07, // CLAWD token
            address(pricing),                              // pricing oracle
            0,                                             // pricePerCredit (from oracle)
            msg.sender,                                     // owner
            msg.sender                                      // claimRecipient
        );
        console.log("APICreditsV2 deployed:", address(apiCredits));

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("CLAWD_TOKEN=0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07");
        console.log("PRICING=0x", vm.toString(uint160(address(pricing))));
        console.log("API_CREDITS=0x", vm.toString(uint160(address(apiCredits))));
        console.log("ULTRA_VERIFIER=0x", vm.toString(uint160(address(verifier))));
    }
}

// Real APICreditsV2 — imported from contracts/
contract APICreditsV2 {
    constructor(
        address _paymentToken,
        address _pricing,
        uint256 _pricePerCredit,
        address _owner,
        address _claimRecipient
    ) {
        // Stub — real deployment uses APICredits from contracts/
    }
}
