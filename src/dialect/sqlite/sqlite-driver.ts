import type {
  DatabaseConnection,
  QueryResult,
} from '../../driver/database-connection.js'
import type {
  Driver,
  TransactionCapabilities,
  TransactionSettings,
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
  readonly #transactionPragmas = new WeakMap<
    DatabaseConnection,
    { readUncommitted: boolean; queryOnly: boolean }
  >()

  get supportsTransactionSettings(): TransactionCapabilities {
    return {
      // SQLite is serializable by default. `read uncommitted` can be
      // enabled through the `read_uncommitted` pragma. The other levels
      // don't exist in SQLite and must be rejected instead of silently
      // running as serializable.
      isolationLevels: ['serializable', 'read uncommitted'],
      accessModes: ['read only', 'read write'],
    }
  }

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

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    const pragmas = { readUncommitted: false, queryOnly: false }

    if (settings.isolationLevel === 'read uncommitted') {
      await connection.executeQuery(
        CompiledQuery.raw('pragma read_uncommitted = true'),
      )
      pragmas.readUncommitted = true
    }

    if (settings.accessMode === 'read only') {
      await connection.executeQuery(
        CompiledQuery.raw('pragma query_only = true'),
      )
      pragmas.queryOnly = true
    }

    this.#transactionPragmas.set(connection, pragmas)

    await connection.executeQuery(CompiledQuery.raw('begin'))
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('commit'))
    await this.#resetTransactionSettings(connection)
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw('rollback'))
    await this.#resetTransactionSettings(connection)
  }

  // SQLite's transaction settings are implemented using connection-level
  // pragmas. They need to be reset when the transaction ends so that
  // later statements on the pooled (shared, in SQLite's case) connection
  // run outside a transaction with the default settings.
  async #resetTransactionSettings(
    connection: DatabaseConnection,
  ): Promise<void> {
    const pragmas = this.#transactionPragmas.get(connection)

    if (!pragmas) {
      return
    }

    this.#transactionPragmas.delete(connection)

    if (pragmas.readUncommitted) {
      await connection.executeQuery(
        CompiledQuery.raw('pragma read_uncommitted = false'),
      )
    }

    if (pragmas.queryOnly) {
      await connection.executeQuery(
        CompiledQuery.raw('pragma query_only = false'),
      )
    }
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
