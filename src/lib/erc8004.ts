import { createPublicClient, createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

import identityRegistryAbi from '../abi/IdentityRegistry.json';

export type Erc8004Registration = {
  type: 'agent';
  name: string;
  description?: string;
  domain: string;
  image?: string;
  services: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
  registrations: Array<{
    agentId?: string;
    agentRegistry: string;
  }>;
  supportedTrust?: string[];
};

export function buildAgentRegistration(params: {
  domain: string;
  name: string;
  description?: string;
  image?: string;
  chainId: number;
  identityRegistryAddress: string;
}): Erc8004Registration {
  const { domain, name, description, image, chainId, identityRegistryAddress } = params;

  return {
    type: 'agent',
    name,
    description,
    domain,
    image,
    services: [
      {
        id: 'a2a',
        type: 'a2a',
        serviceEndpoint: `https://${domain}/.well-known/agent-card.json`,
      },
    ],
    registrations: [
      {
        agentRegistry: `eip155:${chainId}:${identityRegistryAddress}`,
      },
    ],
    supportedTrust: ['feedback', 'inference-validation'],
  };
}

export async function registerErc8004IdentityOnBase(params: {
  rpcUrl: string;
  privateKey: Hex;
  agentUri: string;
  identityRegistryAddress: Hex;
}): Promise<{ txHash: Hex; blockNumber: bigint } | { skipped: true; reason: string }> {
  const { rpcUrl, privateKey, agentUri, identityRegistryAddress } = params;

  const account = privateKeyToAccount(privateKey);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  // NOTE: IdentityRegistry is upgradeable; we assume the proxy address is correct.
  // The contract may revert if already registered. In that case, we skip rather than crash boot.
  try {
    const txHash = await walletClient.writeContract({
      address: identityRegistryAddress,
      abi: identityRegistryAbi as any,
      functionName: 'register',
      args: [agentUri],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    return { txHash, blockNumber: receipt.blockNumber };
  } catch (err: any) {
    const msg = err?.shortMessage || err?.message || String(err);
    // Common case: already registered.
    if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registered')) {
      return { skipped: true, reason: msg };
    }
    throw err;
  }
}
