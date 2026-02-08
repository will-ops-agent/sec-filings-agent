/**
 * ERC-8004 Identity Registration (Base mainnet)
 *
 * Usage:
 *   bun run register
 *
 * Env:
 *   IDENTITY_PRIVATE_KEY=0x...
 *   AGENT_DOMAIN=example.com
 *   IDENTITY_RPC_URL=https://...
 *
 * Optional overrides:
 *   CHAIN_ID=8453
 *   IDENTITY_REGISTRY_ADDRESS=0x...
 */

import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import identityRegistryAbi from './src/abi/IdentityRegistry.json';

const DEFAULT_IDENTITY_REGISTRY =
  '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function main() {
  const domain = requireEnv('AGENT_DOMAIN');
  const privateKey = (process.env.IDENTITY_PRIVATE_KEY ??
    process.env.PRIVATE_KEY ??
    requireEnv('IDENTITY_PRIVATE_KEY')) as Hex;

  const chainId = parseInt(process.env.CHAIN_ID || '8453', 10);
  if (chainId !== 8453) {
    throw new Error(
      `This script is intended for Base mainnet (8453). Got CHAIN_ID=${chainId}`
    );
  }

  const rpcUrl =
    process.env.IDENTITY_RPC_URL ??
    process.env.BASE_RPC_URL ??
    process.env.RPC_URL ??
    requireEnv('IDENTITY_RPC_URL');

  const account = privateKeyToAccount(privateKey);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const agentURI = `https://${domain}/.well-known/agent-registration.json`;

  console.log('Registering ERC-8004 identity (Base mainnet)');
  console.log('Chain:', base.name, `(chainId=${base.id})`);
  console.log('From:', account.address);
  console.log('URI:', agentURI);

  const registry = (process.env.IDENTITY_REGISTRY_ADDRESS ??
    DEFAULT_IDENTITY_REGISTRY) as `0x${string}`;

  const hash = await walletClient.writeContract({
    address: registry,
    abi: identityRegistryAbi as any,
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
