import EmbeddedPostgres from 'embedded-postgres';

const pg = new EmbeddedPostgres({
  databaseDir: './data/postgres',
  user: 'wager',
  password: 'wager',
  port: 5432,
  persistent: true,
});

await pg.initialise();
await pg.start();
await pg.createDatabase('wager').catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes('already exists')) {
    throw error;
  }
});
process.stdout.write('postgres ready on 5432\n');
await new Promise(() => undefined);
