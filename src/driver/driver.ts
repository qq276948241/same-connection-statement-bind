import type { QueryCompiler } from '../query-compiler/query-compiler.js'
import type { ArrayItemType } from '../util/type-utils.js'
import type { DatabaseConnection } from './database-connection.js'
import type { AbortableOperationOptions } from '../util/abort.js'
import { freeze } from '../util/object-utils.js'

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
   *
   * The settings have already been validated against
   * {@link Driver.getTransactionCapabilities} before this is called, so the
   * implementation never needs to silently downgrade them.
   */
  beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void>

  /**
   * Returns the transaction features (isolation levels, access modes and
   * savepoint support) this driver can honor. Kysely validates the caller's
   * transaction settings against these capabilities before beginning a
   * transaction.
   *
   * Drivers that don't implement this method are assumed to support all
   * standard settings for backwards compatibility.
   */
  getTransactionCapabilities?(): TransactionCapabilities

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
 * Describes the transaction features a {@link Driver} supports.
 *
 * Kysely uses this information to reject transaction settings a dialect
 * can't honor before the transaction is begun instead of silently
 * downgrading them and reporting success.
 */
export interface TransactionCapabilities {
  /**
   * The isolation levels the dialect can enforce.
   */
  readonly supportedIsolationLevels: readonly IsolationLevel[]

  /**
   * The access modes (`read only` / `read write`) the dialect accepts.
   */
  readonly supportedAccessModes: readonly AccessMode[]

  /**
   * Whether the dialect supports nested transactions via savepoints.
   */
  readonly supportsSavepoints: boolean
}

/**
 * The default capabilities of a standard ANSI SQL database that supports
 * all isolation levels, both access modes and savepoints. Custom drivers
 * that don't declare their own capabilities are assumed to support
 * everything so that third-party dialects keep working unchanged.
 */
export const DEFAULT_TRANSACTION_CAPABILITIES: TransactionCapabilities = freeze(
  {
    supportedIsolationLevels: [
      'read uncommitted',
      'read committed',
      'repeatable read',
      'serializable',
      'snapshot',
    ],
    supportedAccessModes: ['read only', 'read write'],
    supportsSavepoints: true,
  },
)

/**
 * The error thrown when a caller asks for transaction settings the dialect
 * cannot honor. The transaction is never begun in that case.
 */
export class UnsupportedTransactionSettingError extends Error {
  readonly unsupportedIsolationLevels: readonly IsolationLevel[]
  readonly unsupportedAccessModes: readonly AccessMode[]

  constructor(
    unsupportedIsolationLevels: readonly IsolationLevel[],
    unsupportedAccessModes: readonly AccessMode[],
  ) {
    const reasons: string[] = []

    for (const isolationLevel of unsupportedIsolationLevels) {
      reasons.push(
        `isolation level ${isolationLevel} is not supported by this dialect`,
      )
    }

    for (const accessMode of unsupportedAccessModes) {
      reasons.push(`access mode ${accessMode} is not supported by this dialect`)
    }

    super(
      `Cannot begin transaction: ${reasons.join('; ')}. ` +
        'The unsupported setting(s) were rejected instead of being silently downgraded.',
    )

    this.name = 'UnsupportedTransactionSettingError'
    this.unsupportedIsolationLevels = unsupportedIsolationLevels
    this.unsupportedAccessModes = unsupportedAccessModes
  }
}

/**
 * Validates transaction settings against a driver's capabilities and throws
 * an {@link UnsupportedTransactionSettingError} listing every setting the
 * dialect can't honor. This runs before the transaction is begun, so an
 * unsupported level can never be silently downgraded.
 */
export function assertTransactionSettingsSupported(
  settings: TransactionSettings,
  capabilities: TransactionCapabilities,
): void {
  const unsupportedIsolationLevels: IsolationLevel[] = []
  const unsupportedAccessModes: AccessMode[] = []

  if (
    settings.isolationLevel &&
    !capabilities.supportedIsolationLevels.includes(settings.isolationLevel)
  ) {
    unsupportedIsolationLevels.push(settings.isolationLevel)
  }

  if (
    settings.accessMode &&
    !capabilities.supportedAccessModes.includes(settings.accessMode)
  ) {
    unsupportedAccessModes.push(settings.accessMode)
  }

  if (
    unsupportedIsolationLevels.length > 0 ||
    unsupportedAccessModes.length > 0
  ) {
    throw new UnsupportedTransactionSettingError(
      unsupportedIsolationLevels,
      unsupportedAccessModes,
    )
  }
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
