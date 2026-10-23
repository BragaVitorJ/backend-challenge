import { defineConfig } from '@mikro-orm/postgresql';
import { loadEnv } from './src/config/env';
import { entitySchemas } from './src/infrastructure/persistence/orm';

const env = loadEnv();

export default defineConfig({
  clientUrl: env.databaseUrl,
  entities: entitySchemas,
  migrations: {
    tableName: 'mikro_orm_migrations',
    path: 'src/infrastructure/persistence/migrations',
    pathTs: 'src/infrastructure/persistence/migrations',
    glob: '!(*.d).{js,ts}',
    snapshot: false,
  },
});
