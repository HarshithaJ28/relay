/**
 * Endpoint URL checks when an endpoint is saved (spec section 7). The data plane checks again,
 * and resolves DNS itself, on every attempt (relay_dataplane/destination.py); this is the same
 * rule set, so a URL refused here is refused there, and the shared corpus in
 * tests/fixtures/ssrf_corpus.json is run against both.
 */
import { lookup } from "node:dns/promises";
import { domainToASCII } from "node:url";
import ipaddr from "ipaddr.js";

export class BlockedDestination extends Error {}

export interface DestinationPolicy {
  allowHttp: boolean;
  allowPrivate: boolean;
  allowedPorts: Set<number>;
}

export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const nets = (...cidrs: string[]) => cidrs.map((c) => ipaddr.parseCIDR(c));

// Never allowed, not even with private targets allowed (same lists as destination.py).
const ALWAYS_BLOCKED = nets(
  "0.0.0.0/8",
  "169.254.0.0/16",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/32",
  "2001:db8::/32",
  "2002::/16",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  "fd00:ec2::254/128",
);
const PRIVATE = nets(
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "::1/128",
  "fc00::/7",
);
const GLOBAL_RANGES = new Set(["unicast"]);

function within(addr: ipaddr.IPv4 | ipaddr.IPv6, list: [ipaddr.IPv4 | ipaddr.IPv6, number][]): boolean {
  return list.some(([net, bits]) => net.kind() === addr.kind() && addr.match(net, bits));
}

export function checkIp(text: string, policy: DestinationPolicy): void {
  if (text.includes("%")) throw new BlockedDestination(`scoped IPv6 address ${text}`);
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(text);
  } catch {
    throw new BlockedDestination(`not an IP address: ${text}`);
  }
  if (addr.kind() === "ipv6") {
    const value = BigInt(
      `0x${(addr as ipaddr.IPv6)
        .toNormalizedString()
        .split(":")
        .map((p) => p.padStart(4, "0"))
        .join("")}`,
    );
    if (value > 1n && value < 2n ** 32n) throw new BlockedDestination(`IPv4-compatible address ${text}`);
  }
  if (within(addr, ALWAYS_BLOCKED)) throw new BlockedDestination(`address ${text} is in a blocked range`);
  if (within(addr, PRIVATE)) {
    if (policy.allowPrivate) return;
    throw new BlockedDestination(`address ${text} is private, loopback or shared`);
  }
  if (!GLOBAL_RANGES.has(addr.range()))
    throw new BlockedDestination(`address ${text} is not globally routable`);
}

const NUMERIC_LABEL = /^(0x[0-9a-f]*|[0-9]+)$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export interface Target {
  scheme: "https" | "http";
  host: string;
  port: number;
  isIp: boolean;
}

/** Check a URL without any network access. */
export function checkUrl(url: string, policy: DestinationPolicy): Target {
  const text = url.trim();
  // Characters URL parsers disagree about, or silently drop: refuse them outright.
  if (/[\\\s]|\p{Cc}|\p{Cf}/u.test(text))
    throw new BlockedDestination("URL contains characters that are not allowed");
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)?.[1];
  if (authority === undefined) throw new BlockedDestination("URL must be absolute");
  if (authority.includes("@")) throw new BlockedDestination("credentials in the URL are not allowed");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new BlockedDestination("invalid URL");
  }
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme !== "https" && !(scheme === "http" && policy.allowHttp)) {
    throw new BlockedDestination(`scheme ${scheme} is not allowed`);
  }
  const port = parsed.port ? Number(parsed.port) : scheme === "https" ? 443 : 80;
  if (!policy.allowedPorts.has(port)) throw new BlockedDestination(`port ${port} is not allowed`);

  const rawHost = authority.replace(/:\d*$/, "").replace(/^\[|\]$/g, "");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new BlockedDestination("URL has no host");
  if (ipaddr.isValid(rawHost) || ipaddr.isValid(host)) {
    // The parser may have turned 2130706433, 0x7f.1 or 0177.0.0.1 into dotted form: check
    // what it will actually connect to.
    if (!ipaddr.isValid(rawHost) || ipaddr.parse(rawHost).toString() !== ipaddr.parse(host).toString()) {
      throw new BlockedDestination(`host ${rawHost} is a numeric IPv4 form`);
    }
    checkIp(host, policy);
    return { scheme: scheme as Target["scheme"], host, port, isIp: true };
  }
  const ascii = domainToASCII(rawHost.toLowerCase().replace(/\.$/, ""));
  if (!ascii || ascii !== host.replace(/\.$/, ""))
    throw new BlockedDestination("host is not a valid domain name");
  const labels = ascii.split(".");
  if (ascii.length > 253 || !labels.every((l) => HOST_LABEL.test(l))) {
    throw new BlockedDestination("host is not a valid domain name");
  }
  if (NUMERIC_LABEL.test(labels[labels.length - 1] as string)) {
    throw new BlockedDestination(`host ${rawHost} is a numeric IPv4 form`);
  }
  return { scheme: scheme as Target["scheme"], host: ascii, port, isIp: false };
}

/** Check the URL, then everything its host resolves to right now (spec: also checked at save time). */
export async function checkDestination(
  url: string,
  policy: DestinationPolicy,
  resolve: Resolver,
): Promise<Target> {
  const target = checkUrl(url, policy);
  if (target.isIp) return target;
  let addresses: string[];
  try {
    addresses = await resolve(target.host);
  } catch {
    throw new BlockedDestination(`host ${target.host} does not resolve`);
  }
  if (addresses.length === 0) throw new BlockedDestination(`host ${target.host} does not resolve`);
  for (const address of addresses) checkIp(address, policy);
  return target;
}
