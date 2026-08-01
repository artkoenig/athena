/**
 * Optional append-only persistence.
 *
 * Cloud sandboxes get recycled, and losing a session's telemetry to a container
 * restart defeats the point of watching it. When `--persist <dir>` is set, every
 * normalized record is appended as JSONL and replayed into the store on the next
 * start, so session history survives a restart without introducing a database.
 *
 * Files rotate at a size cap: `<signal>.jsonl` is the live file, `<signal>.1.jsonl`
 * the previous generation. Anything older is dropped, which bounds disk use the
 * same way the in-memory windows bound RAM.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const SIGNALS = ['traces', 'metrics', 'logs'];
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class JsonlPersistence {
  constructor(dir, { maxBytes = DEFAULT_MAX_BYTES, log = () => {} } = {}) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.log = log;
    this.streams = new Map();
    this.sizes = new Map();
    this.unsubscribe = null;
  }

  #file(signal, generation = 0) {
    return path.join(this.dir, generation ? `${signal}.${generation}.jsonl` : `${signal}.jsonl`);
  }

  #stream(signal) {
    let stream = this.streams.get(signal);
    if (!stream) {
      // Open the fd eagerly: createWriteStream opens lazily, so the file would
      // not exist yet if the size cap tripped before the first flush and
      // rotation would fail with ENOENT.
      const fd = fs.openSync(this.#file(signal), 'a');
      this.sizes.set(signal, fs.fstatSync(fd).size);
      stream = fs.createWriteStream(null, { fd, autoClose: true });
      stream.on('error', (error) => this.log(`persist: write failed (${error.message})`));
      this.streams.set(signal, stream);
    }
    return stream;
  }

  #rotate(signal) {
    const stream = this.streams.get(signal);
    if (stream) stream.end();
    this.streams.delete(signal);
    try {
      fs.rmSync(this.#file(signal, 1), { force: true });
      fs.renameSync(this.#file(signal), this.#file(signal, 1));
    } catch (error) {
      this.log(`persist: rotate failed (${error.message})`);
    }
    this.sizes.set(signal, 0);
  }

  /** Replay everything on disk into `store`, oldest generation first. */
  async load(store) {
    fs.mkdirSync(this.dir, { recursive: true });
    let restored = 0;
    for (const signal of SIGNALS) {
      for (const generation of [1, 0]) {
        const file = this.#file(signal, generation);
        if (!fs.existsSync(file)) continue;
        const rl = readline.createInterface({
          input: fs.createReadStream(file),
          crlfDelay: Infinity,
        });
        let batch = [];
        for await (const line of rl) {
          if (!line) continue;
          try {
            batch.push(JSON.parse(line));
          } catch {
            // A torn last line after a hard kill is expected; skip it.
            continue;
          }
          if (batch.length >= 500) {
            store.ingest(signal, batch, { replay: true });
            restored += batch.length;
            batch = [];
          }
        }
        if (batch.length) {
          store.ingest(signal, batch, { replay: true });
          restored += batch.length;
        }
      }
    }
    return restored;
  }

  /** Persist every future non-replay ingest. */
  attach(store) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.unsubscribe = store.subscribe(({ signal, records, replay }) => {
      if (replay || !records?.length) return;
      const stream = this.#stream(signal);
      let bytes = 0;
      for (const record of records) {
        // seq/sessionId are derived on ingest; leave them out so a replay
        // renumbers cleanly against whatever is already in the store.
        const { seq, sessionId, isError, ...rest } = record;
        const line = `${JSON.stringify(rest)}\n`;
        bytes += Buffer.byteLength(line);
        stream.write(line);
      }
      const size = (this.sizes.get(signal) ?? 0) + bytes;
      this.sizes.set(signal, size);
      if (size > this.maxBytes) this.#rotate(signal);
    });
    return this.unsubscribe;
  }

  close() {
    this.unsubscribe?.();
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
  }
}
