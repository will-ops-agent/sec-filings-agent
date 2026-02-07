/**
 * ERC-8004 Identity Registration (env-only)
 *
 * Usage:
 *   bun run register
 *
 * Env:
 *   PRIVATE_KEY=0x...
 *   AGENT_DOMAIN=example.com
 *   RPC_URL=https://...
 *   CHAIN_ID=1 (Ethereum mainnet) | 8453 (Base mainnet) | 84532 (Base Sepolia)
 */

import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet, base, baseSepolia } from 'viem/chains';

const REGISTRY_ETH_MAINNET = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';

const abi = parseAbi(['function register(string _uri) external returns (uint256)']);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function resolveChain(chainId: number) {
  if (chainId === 1) return mainnet;
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  throw new Error(`Unsupported CHAIN_ID: ${chainId}`);
}

async function main() {
  const domain = requireEnv('AGENT_DOMAIN');
  const privateKey = requireEnv('PRIVATE_KEY') as `0x${string}`;

  const chainId = parseInt(process.env.CHAIN_ID || '1', 10);
  const rpcUrl = requireEnv('RPC_URL');

  const chain = resolveChain(chainId);

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

  const agentURI = `https://${domain}/.well-known/agent-metadata.json`;

  console.log('Registering ERC-8004 identity');
  console.log('Chain:', chain.name, `(chainId=${chain.id})`);
  console.log('From:', account.address);
  console.log('URI:', agentURI);

  // NOTE: This is the Ethereum mainnet registry address. If/when ERC-8004 is deployed elsewhere,
  // add per-chain addresses here.
  const registry = REGISTRY_ETH_MAINNET;

  const hash = await walletClient.writeContract({
    address: registry,
    abi,
    functionName: 'register',
    args: [agentURI],
  });

  console.log('Tx:', hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log('Confirmed in block:', receipt.blockNumber);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
