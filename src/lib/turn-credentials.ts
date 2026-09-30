/**
 * Time-limited TURN credentials, minted in the browser.
 *
 * A TURN relay is what carries a call when the two devices cannot reach each
 * other directly. The free Open Relay server authenticates with a shared secret
 * rather than a fixed username and password: the client sends
 * `username = "<expiry>:<label>"` and `credential = base64(HMAC-SHA1(secret,
 * username))`. That means no account and no key baked into the app — the same
 * scheme Nextcloud Talk and Matrix use.
 *
 * SHA-1 and HMAC are implemented here rather than read from `crypto.subtle`,
 * because `crypto.subtle` is asynchronous and the peer connection needs its
 * configuration the moment it is built.
 */

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** SHA-1 (RFC 3174) over raw bytes. */
export function sha1Bytes(input: Uint8Array): Uint8Array {
  const bits = input.length * 8;
  // message + 0x80 + zero padding + 8-byte length, rounded up to 64 bytes
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Int32Array(80);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getInt32(chunk + i * 4);
    for (let i = 16; i < 80; i += 1) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (n << 1) | (n >>> 31);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }

  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, h0);
  outView.setInt32(4, h1);
  outView.setInt32(8, h2);
  outView.setInt32(12, h3);
  outView.setInt32(16, h4);
  return out;
}

/** HMAC-SHA1 (RFC 2104). */
export function hmacSha1(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let inner = key;
  if (inner.length > blockSize) inner = sha1Bytes(inner);

  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(inner);

  const oKey = new Uint8Array(blockSize);
  const iKey = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    oKey[i] = paddedKey[i] ^ 0x5c;
    iKey[i] = paddedKey[i] ^ 0x36;
  }

  return sha1Bytes(concat(oKey, sha1Bytes(concat(iKey, message))));
}

/** Base64 of raw bytes. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The username and credential a TURN server accepts for the next `ttl` seconds.
 * The expiry is part of the username and is covered by the signature, so a
 * stolen credential stops working when it lapses.
 */
export function mintTurnCredentials(
  secret: string,
  label = "freebuff",
  ttlSeconds = 12 * 60 * 60,
): { username: string; credential: string } {
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = `${expiry}:${label}`;
  const credential = base64(hmacSha1(utf8(secret), utf8(username)));
  return { username, credential };
}
