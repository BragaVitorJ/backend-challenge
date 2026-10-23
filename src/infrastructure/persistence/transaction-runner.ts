import { Inject, Injectable } from '@nestjs/common';
import { MikroORM, RequestContext } from '@mikro-orm/core';
import { SqlEntityManager } from '@mikro-orm/postgresql';
import type { Env } from '../../config/env';

@Injectable()
export class TransactionRunner {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject('ENV') private readonly env: Env,
  ) {}

  run<T>(work: () => Promise<T>): Promise<T> {
    const em = this.orm.em.fork();
    return em.transactional(async (tx) => {
      await (tx as SqlEntityManager).execute(`set local lock_timeout = '${this.env.lockTimeoutMs}ms'`);
      return RequestContext.create(tx, work);
    });
  }
}
