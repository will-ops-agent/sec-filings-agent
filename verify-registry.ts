/**
 * Verify ERC-8004 registry contract exists on a given chain.
 *
 * Usage:
 *   bun run verify-registry
 *
 * Env:
 *   RPC_URL=https://...
 *   CHAIN_ID=8453
 *   IDENTITY_REGISTRY_ADDRESS=0x...
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet, base, baseSepolia, sepolia } from 'viem/chains';

const abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function resolveChain(chainId: number) {
  if (chainId === 1) return mainnet;
  if (chainId === 8453) return base;
  if (chainId === 84532) return baseSepolia;
  if (chainId === 11155111) return sepolia;
  throw new Error(`Unsupported CHAIN_ID: ${chainId}`);
}

async function main() {
  const chainId = parseInt(requireEnv('CHAIN_ID'), 10);
  const rpcUrl = requireEnv('RPC_URL');
  const address = requireEnv('IDENTITY_REGISTRY_ADDRESS') as `0x${string}`;

  const chain = resolveChain(chainId);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const code = await client.getBytecode({ address });
  if (!code || code === '0x') {
    console.error('❌ No contract bytecode found');
    console.error('Chain:', chain.name, `(chainId=${chain.id})`);
    console.error('Address:', address);
    process.exit(2);
  }

  console.log('✅ Contract bytecode found');
  console.log('Chain:', chain.name, `(chainId=${chain.id})`);
  console.log('Address:', address);
  console.log('Bytecode length:', (code.length - 2) / 2, 'bytes');

  // Basic sanity read
  const bal = await client.readContract({
    address,
    abi,
    functionName: 'balanceOf',
    args: ['0x0000000000000000000000000000000000000000'],
  });
  console.log('balanceOf(0x0) returned:', bal.toString());
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
