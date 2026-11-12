import nacl from "tweetnacl";
import { createHash, randomBytes } from "node:crypto";
import { Keypair } from "./types.ts";

const ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function b58encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return (
    "1".repeat(zeros) +
    digits
      .reverse()
      .map((d) => ALPHABET[d])
      .join("")
  );
}

export function b58decode(str: string): Uint8Array {
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    let carry = ALPHABET.indexOf(str[i]);
    if (carry < 0) throw new Error("bad base58");
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  return new Uint8Array([...Array(zeros).fill(0), ...bytes.reverse()]);
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function safeHash(safe: Record<string, string>): string {
  const ordered = Object.keys(safe)
    .sort()
    .map((k) => [k, safe[k]]);
  return sha256Hex(JSON.stringify(ordered));
}

export interface Challenge {
  nonce: string;
  account: string;
  safeHash: string;
  mode: "PANIC" | "DRILL";
  issuedAt: string;
  message: string;
}

export function newChallenge(
  account: string,
  safe: Record<string, string>,
  mode: "PANIC" | "DRILL",
): Challenge {
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  const hash = safeHash(safe);
  const message = [
    "PANIC",
    "v1",
    `account:${account}`,
    `safe:${hash}`,
    `mode:${mode}`,
    `nonce:${nonce}`,
    `iat:${issuedAt}`,
  ].join("|");
  return { nonce, account, safeHash: hash, mode, issuedAt, message };
}

export function verifySignature(
  message: string,
  signatureB64: string,
  pubKeyB58: string,
): boolean {
  try {
    const sig = Buffer.from(signatureB64, "base64");
    const pub = b58decode(pubKeyB58);
    if (sig.length !== 64 || pub.length !== 32) return false;
    return nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      new Uint8Array(sig),
      pub,
    );
  } catch {
    return false;
  }
}

export function newKeypair(): Keypair {
  const kp = nacl.sign.keyPair();
  return {
    publicKey: b58encode(kp.publicKey),
    secretKey: b58encode(kp.secretKey),
  };
}

export function receiptHash(parts: (string | number)[]): string {
  return sha256Hex(parts.join("|"));
}
