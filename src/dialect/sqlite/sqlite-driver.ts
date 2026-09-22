import type {
  DatabaseConnection,
  QueryResult,
} from '../../driver/database-connection.js'
import {
  type Driver,
  type TransactionCapabilities,
  type TransactionSettings,
} from '../../driver/driver.js'
import { SelectQueryNode } from '../../operation-node/select-query-node.js'
import { parseSavepointCommand } from '../../parser/savepoint-parser.js'
import { CompiledQuery } from '../../query-compiler/compiled-query.js'
import type { QueryCompiler } from '../../query-compiler/query-compiler.js'
import type { AbortableOperationOptions } from '../../util/abort.js'
import { freeze, isFunction } from '../../util/object-utils.js'
import { createQueryId } from '../../util/query-id.js'
import type {
  SqliteDatabase,
  SqliteDialectConfig,
} from './sqlite-dialect-config.js'

export class SqliteDriver implements Driver {
  readonly #config: SqliteDialectConfig

  #db?: SqliteDatabase
  #connection?: DatabaseConnection

  constructor(config: SqliteDialectConfig) {
    this.#config = freeze({ ...config })
  }

  async init(options?: AbortableOperationOptions): Promise<void> {
    this.#db = isFunction(this.#config.database)
      ? await this.#config.database(options)
      : this.#config.database

    this.#connection = new SqliteConnection(this.#db)

    if (this.#config.onCreateConnection) {
      await this.#config.onCreateConnection(this.#connection, options)
    }
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection!
  }

  // SQLite doesn't support isolation levels (a database is always effectively
  // at "serializable") and it doesn't understand access mode clauses in
  // `begin`. Read-only transactions are enforced by Kysely itself, so here we
  // only issue a plain `begin`.
  async beginTransaction(
    connection: DatabaseConnection,
    _settings: TransactionSettings,
  ): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('begin'))
  }

  getTransactionCapabilities(): TransactionCapabilities {
    return SQLITE_TRANSACTION_CAPABILITIES
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'))
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'))
  }

  async savepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        parseSavepointCommand('savepoint', savepointName),
        createQueryId(),
      ),
    )
  }

  async rollbackToSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        parseSavepointCommand('rollback to', savepointName),
        createQueryId(),
      ),
    )
  }

  async releaseSavepoint(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void> {
    await connection.executeQuery(
      compileQuery(
        parseSavepointCommand('release', savepointName),
        createQueryId(),
      ),
    )
  }

  async releaseConnection(): Promise<void> {
    // noop
  }

  async destroy(): Promise<void> {
    this.#db?.close()
  }
}

class SqliteConnection implements DatabaseConnection {
  readonly #db: SqliteDatabase

  constructor(db: SqliteDatabase) {
    this.#db = db
  }

  async executeQuery<O>(compiledQuery: CompiledQuery): Promise<QueryResult<O>> {
    const { sql, parameters } = compiledQuery
    const stmt = this.#db.prepare(sql)

    if (stmt.reader) {
      return {
        rows: stmt.all(parameters) as O[],
      }
    }

    const { changes, lastInsertRowid } = stmt.run(parameters)

    return {
      insertId: lastInsertRowid != null ? BigInt(lastInsertRowid) : undefined,
      numAffectedRows: changes != null ? BigInt(changes) : undefined,
      rows: [],
    }
  }

  async *streamQuery<R>(
    compiledQuery: CompiledQuery,
    _chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    const { sql, parameters, query } = compiledQuery

    const stmt = this.#db.prepare(sql)

    if (!SelectQueryNode.is(query)) {
      throw new Error('Sqlite driver only supports streaming of select queries')
    }

    const iter = stmt.iterate(parameters)

    for (const row of iter) {
      yield {
        rows: [row as R],
      }
    }
  }
}

const SQLITE_TRANSACTION_CAPABILITIES: TransactionCapabilities = freeze({
  // SQLite always uses a single, serialized isolation level and provides no
  // way to select one of the ANSI levels. Asking for one must be rejected at
  // the start instead of being silently ignored.
  supportedIsolationLevels: [],
  // Access modes are enforced by Kysely for SQLite.
  supportedAccessModes: ['read only', 'read write'],
  supportsSavepoints: true,
})
