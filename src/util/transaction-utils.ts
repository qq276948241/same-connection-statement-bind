import type { RootOperationNode } from '../operation-node/root-operation-node.js'
import type { CompiledQuery } from '../query-compiler/compiled-query.js'

/**
 * The mutable lifecycle state shared by a transaction and all the executor
 * wrappers created for it.
 *
 * @internal
 */
export interface TransactionState {
  isCommitted: boolean
  isRolledBack: boolean
}

export function createTransactionState(): TransactionState {
  return { isCommitted: false, isRolledBack: false }
}

/**
 * Thrown when an operation is attempted on a transaction that has already
 * been committed or rolled back.
 */
export class TransactionClosedError extends Error {
  constructor(state: 'committed' | 'rolled back') {
    super(`Transaction is already ${state}`)
    this.name = 'TransactionClosedError'
  }
}

export function assertTransactionOpen(state: TransactionState): void {
  if (state.isCommitted) {
    throw new TransactionClosedError('committed')
  }

  if (state.isRolledBack) {
    throw new TransactionClosedError('rolled back')
  }
}

/**
 * Thrown when a write is attempted inside a read-only transaction. The
 * offending transaction is rolled back before this error is thrown.
 */
export class ReadOnlyTransactionError extends Error {
  constructor() {
    super(
      'Cannot execute a write query inside a read-only transaction. ' +
        'The transaction was rolled back.',
    )
    this.name = 'ReadOnlyTransactionError'
  }
}

/**
 * Thrown when a rollback is requested without an active transaction.
 */
export class NoActiveTransactionError extends Error {
  constructor() {
    super('There is no active transaction to roll back')
    this.name = 'NoActiveTransactionError'
  }
}

const MUTATING_ROOT_NODE_KINDS: ReadonlySet<RootOperationNode['kind']> =
  new Set<RootOperationNode['kind']>([
    'InsertQueryNode',
    'UpdateQueryNode',
    'DeleteQueryNode',
    'MergeQueryNode',
    'CreateTableNode',
    'CreateIndexNode',
    'CreateSchemaNode',
    'CreateViewNode',
    'CreateTypeNode',
    'DropTableNode',
    'DropIndexNode',
    'DropSchemaNode',
    'DropViewNode',
    'DropTypeNode',
    'AlterTableNode',
    'AlterTypeNode',
    'RefreshMaterializedViewNode',
  ])

// Leading SQL verbs that modify data/schema. Strings and quoted identifiers
// are stripped from the statement before matching so that column/table names
// or string contents can't trigger false positives.
const MUTATING_SQL_PATTERNS: readonly RegExp[] = [
  /^\s*insert(\s+or\s+\w+)?\s+into\b/i,
  /^\s*replace(\s+into)?\b/i,
  /^\s*update\b/i,
  /^\s*delete\s+from\b/i,
  /^\s*merge\s+into\b/i,
  /^\s*truncate(\s+table)?\b/i,
  /^\s*create\s+(table|index|schema|view|type|database|or\s+replace)\b/i,
  /^\s*drop\s+(table|index|schema|view|type|database)\b/i,
  /^\s*alter\s+(table|schema|type|database)\b/i,
  /^\s*refresh\s+materialized\s+view\b/i,
  /^\s*grant\b/i,
  /^\s*revoke\b/i,
  /^\s*call\b/i,
  /^\s*(begin|start|commit|rollback|savepoint|release)\b/i,
  /^\s*(attach|detach|reindex|vacuum|analyze|pragma)\b/i,
  /^\s*with\b[\s\S]*\b(insert\s+into|update\s+(?!as\b)|delete\s+from|merge\s+into)/i,
]

function stripQuotedLiterals(sql: string): string {
  return sql
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`(?:[^`]|``)*`/g, '``')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\$\$[\s\S]*?\$\$/g, '$$$$')
}

/**
 * Returns true if the given compiled query mutates data or schema and is
 * therefore forbidden inside a read-only transaction.
 */
export function isMutatingQuery(compiledQuery: CompiledQuery): boolean {
  const node = compiledQuery.query

  if (node.kind !== 'RawNode') {
    return MUTATING_ROOT_NODE_KINDS.has(node.kind)
  }

  const sql = stripQuotedLiterals(compiledQuery.sql).trimStart()

  return MUTATING_SQL_PATTERNS.some((pattern) => pattern.test(sql))
}

/**
 * Generates unique savepoint names so nested transactions on different
 * levels (or siblings) can never collide or reuse each other's name while
 * the outer transaction is still open.
 *
 * @internal
 */
export class SavepointNameGenerator {
  #counter = 0

  next(depth: number): string {
    this.#counter++
    return `kysely_sp_${depth}_${this.#counter}`
  }
}
