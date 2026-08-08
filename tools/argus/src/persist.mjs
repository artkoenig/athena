/**
 * Append-only persistence, one directory per measurement.
 *
 * Every normalized record is appended as JSONL, so a measurement outlives the
 * process that took it and two of them can be compared. The two directions are
 * kept apart deliberately: a running collector only ever appends (`attach`),
 * and reading an old measurement back is a `load` into a store that writes
 * nowhere — which is what makes a reopened measurement impossible to alter by
 * looking at it.
 *
 * Files rotate at a size cap: `<signal>.jsonl` is the live file, `<signal>.1.jsonl`
 * the previous generation. Anything older is dropped, which bounds disk use the
 * same way the in-memory windows bound RAM.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { runDirName } from './config.mjs';

const SIGNALS = ['traces', 'metrics', 'logs'];
/**
 * With raw API bodies on — which the env block turns on by default — `logs.jsonl`
 * passes 64 MB within a few hundred API requests, and only one previous
 * generation is kept. At that cap the start of a measured session would be gone
 * before the run ended, which is exactly the part a scrub back through the
 * timeline wants.
 */
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Create the directory this measurement writes into: `<root>/<timestamp>`,
 * suffixed `-2`, `-3` … when that name is taken, so two runs never share one.
 *
 * The root gets a `.gitignore` holding `*` — a directory that ignores itself.
 * Measuring a project must not show up in its `git status`, and arranging that
 * from here costs nothing, where editing the project's own `.gitignore` would
 * be a change to a file the measurement has no business touching.
 */
export function createRunDir(root, { now = new Date() } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const ignore = path.join(root, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');

  const base = runDirName(now);
  for (let attempt = 1; ; attempt++) {
    const dir = path.join(root, attempt === 1 ? base : `${base}-${attempt}`);
    try {
      // Not `recursive`: the EEXIST is the point — it is what makes two starts
      // in the same second pick two names rather than share one.
      fs.mkdirSync(dir);
      return dir;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
}

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

  /** Every line of one file, oldest generation first, malformed lines skipped. */
  async *#read(signal) {
    for (const generation of [1, 0]) {
      const file = this.#file(signal, generation);
      if (!fs.existsSync(file)) continue;
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // A torn last line after a hard kill is expected; skip it.
          continue;
        }
      }
    }
  }

  #append(signal, lines) {
    if (!lines.length) return;
    const stream = this.#stream(signal);
    let bytes = 0;
    for (const line of lines) {
      bytes += Buffer.byteLength(line);
      stream.write(line);
    }
    const size = (this.sizes.get(signal) ?? 0) + bytes;
    this.sizes.set(signal, size);
    if (size > this.maxBytes) this.#rotate(signal);
  }

  /** Replay everything on disk into `store`, oldest generation first. */
  async load(store) {
    fs.mkdirSync(this.dir, { recursive: true });
    let restored = 0;
    for (const signal of SIGNALS) {
      let batch = [];
      for await (const record of this.#read(signal)) {
        batch.push(record);
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
    return restored;
  }

  /** Persist every future non-replay ingest. */
  attach(store) {
    fs.mkdirSync(this.dir, { recursive: true });
    this.unsubscribe = store.subscribe(({ signal, records, replay }) => {
      if (replay) return;
      if (!records?.length) return;
      this.#append(
        signal,
        records.map((record) => {
          // seq/sessionId are derived on ingest; leave them out so a replay
          // renumbers cleanly against whatever is already in the store.
          const { seq, sessionId, isError, ...rest } = record;
          return `${JSON.stringify(rest)}\n`;
        }),
      );
    });
    return this.unsubscribe;
  }

  close() {
    this.unsubscribe?.();
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
  }
}
