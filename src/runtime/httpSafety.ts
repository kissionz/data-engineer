import { lookup as dnsLookup } from "node:dns";
import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface LookupAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

const blockedAddresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["fc00::", 7],
  ["fe80::", 10],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["3fff::", 20],
  ["5f00::", 16],
  ["ff00::", 8],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function canonicalHostname(hostname: string): string {
  const withoutBrackets =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  const ascii = domainToASCII(withoutBrackets.replace(/\.$/, "")).toLowerCase();
  if (!ascii) {
    throw new Error("URL hostname is invalid.");
  }
  return ascii;
}

export function assertAllowedAddress(
  address: string,
  options: { allowLoopback: boolean },
): void {
  const family = isIP(address);
  if (family === 0) {
    throw new Error(`DNS returned an invalid IP address: ${address}`);
  }

  // IPv4-mapped IPv6 addresses must be checked as IPv4 as well.
  const mapped = mappedIpv4Address(address);
  if (mapped) {
    assertAllowedAddress(mapped, options);
    return;
  }

  const blocked = blockedAddresses.check(
    address,
    family === 4 ? "ipv4" : "ipv6",
  );
  if (blocked && !(options.allowLoopback && isLoopback(address))) {
    throw new Error(`Connection to non-public IP address ${address} is denied.`);
  }
}

export function isLoopback(address: string): boolean {
  if (address === "::1") {
    return true;
  }
  const ipv4 = mappedIpv4Address(address) ?? address;
  return isIP(ipv4) === 4 && ipv4.startsWith("127.");
}

function mappedIpv4Address(address: string): string | undefined {
  const normalized = address.toLowerCase();
  const suffix = normalized.match(
    /^(?:::ffff:|(?:0:){5}ffff:)(.+)$/,
  )?.[1];
  if (!suffix) {
    return undefined;
  }
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const words = suffix.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!words) {
    return undefined;
  }
  const high = Number.parseInt(words[1], 16);
  const low = Number.parseInt(words[2], 16);
  return [
    high >>> 8,
    high & 0xff,
    low >>> 8,
    low & 0xff,
  ].join(".");
}

export const resolveHost: ResolveHost = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(
        addresses.map(({ address, family }) => ({
          address,
          family: family as 4 | 6,
        })),
      );
    });
  });
