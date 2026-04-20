/**
 * Minimal Merkle tree for anchoring a day's matched contributions.
 *
 * - Leaves: keccak256(`${chamaId}|${paymentId}|${receipt}|${amountCents}|${userId}|${createdAt}`)
 * - Internal nodes: keccak256(concat(left, right)) with sibling-sort (no second-preimage attack
 *   without domain separation — we pad empty levels by duplicating the last node).
 *
 * A verifier off-chain reconstructs the leaf from the payment row, walks the proof, and
 * compares against the on-chain-anchored root. That's the full receipt.
 */

import { keccak256, toHex, concat, type Hex, bytesToHex, hexToBytes } from "viem";

export type Leaf = {
  chamaId: string;
  paymentId: string;
  receipt: string;
  amountCents: number;
  userId: string | null;
  createdAt: string;
};

export function hashLeaf(l: Leaf): Hex {
  const s = [
    l.chamaId,
    l.paymentId,
    l.receipt,
    l.amountCents.toString(),
    l.userId ?? "",
    l.createdAt,
  ].join("|");
  return keccak256(toHex(s));
}

function hashPair(a: Hex, b: Hex): Hex {
  // sort to make proofs order-independent
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  return keccak256(concat([hexToBytes(lo as Hex), hexToBytes(hi as Hex)]));
}

export function buildTree(leaves: Hex[]): { root: Hex; layers: Hex[][] } {
  if (leaves.length === 0) {
    const empty = keccak256(toHex(""));
    return { root: empty, layers: [[empty]] };
  }
  const layers: Hex[][] = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      const l = prev[i];
      const r = i + 1 < prev.length ? prev[i + 1] : prev[i];
      next.push(hashPair(l, r));
    }
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], layers };
}

export function proofForIndex(layers: Hex[][], index: number): Hex[] {
  const proof: Hex[] = [];
  let idx = index;
  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    const sibling = layer[pairIdx] ?? layer[idx];
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let acc = leaf;
  for (const node of proof) acc = hashPair(acc, node);
  return acc.toLowerCase() === root.toLowerCase();
}
