import { isIP } from "node:net";

function privateIPv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((octet) => octet > 255)) return false;
  const a = octets[0]!;
  const b = octets[1]!;
  const c = octets[2]!;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  return a >= 224;
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return privateIPv4(address.split(".").map(Number));
  }
  if (address.toLowerCase().startsWith("::ffff:")) {
    const v4 = address.slice(7);
    return isIP(v4) === 4 && privateIPv4(v4.split(".").map(Number));
  }
  if (address === "::1" || address === "::") return true;
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || /^fe[89ab]/.test(lower);
}
