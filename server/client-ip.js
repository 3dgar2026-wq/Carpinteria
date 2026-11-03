import { isIP } from 'node:net';

function normalizeIpv6(value) {
  const lower = value.toLowerCase();
  const halves = lower.split('::');
  if (halves.length > 2) return null;

  const parseHalf = (half) => {
    if (!half) return [];
    const parts = half.split(':');
    const last = parts.at(-1);
    if (last?.includes('.')) {
      if (isIP(last) !== 4) return null;
      const octets = last.split('.').map(Number);
      parts.splice(-1, 1, ((octets[0] << 8) | octets[1]).toString(16), ((octets[2] << 8) | octets[3]).toString(16));
    }
    if (parts.some((part) => !/^[a-f\d]{1,4}$/.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };

  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  if (groups.length !== 8) return null;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }

  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== 0) { index += 1; continue; }
    let end = index;
    while (end < groups.length && groups[end] === 0) end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }

  if (bestStart < 0) return groups.map((group) => group.toString(16)).join(':');
  const before = groups.slice(0, bestStart).map((group) => group.toString(16)).join(':');
  const after = groups.slice(bestStart + bestLength).map((group) => group.toString(16)).join(':');
  return `${before}::${after}`;
}

export function normalizeClientIp(value) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes(',')) return null;
  if (isIP(value) === 4) return value.split('.').map((part) => String(Number(part))).join('.');
  if (isIP(value) !== 6) return null;

  const mappedIpv4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  if (mappedIpv4 && isIP(mappedIpv4[1]) === 4) {
    return mappedIpv4[1].split('.').map((part) => String(Number(part))).join('.');
  }
  return normalizeIpv6(value);
}

export function resolveClientIp(request, env = process.env) {
  // Render's public and private traffic reaches the same HTTP listener. The
  // application cannot verify that a CF-Connecting-IP header came from its
  // public Cloudflare path, so never treat forwarded IP headers as identity.
  if (env.RENDER === 'true') return null;

  // Direct local/dev mode: use only the TCP peer.
  return normalizeClientIp(request.socket?.remoteAddress);
}
