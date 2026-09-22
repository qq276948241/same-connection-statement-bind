import type { QueryCompiler } from '../query-compiler/query-compiler.js'
import type { ArrayItemType } from '../util/type-utils.js'
import type { DatabaseConnection } from './database-connection.js'
import type { AbortableOperationOptions } from '../util/abort.js'

/**
 * A Driver creates and releases {@link DatabaseConnection | database connections}
 * and is also responsible for connection pooling (if the dialect supports pooling).
 */
export interface Driver {
  /**
   * Initializes the driver.
   *
   * After calling this method the driver should be usable and `acquireConnection` etc.
   * methods should be callable.
   */
  init(options?: AbortableOperationOptions): Promise<void>

  /**
   * Acquires a new connection from the pool.
   */
  acquireConnection(
    options?: AbortableOperationOptions,
  ): Promise<DatabaseConnection>

  /**
   * Begins a transaction.
   */
  beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void>

  /**
   * Describes the transaction settings this driver can honor.
   *
   * When omitted, the driver is assumed to support all valid settings.
   * When provided, Kysely rejects unsupported settings before the
   * transaction begins instead of silently downgrading them.
   */
  readonly supportsTransactionSettings?: TransactionCapabilities

  /**
   * Commits a transaction.
   */
  commitTransaction(connection: DatabaseConnection): Promise<void>

  /**
   * Rolls back a transaction.
   */
  rollbackTransaction(connection: DatabaseConnection): Promise<void>

  /**
   * Establishses a new savepoint within a transaction.
   */
  savepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void>

  /**
   * Rolls back to a savepoint within a transaction.
   */
  rollbackToSavepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void>

  /**
   * Releases a savepoint within a transaction.
   */
  releaseSavepoint?(
    connection: DatabaseConnection,
    savepointName: string,
    compileQuery: QueryCompiler['compileQuery'],
  ): Promise<void>

  /**
   * Releases a connection back to the pool.
   */
  releaseConnection(
    connection: DatabaseConnection,
    options?: AbortableOperationOptions,
  ): Promise<void>

  /**
   * Destroys the driver and releases all resources.
   */
  destroy(options?: AbortableOperationOptions): Promise<void>
}

export interface TransactionSettings {
  readonly accessMode?: AccessMode
  readonly isolationLevel?: IsolationLevel
}

/**
 * Describes the transaction settings a {@link Driver} is able to honor.
 *
 * If a setting is listed as unsupported and the caller asks for it, the
 * driver rejects the transaction when it begins instead of silently
 * starting the transaction with different settings.
 *
 * Third party drivers don't have to provide this object: when it's not
 * provided, Kysely assumes the driver can honor any valid setting.
 */
export interface TransactionCapabilities {
  readonly isolationLevels?: readonly IsolationLevel[]
  readonly accessModes?: readonly AccessMode[]
}

export const TRANSACTION_ACCESS_MODES = ['read only', 'read write'] as const

export type AccessMode = ArrayItemType<typeof TRANSACTION_ACCESS_MODES>

export const TRANSACTION_ISOLATION_LEVELS = [
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
  'snapshot',
] as const

export type IsolationLevel = ArrayItemType<typeof TRANSACTION_ISOLATION_LEVELS>

export function validateTransactionSettings(
  settings: TransactionSettings,
): void {
  if (
    settings.accessMode &&
    !TRANSACTION_ACCESS_MODES.includes(settings.accessMode)
  ) {
    throw new Error(`invalid transaction access mode ${settings.accessMode}`)
  }

  if (
    settings.isolationLevel &&
    !TRANSACTION_ISOLATION_LEVELS.includes(settings.isolationLevel)
  ) {
    throw new Error(
      `invalid transaction isolation level ${settings.isolationLevel}`,
    )
  }
}

/**
 * Makes sure the driver can honor the given transaction settings.
 *
 * Throws before the transaction is started if the driver doesn't support
 * the requested isolation level or access mode, so that the settings are
 * never silently downgraded.
 */
export function assertTransactionSettingsSupported(
  driver: Driver,
  settings: TransactionSettings,
  dialectName?: string,
): void {
  const capabilities = driver.supportsTransactionSettings

  if (!capabilities) {
    return
  }

  const prefix = dialectName ? `the ${dialectName} dialect` : 'this dialect'

  if (
    settings.isolationLevel &&
    capabilities.isolationLevels !== undefined &&
    !capabilities.isolationLevels.includes(settings.isolationLevel)
  ) {
    throw new Error(
      `${prefix} does not support the "${settings.isolationLevel}" transaction isolation level`,
    )
  }

  if (
    settings.accessMode &&
    capabilities.accessModes !== undefined &&
    !capabilities.accessModes.includes(settings.accessMode)
  ) {
    throw new Error(
      `${prefix} does not support "${settings.accessMode}" transactions`,
    )
  }
}
