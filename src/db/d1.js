/**
 * Cloudflare D1 database adapter
 *
 * Thin subclass of BaseAdapter — implements the 4 DB primitives
 * using Cloudflare D1's .prepare().bind().run()/.all()/.first() API.
 */

import { BaseAdapter, validatePropertyKey } from './base-adapter.js';

export { validatePropertyKey };

export class D1Adapter extends BaseAdapter {
  constructor(db) {
    super();
    /** @type {import('@cloudflare/workers-types').D1Database} */
    this.db = db;
  }

  async _run(sql, params) {
    return this.db.prepare(sql).bind(...params).run();
  }

  async _queryAll(sql, params) {
    const result = await this.db.prepare(sql).bind(...params).all();
    return result.results;
  }

  async _queryOne(sql, params) {
    return this.db.prepare(sql).bind(...params).first();
  }

  async _batch(statements) {
    const stmts = statements.map(s => this.db.prepare(s.sql).bind(...s.params));
    return this.db.batch(stmts);
  }
}
