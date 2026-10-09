// Rasterizes the app icon to PNG (192/512) with zero dependencies: rounded dark
// square + ring, matching public/icons/icon.svg. Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function png(size) {
  const px = new Uint8Array(size * size * 4);
  const bg = [0x11, 0x18, 0x27], ring = [0x63, 0x66, 0xf1], arc = [0x22, 0xc5, 0x5e];
  const r = size * 0.22, cx = size / 2, cy = size / 2;
  const R = size * 0.293, W = size * 0.086;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded square mask
      const dx = Math.max(Math.abs(x - cx) - (size / 2 - r), 0), dy = Math.max(Math.abs(y - cy) - (size / 2 - r), 0);
      const inside = Math.hypot(dx, dy) <= r;
      if (!inside) continue;
      let c = bg;
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - R) <= W / 2) {
        const ang = Math.atan2(y - cy, x - cx); // -π..π, 0 = east, -π/2 = north
        c = ang >= -Math.PI / 2 && ang <= 0 ? arc : ring;
      }
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255;
    }
  }
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(px.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

const table = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

for (const s of [192, 512]) writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), png(s));
console.log("icons written");
