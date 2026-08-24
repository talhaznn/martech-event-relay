/**
 * Nachbau von Workers KV für die Tests.
 *
 * Bewusst so knapp wie möglich und nur mit den Fähigkeiten, die der Relay tatsächlich benutzt.
 * Die Lebensdauer wird mitgeführt, damit sich das Ablaufverhalten prüfen lässt, ohne zu warten.
 */

interface Entry {
  value: string;
  expiresAt: number | null;
}

export class MockKV {
  private store = new Map<string, Entry>();
  public now = Math.floor(Date.now() / 1000);

  async get(key: string, type?: 'text' | 'json'): Promise<unknown> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    return type === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: options?.expirationTtl ? this.now + options.expirationTtl : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const all = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const page = all.slice(start, start + limit);
    const next = start + page.length;
    const complete = next >= all.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete: complete,
      ...(complete ? {} : { cursor: String(next) }),
    };
  }

  /** Nur für die Tests: Anzahl der abgelegten Schlüssel. */
  size(): number {
    return this.store.size;
  }
}
