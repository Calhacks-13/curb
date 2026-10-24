// Tops up the demo driver wallet with Base Sepolia test USDC from the CDP
// faucet and prints both wallet addresses: `npm run fund --workspace @curb/payments`.

import { CdpClient } from "@coinbase/cdp-sdk";

import { DRIVER_WALLET, OWNER_WALLET } from "../src/cdp.js";

const cdp = new CdpClient();
const driver = await cdp.evm.getOrCreateAccount({ name: DRIVER_WALLET });
const owner = await cdp.evm.getOrCreateAccount({ name: OWNER_WALLET });
console.log(`driver (payer): ${driver.address}`);
console.log(`owner (payee):  ${owner.address}`);

const { transactionHash } = await cdp.evm.requestFaucet({ address: driver.address, network: "base-sepolia", token: "usdc" });
console.log(`requested test USDC for the driver: https://sepolia.basescan.org/tx/${transactionHash}`);
