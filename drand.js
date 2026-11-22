// drand quicknet clients with automatic fallback across several public mirrors,
// so one server being slow or down doesn't break sealing or opening doors.
//
// Every mirror is pinned to quicknet's chain hash and public key, and beacons are
// verified, so a misbehaving mirror can't trick anyone into opening a door early.
import { HttpChainClient, HttpCachingChain, defaultChainInfo } from "tlock-js";

const MIRRORS = [
  "https://api.drand.sh",
  "https://drand.cloudflare.com",
  "https://api2.drand.sh",
  "https://api3.drand.sh",
];

const options = {
  disableBeaconVerification: false,
  noCache: false,
  chainVerificationParams: { chainHash: defaultChainInfo.hash, publicKey: defaultChainInfo.public_key },
};

const clients = MIRRORS.map((base) => {
  const chain = new HttpCachingChain(`${base}/${defaultChainInfo.hash}`, options);
  return new HttpChainClient(chain, options);
});

let preferred = 0;
const isTooEarly = (err) => /too early/i.test(err?.message ?? "");

// Runs fn(client) against each mirror until one works. "Too early" errors are
// real answers (the day hasn't come), not network trouble, so they're thrown
// straight away.
export async function withDrand(fn) {
  let lastErr;
  for (let i = 0; i < clients.length; i++) {
    const idx = (preferred + i) % clients.length;
    try {
      const result = await fn(clients[idx]);
      preferred = idx;
      return result;
    } catch (err) {
      if (isTooEarly(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}
