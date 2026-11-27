// Writes the ABI + bytecode the studio needs to deploy from the owner's browser wallet: studio/site/artifacts.json
import fs from "node:fs";
const out = {};
for (const [file, name] of [["KryoOracle.sol", "KryoOracle"], ["KryonarkVault.sol", "KryonarkVault"], ["TestUSD.sol", "TestUSD"], ["FixedFeed.sol", "FixedFeed"], ["KryoPushFeed.sol", "KryoPushFeed"]]) {
  const j = JSON.parse(fs.readFileSync(new URL(`./out/${file}/${name}.json`, import.meta.url)));
  out[name] = { abi: j.abi, bytecode: j.bytecode.object };
}
fs.writeFileSync(new URL("../studio/site/artifacts.json", import.meta.url), JSON.stringify(out));
console.log("artifacts:", Object.keys(out).map((k) => `${k} ${(out[k].bytecode.length / 2 - 1)} bytes`).join(", "));
