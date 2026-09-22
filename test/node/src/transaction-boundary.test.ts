import {
  clearDatabase,
  destroyTest,
  initTest,
  type TestContext,
  expect,
  DIALECTS,
} from './test-setup.js'

// Isolation levels each test dialect actually supports. A level missing
// from this list must be rejected at the start of the transaction instead of
// being silently downgraded.
const SUPPORTED_ISOLATION_LEVELS = {
  postgres: ['read committed', 'repeatable read', 'serializable'],
  pglite: ['read committed', 'repeatable read', 'serializable'],
  mysql: [
    'read uncommitted',
    'read committed',
    'repeatable read',
    'serializable',
  ],
  mssql: [
    'read uncommitted',
    'read committed',
    'repeatable read',
    'serializable',
    'snapshot',
  ],
  sqlite: [],
} as const

const ALL_LEVELS = [
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
  'snapshot',
] as const

for (const dialect of DIALECTS) {
  const { sqlSpec, variant } = dialect

  describe(`${variant}: transaction boundary`, () => {
    let ctx: TestContext

    before(async function () {
      ctx = await initTest(this, dialect)
    })

    beforeEach(async () => {
      await clearDatabase(ctx)
    })

    afterEach(async () => {
      await clearDatabase(ctx)
    })

    after(async () => {
      await destroyTest(ctx)
    })

    it('should roll back every statement when one fails', async () => {
      await expect(
        ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto('person')
            .values({
              first_name: 'Foo',
              last_name: 'Barson',
              gender: 'male',
            })
            .execute()

          throw new Error('mid transaction failure')
        }),
      ).to.be.rejectedWith('mid transaction failure')

      const { count } = await ctx.db
        .selectFrom('person')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()

      expect(Number(count)).to.equal(0)
    })

    it('should support nested transactions through savepoints', async () => {
      await ctx.db.transaction().execute(async (outer) => {
        await outer
          .insertInto('person')
          .values({
            first_name: 'Outer',
            last_name: 'Keep',
            gender: 'female',
          })
          .execute()

        await expect(
          outer.transaction().execute(async (inner) => {
            await inner
              .insertInto('person')
              .values({
                first_name: 'Inner',
                last_name: 'Undo',
                gender: 'male',
              })
              .execute()

            throw new Error('inner failure')
          }),
        ).to.be.rejectedWith('inner failure')

        const { count } = await outer
          .selectFrom('person')
          .select((eb) => eb.fn.countAll().as('count'))
          .executeTakeFirstOrThrow()

        expect(Number(count)).to.equal(1)
      })
    })

    it('should undo the inner transaction when the outer one rolls back', async () => {
      await expect(
        ctx.db.transaction().execute(async (outer) => {
          await outer.transaction().execute(async (inner) => {
            await inner
              .insertInto('person')
              .values({
                first_name: 'Inner',
                last_name: 'Committed',
                gender: 'male',
              })
              .execute()
          })

          throw new Error('outer failure')
        }),
      ).to.be.rejectedWith('outer failure')

      const { count } = await ctx.db
        .selectFrom('person')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()

      expect(Number(count)).to.equal(0)
    })

    for (const isolationLevel of ALL_LEVELS) {
      const supported = (
        SUPPORTED_ISOLATION_LEVELS[sqlSpec] as readonly string[]
      ).includes(isolationLevel)

      it(`should ${
        supported ? 'accept' : 'reject before beginning'
      } isolation level ${isolationLevel}`, async () => {
        const builder = ctx.db
          .transaction()
          .setIsolationLevel(isolationLevel as any)

        if (supported) {
          await builder.execute(async (trx) => {
            await trx.selectFrom('person').selectAll().execute()
          })
        } else {
          await expect(
            builder.execute(async () => {
              throw new Error('transaction should not begin')
            }),
          ).to.be.rejectedWith(
            new RegExp(`isolation level ${isolationLevel}.*not supported`, 'i'),
          )

          // The rejected begin must not leave the connection broken.
          await ctx.db.selectFrom('person').selectAll().execute()
        }
      })
    }

    it('should reject writes and roll back a read-only transaction', async function () {
      // tedious/mssql doesn't accept transaction access modes at all.
      if (sqlSpec === 'mssql') {
        await expect(
          ctx.db
            .transaction()
            .setAccessMode('read only')
            .execute(async () => {}),
        ).to.be.rejectedWith(/access mode read only.*not supported/i)
        return
      }

      await ctx.db
        .insertInto('person')
        .values({
          first_name: 'Seed',
          last_name: 'Row',
          gender: 'other',
        })
        .execute()

      await expect(
        ctx.db
          .transaction()
          .setAccessMode('read only')
          .execute(async (trx) => {
            const readable = await trx
              .selectFrom('person')
              .selectAll()
              .execute()

            expect(readable).to.have.length(1)

            await trx
              .insertInto('person')
              .values({
                first_name: 'Write',
                last_name: 'Rejected',
                gender: 'male',
              })
              .execute()
          }),
      ).to.be.rejected

      const { count } = await ctx.db
        .selectFrom('person')
        .select((eb) => eb.fn.countAll().as('count'))
        .executeTakeFirstOrThrow()

      expect(Number(count)).to.equal(1)
    })

    it('should name the unsupported setting when only one of the pair is accepted', async function () {
      if (sqlSpec !== 'mssql') {
        return
      }

      await expect(
        ctx.db
          .transaction()
          .setIsolationLevel('serializable')
          .setAccessMode('read only')
          .execute(async () => {}),
      ).to.be.rejectedWith(/access mode read only.*not supported/i)
    })
  })
}
