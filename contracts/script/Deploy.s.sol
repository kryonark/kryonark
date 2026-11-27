// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "forge-std/Script.sol";
import "../src/KryoOracle.sol";
import "../src/KryonarkVault.sol";
import "../src/TestUSD.sol";

/// Deploys KryoOracle + KryonarkVault and lists collateral.
/// env:
///   REPORTER      agent address that pushes prices for assets without a Chainlink feed
///   USD           debt stablecoin address; "new" deploys TestUSD (testnet only)
///   BORROW_CAP    max total debt, whole dollars
///   ETH_CAP       max ETH collateral + buffers, whole ETH;  ETH_LT  e.g. 8000
///   STOCKS        comma list of stock token addresses;   STOCK_LT e.g. 7000; STOCK_CAP whole tokens per stock
///   FEEDS         optional, comma list asset=aggregator (asset "ETH" for ETH, "USD" for the stablecoin); FEED_MAX_AGE seconds
/// run: forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast --private-key $DEPLOYER_KEY
contract Deploy is Script {
    function run() external {
        address reporter = vm.envAddress("REPORTER");
        string memory usdEnv = vm.envString("USD");
        address[] memory stocks = vm.envAddress("STOCKS", ",");
        string[] memory feeds = vm.envOr("FEEDS", ",", new string[](0));

        vm.startBroadcast();
        address usd = keccak256(bytes(usdEnv)) == keccak256("new") ? address(new TestUSD()) : vm.parseAddress(usdEnv);
        KryoOracle oracle = new KryoOracle(reporter);
        KryonarkVault vault = new KryonarkVault(address(oracle), usd, vm.envUint("BORROW_CAP") * 10 ** IERC20(usd).decimals());
        vault.listAsset(address(0), uint16(vm.envUint("ETH_LT")), vm.envUint("ETH_CAP") * 1 ether);
        for (uint256 i; i < stocks.length; ++i) {
            vault.listAsset(stocks[i], uint16(vm.envUint("STOCK_LT")), vm.envUint("STOCK_CAP") * 10 ** IERC20(stocks[i]).decimals());
        }
        uint32 maxAge = uint32(vm.envOr("FEED_MAX_AGE", uint256(90_000)));
        for (uint256 i; i < feeds.length; ++i) {
            (string memory k, string memory v) = _split(feeds[i]);
            address asset = keccak256(bytes(k)) == keccak256("ETH") ? address(0) : keccak256(bytes(k)) == keccak256("USD") ? usd : vm.parseAddress(k);
            oracle.setFeed(asset, vm.parseAddress(v), maxAge);
        }
        vm.stopBroadcast();

        console.log("usd   ", usd);
        console.log("oracle", address(oracle));
        console.log("vault ", address(vault));
    }

    function _split(string memory s) internal pure returns (string memory a, string memory b) {
        bytes memory x = bytes(s);
        for (uint256 i; i < x.length; ++i) if (x[i] == "=") {
            bytes memory l = new bytes(i); bytes memory r = new bytes(x.length - i - 1);
            for (uint256 j; j < i; ++j) l[j] = x[j];
            for (uint256 j; j < r.length; ++j) r[j] = x[i + 1 + j];
            return (string(l), string(r));
        }
        revert("FEEDS entries are asset=aggregator");
    }
}
