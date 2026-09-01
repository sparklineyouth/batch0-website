import { crc32 } from "node:zlib";

// Minimal streaming ZIP writer (store-only, no compression).
//
// Why hand-rolled rather than a dependency: this needs exactly one feature —
// concatenate N buffers into a .zip and emit bytes as they're produced. The
// streaming part is not optional. A Vercel function's non-streaming response
// body caps out around 4.5MB, and 50 STLs is ~28MB, so buffering the whole
// archive and returning it would fail at roughly card eight. Emitting each
// entry as it's exported also means the browser's download starts immediately
// instead of after two minutes of apparent hang.
//
// Store-only (no deflate) is a deliberate trade: binary STL is mostly float
// coordinates and compresses poorly, so deflate would cost CPU inside a
// time-limited function to shave little. Every unzip tool reads stored entries.
//
// Format: APPNOTE.TXT 4.3.6 — local header + data per entry, then a central
// directory, then the EOCD record. No zip64 (see the guard in addFile).

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// Smallest version that reads stored entries.
const VERSION = 20;

type Entry = {
  name: string;
  crc: number;
  size: number;
  offset: number;
};

/**
 * Build a ZIP incrementally, yielding byte chunks as entries are added.
 *
 * Usage:
 *   const zip = new ZipStream();
 *   yield zip.addFile("card-001.stl", buf);   // emits header + data
 *   yield zip.finish();                        // emits central directory
 */
export class ZipStream {
  private entries: Entry[] = [];
  private offset = 0;

  /** Emit one stored file. Returns the bytes to write for it. */
  addFile(name: string, data: Buffer): Buffer {
    // zip64 would be needed past 4GB. A card batch is megabytes, so rather
    // than implement it, refuse loudly — a silently truncated archive is far
    // worse than an error.
    if (data.length > 0xffffffff) {
      throw new Error(`zip: ${name} exceeds 4GB; zip64 is not implemented`);
    }

    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(LOCAL_SIG, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(0, 8); // method 0 = stored
    header.writeUInt16LE(0, 10); // mod time — fixed, see note in finish()
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18); // compressed size
    header.writeUInt32LE(data.length, 22); // uncompressed size
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28); // extra field length

    this.entries.push({ name, crc, size: data.length, offset: this.offset });
    const chunk = Buffer.concat([header, nameBuf, data]);
    this.offset += chunk.length;
    return chunk;
  }

  /** Emit the central directory + EOCD. Call once, after the last addFile. */
  finish(): Buffer {
    const parts: Buffer[] = [];
    const dirStart = this.offset;

    for (const e of this.entries) {
      const nameBuf = Buffer.from(e.name, "utf8");
      const rec = Buffer.alloc(46);
      rec.writeUInt32LE(CENTRAL_SIG, 0);
      rec.writeUInt16LE(VERSION, 4); // version made by
      rec.writeUInt16LE(VERSION, 6); // version needed
      rec.writeUInt16LE(0, 8); // flags
      rec.writeUInt16LE(0, 10); // method 0 = stored
      // Timestamps are left at zero. They'd encode when the archive was built,
      // which is neither reproducible nor interesting for a card batch, and a
      // zero date is well-tolerated by unzip tools.
      rec.writeUInt16LE(0, 12);
      rec.writeUInt16LE(0, 14);
      rec.writeUInt32LE(e.crc, 16);
      rec.writeUInt32LE(e.size, 20);
      rec.writeUInt32LE(e.size, 24);
      rec.writeUInt16LE(nameBuf.length, 28);
      rec.writeUInt16LE(0, 30); // extra
      rec.writeUInt16LE(0, 32); // comment
      rec.writeUInt16LE(0, 34); // disk number
      rec.writeUInt16LE(0, 36); // internal attrs
      rec.writeUInt32LE(0, 38); // external attrs
      rec.writeUInt32LE(e.offset, 42);
      parts.push(rec, nameBuf);
    }

    const dirBytes = parts.reduce((n, p) => n + p.length, 0);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(0, 4); // disk number
    eocd.writeUInt16LE(0, 6); // disk with central dir
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(dirBytes, 12);
    eocd.writeUInt32LE(dirStart, 16);
    eocd.writeUInt16LE(0, 20); // comment length
    parts.push(eocd);

    return Buffer.concat(parts);
  }
}
