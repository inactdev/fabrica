// Incremental reads of an append-only record file (events.jsonl,
// transcript.log). readEvents/readTaskFile read the whole file every
// call, which is right for a one-shot reader (`fabrica log`) and wrong
// for a polling one: `fabrica watch` reads twice a second for as long as
// the Client watches, events.jsonl holds every task the record home has
// ever seen, and heartbeats (one per running task per 15s) make it grow
// steadily while the watch is open. A tail keeps a byte offset and hands
// back only the lines appended since the last call, so a poll costs the
// new bytes, not the file.
//
// Torn reads: the offset only ever advances past the last complete line
// (the last "\n" in what was read), so a line still mid-append is simply
// not returned yet - the next call sees it whole. A newline byte can
// never occur inside a multi-byte UTF-8 sequence, so cutting there can't
// split a character either.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const NEWLINE = 0x0a;

/** A reader over one append-only file. Each call returns the complete
 * lines appended since the previous one, oldest first - `[]` for a file
 * that doesn't exist yet, so a caller can start following a task before
 * its transcript has been written. */
export type LineTail = () => string[];

export function createLineTail(filePath: string): LineTail {
  let offset = 0;

  return () => {
    let fd: number;
    try {
      fd = openSync(filePath, "r");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    try {
      const size = fstatSync(fd).size;
      // Shorter than what we've already consumed means this isn't the
      // same file any more (a record home wiped and recreated under us);
      // read it from the top rather than going silent forever.
      if (size < offset) offset = 0;
      if (size === offset) return [];

      const buffer = Buffer.allocUnsafe(size - offset);
      let read = 0;
      while (read < buffer.byteLength) {
        const got = readSync(fd, buffer, read, buffer.byteLength - read, offset + read);
        if (got === 0) break;
        read += got;
      }
      if (read === 0) return [];

      const lastNewline = buffer.lastIndexOf(NEWLINE, read - 1);
      if (lastNewline === -1) return [];

      offset += lastNewline + 1;
      return buffer.toString("utf8", 0, lastNewline).split("\n");
    } finally {
      closeSync(fd);
    }
  };
}
