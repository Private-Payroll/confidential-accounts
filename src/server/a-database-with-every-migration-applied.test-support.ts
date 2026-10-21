/**
 * **A DATABASE THAT ANSWERS ONE QUESTION: WHICH MIGRATIONS HAVE BEEN APPLIED.**
 *
 * The service asks the database, before it listens, whether every migration in
 * `db/migrations` has been applied, and does not start if it cannot be told.
 * A test that starts the service to see what it prints about its settings has
 * to give it a database that can be asked, but not a real one: this listens on
 * a port of its own, speaks as much of the database's wire protocol as the
 * driver needs to connect and ask, and says that every migration the folder
 * holds is applied. Any other question gets no rows.
 *
 * It is not a database: it keeps nothing, runs nothing and answers nothing but
 * that one question and the driver's own look at the database's types.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { readMigrations } from '../db/migrate.js';

const TEXT = 25;
const INT4 = 23;

const message = (type: string, body: Buffer = Buffer.alloc(0)): Buffer => {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const cstring = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);

const rowDescription = (columns: ReadonlyArray<{ name: string; oid: number }>): Buffer =>
  message('T', Buffer.concat([
    int16(columns.length),
    ...columns.map(c => Buffer.concat([cstring(c.name), int32(0), int16(0), int32(c.oid), int16(-1), int32(-1), int16(0)])),
  ]));
const dataRow = (values: ReadonlyArray<string>): Buffer =>
  message('D', Buffer.concat([int16(values.length), ...values.map(v => Buffer.concat([int32(Buffer.byteLength(v)), Buffer.from(v, 'utf8')]))]));

type Answer = { columns: Array<{ name: string; oid: number }>; rows: string[][]; tag: string };

/** What a question gets: the applied migrations for the one question, nothing for any other. */
function answerTo(query: string, dir: string | undefined): Answer {
  if (/\bschema_migrations\b/i.test(query) && /^\s*select\b/i.test(query)) {
    return {
      columns: [{ name: 'version', oid: TEXT }, { name: 'name', oid: TEXT }, { name: 'checksum', oid: TEXT }],
      rows: readMigrations(dir).map(m => [m.version, m.name, m.checksum]),
      tag: 'SELECT',
    };
  }
  if (/\bpg_type\b/i.test(query)) return { columns: [{ name: 'oid', oid: INT4 }, { name: 'typarray', oid: INT4 }], rows: [], tag: 'SELECT 0' };
  return { columns: [], rows: [], tag: 'OK' };
}

const parameterCount = (query: string): number => Math.max(0, ...[...query.matchAll(/\$(\d+)/g)].map(m => Number(m[1])));

function serve(socket: Socket, dir: string | undefined): void {
  let buffer = Buffer.alloc(0);
  let started = false;
  const statements = new Map<string, string>();
  const portals = new Map<string, string>();
  const send = (...parts: Buffer[]): void => { socket.write(Buffer.concat(parts)); };
  const describe = (query: string): Buffer => {
    const { columns } = answerTo(query, dir);
    return columns.length === 0 ? message('n') : rowDescription(columns);
  };
  const run = (query: string): Buffer => {
    const { columns, rows, tag } = answerTo(query, dir);
    return Buffer.concat([...rows.map(dataRow), message('C', cstring(columns.length === 0 ? tag : `SELECT ${rows.length}`))]);
  };

  const handle = (type: string, body: Buffer): void => {
    if (type === 'P') {
      const name = body.subarray(0, body.indexOf(0)).toString();
      const rest = body.subarray(name.length + 1);
      statements.set(name, rest.subarray(0, rest.indexOf(0)).toString());
      send(message('1'));
    } else if (type === 'D') {
      const kind = String.fromCharCode(body[0]!);
      const name = body.subarray(1, body.indexOf(0, 1)).toString();
      if (kind === 'S') {
        const query = statements.get(name) ?? '';
        send(message('t', Buffer.concat([int16(parameterCount(query)), ...Array.from({ length: parameterCount(query) }, () => int32(0))])), describe(query));
      } else {
        send(describe(statements.get(portals.get(name) ?? '') ?? ''));
      }
    } else if (type === 'B') {
      const portal = body.subarray(0, body.indexOf(0)).toString();
      const rest = body.subarray(portal.length + 1);
      portals.set(portal, rest.subarray(0, rest.indexOf(0)).toString());
      send(message('2'));
    } else if (type === 'E') {
      const portal = body.subarray(0, body.indexOf(0)).toString();
      send(run(statements.get(portals.get(portal) ?? '') ?? ''));
    } else if (type === 'S') {
      send(message('Z', Buffer.from('I')));
    } else if (type === 'Q') {
      const query = body.subarray(0, body.length - 1).toString();
      const { columns } = answerTo(query, dir);
      send(columns.length === 0 ? Buffer.alloc(0) : rowDescription(columns), run(query), message('Z', Buffer.from('I')));
    } else if (type === 'X') {
      socket.end();
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (!started) {
        if (buffer.length < 8) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const code = buffer.readInt32BE(4);
        buffer = buffer.subarray(length);
        if (code === 80877103) { socket.write('N'); continue; }
        started = true;
        send(message('R', int32(0)), message('S', Buffer.concat([cstring('server_version'), cstring('16.0')])),
          message('K', Buffer.concat([int32(1), int32(1)])), message('Z', Buffer.from('I')));
        continue;
      }
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      const type = String.fromCharCode(buffer[0]!);
      const body = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      handle(type, body);
    }
  });
  socket.on('error', () => {});
}

/** A database on a port of its own, saying every migration in `dir` is applied; `url` is the address to give the service. */
export async function aDatabaseWithEveryMigrationApplied(dir?: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const open = new Set<Socket>();
  const server: Server = createServer(socket => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    serve(socket, dir);
  });
  await new Promise<void>(up => { server.listen(0, '127.0.0.1', up); });
  const { port } = server.address() as { port: number };
  return {
    url: `postgres://u:p@127.0.0.1:${port}/applied`,  // not-a-secret: a port this process is listening on
    stop: () => new Promise<void>(down => { server.close(() => down()); for (const s of open) s.destroy(); }),
  };
}
