/**
 * One-time sweep script — sends all SOL from Meridian's wallet to a destination address.
 * Usage: node scripts/sweep-wallet.js
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import readline from "readline";

const DESTINATION = "GAFLx1PRLc8UVc6tBbKH3KuGf3hPYahQ3SnnavpZQkQG";
const FEE_RESERVE_SOL = 0.005;
const FEE_RESERVE_LAMPORTS = Math.floor(FEE_RESERVE_SOL * LAMPORTS_PER_SOL);

// ── Load keypair ──────────────────────────────────────────────────────
const rawKey = process.env.WALLET_PRIVATE_KEY;
if (!rawKey) {
  console.error("ERROR: WALLET_PRIVATE_KEY env var is not set.");
  process.exit(1);
}

let wallet;
try {
  wallet = Keypair.fromSecretKey(bs58.decode(rawKey));
} catch {
  try {
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(rawKey)));
  } catch {
    console.error("ERROR: Could not parse WALLET_PRIVATE_KEY — must be base58 or JSON array.");
    process.exit(1);
  }
}

// ── Connect ───────────────────────────────────────────────────────────
const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

// ── Fetch balance ─────────────────────────────────────────────────────
const balanceLamports = await connection.getBalance(wallet.publicKey);
const sendLamports = balanceLamports - FEE_RESERVE_LAMPORTS;

if (sendLamports <= 0) {
  console.error(
    `ERROR: Balance ${(balanceLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL is too low to sweep after reserving ${FEE_RESERVE_SOL} SOL for fees.`
  );
  process.exit(1);
}

const sendSol = (sendLamports / LAMPORTS_PER_SOL).toFixed(6);

// ── Confirmation prompt ───────────────────────────────────────────────
console.log("\n─────────────────────────────────────────");
console.log("  SWEEP SUMMARY");
console.log("─────────────────────────────────────────");
console.log(`From:    ${wallet.publicKey.toBase58()}`);
console.log(`To:      ${DESTINATION}`);
console.log(`Amount:  ${sendSol} SOL`);
console.log(`Reserve: ${FEE_RESERVE_SOL} SOL (tx fee buffer)`);
console.log("─────────────────────────────────────────");
console.log('\nType CONFIRM to execute, anything else to abort:');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await new Promise((resolve) => rl.question("> ", resolve));
rl.close();

if (answer.trim() !== "CONFIRM") {
  console.log("Aborted.");
  process.exit(0);
}

// ── Execute ───────────────────────────────────────────────────────────
console.log("\nSending...");

const tx = new Transaction().add(
  SystemProgram.transfer({
    fromPubkey: wallet.publicKey,
    toPubkey: new PublicKey(DESTINATION),
    lamports: sendLamports,
  })
);

const signature = await sendAndConfirmTransaction(connection, tx, [wallet]);

console.log(`\n✓ Transfer confirmed`);
console.log(`Signature: ${signature}`);
console.log(`Explorer:  https://solscan.io/tx/${signature}`);
