/**
 * Anchoring CLI.
 *
 * Computes a Merkle root of all matched payments since the last anchor and
 * writes it on-chain (Base Sepolia by default). Idempotent: only anchors
 * payments not yet included in any anchor row.
 *
 * If ANCHOR_PRIVATE_KEY is not set, the CLI computes and stores the root but
 * skips the on-chain tx (useful for demos without a wallet).
 *
 * Contract expected: a minimal `anchorRoot(bytes32 root, bytes32 metaHash)` fn.
 * A reference Solidity file is at docs/Anchor.sol.
 */

import { createPublicClient, createWalletClient, http, toHex, keccak256, type Hex } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { nanoid } from "nanoid";
import { getDb } from "../db/client";
import { buildTree, hashLeaf, Leaf } from "./merkle";

const ABI = [
  {
    type: "function",
    name: "anchorRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "root", type: "bytes32" },
      { name: "metaHash", type: "bytes32" },
    ],
    outputs: [],
  },
] as const;

async function main() {
  const db = getDb();

  const sinceRow = db
    .prepare(
      `SELECT MAX(created_at) AS last_ts FROM anchors`
    )
    .get() as any;
  const since = sinceRow?.last_ts ?? "1970-01-01T00:00:00Z";

  const payments = db
    .prepare(
      `SELECT id, chama_id, user_id, daraja_receipt, amount_cents, created_at
       FROM payments
       WHERE status = 'matched' AND created_at > ?
       ORDER BY created_at ASC`
    )
    .all(since) as any[];

  if (payments.length === 0) {
    console.log(`[anchor] nothing new to anchor since ${since}`);
    return;
  }

  const leaves: Hex[] = payments.map((p) =>
    hashLeaf({
      chamaId: p.chama_id,
      paymentId: p.id,
      receipt: p.daraja_receipt ?? "",
      amountCents: p.amount_cents,
      userId: p.user_id ?? null,
      createdAt: p.created_at,
    } as Leaf)
  );
  const { root } = buildTree(leaves);
  const metaHash = keccak256(toHex(JSON.stringify({ count: payments.length, since })));

  console.log(`[anchor] ${payments.length} payments → root=${root}`);

  let txHash: string | null = null;
  const pk = process.env.ANCHOR_PRIVATE_KEY;
  const contract = process.env.ANCHOR_CONTRACT_ADDRESS as `0x${string}` | undefined;
  const rpc = process.env.ANCHOR_RPC_URL ?? "https://sepolia.base.org";

  if (pk && contract) {
    const account = privateKeyToAccount(pk as `0x${string}`);
    const client = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(rpc),
    });
    const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
    const hash = await client.writeContract({
      address: contract,
      abi: ABI,
      functionName: "anchorRoot",
      args: [root, metaHash],
    });
    await pub.waitForTransactionReceipt({ hash });
    txHash = hash;
    console.log(`[anchor] on-chain tx ${hash}`);
  } else {
    console.log(
      `[anchor] ANCHOR_PRIVATE_KEY / ANCHOR_CONTRACT_ADDRESS not set → dry run, not writing on-chain`
    );
  }

  db.prepare(
    `INSERT INTO anchors (id, chama_id, period, merkle_root, tx_hash, chain_id, contract_address, payment_ids)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(
    nanoid(),
    new Date().toISOString(),
    root,
    txHash,
    baseSepolia.id,
    contract ?? null,
    JSON.stringify(payments.map((p) => p.id))
  );
  console.log(`[anchor] saved anchor row`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
