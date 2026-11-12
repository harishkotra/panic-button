import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { PanicRecord, Policy } from "./types.ts";

const DATA = process.env.DATA_DIR ? process.env.DATA_DIR : join(process.cwd(), "data");

function ensure(file: string) {
  mkdirSync(dirname(file), { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  ensure(file);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

const policyFile = join(DATA, "policy.json");
const panicFile = join(DATA, "panics.json");
const lastPanicFile = join(DATA, "last-panic.json");

export function getPolicy(): Policy | null {
  return readJson<Policy | null>(policyFile, null);
}

export function savePolicy(p: Policy) {
  writeJson(policyFile, p);
}

export function listPanics(limit = 50): PanicRecord[] {
  const all = readJson<PanicRecord[]>(panicFile, []);
  return all.slice(0, limit);
}

export function appendPanic(p: PanicRecord) {
  const all = readJson<PanicRecord[]>(panicFile, []);
  all.unshift(p);
  writeJson(panicFile, all.slice(0, 500));
}

export function lastPanicAt(account: string): number {
  const all = readJson<PanicRecord[]>(panicFile, []);
  const hit = all.find((p) => p.account === account && p.verdict === "ARMED");
  return hit ? Date.parse(hit.createdAt) : 0;
}

export function getPanic(id: string): PanicRecord | null {
  return listPanics(500).find((p) => p.id === id) ?? null;
}
