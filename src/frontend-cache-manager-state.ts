import type { CacheCursor, CacheManagementPage, CacheManagementQuery } from "./cache-authority";

export type CacheManagerPageState = {
  query: string;
  offset: number;
  limit: number;
  loading: boolean;
  page?: CacheManagementPage;
  error?: unknown;
};

export type CacheManagerPageControllerOptions = {
  load: (query: CacheManagementQuery) => Promise<CacheManagementPage>;
  onChange: (state: CacheManagerPageState) => void;
  debounceMs?: number;
  limit?: number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class CacheManagerPageController {
  private readonly debounceMs: number;
  private readonly setTimer: NonNullable<CacheManagerPageControllerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<CacheManagerPageControllerOptions["clearTimer"]>;
  private current: CacheManagerPageState;
  private timer?: ReturnType<typeof setTimeout>;
  private requestId = 0;

  constructor(private readonly options: CacheManagerPageControllerOptions) {
    this.debounceMs = options.debounceMs ?? 200;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.current = { query: "", offset: 0, limit: options.limit ?? 100, loading: false };
  }

  state() {
    return this.current;
  }

  setQuery(query: string) {
    this.current = { ...this.current, query: query.trim().toLowerCase(), offset: 0 };
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.reload();
    }, this.debounceMs);
  }

  goToOffset(offset: number) {
    this.current = { ...this.current, offset: Math.max(0, offset) };
    return this.reload();
  }

  async invalidate(cursor: CacheCursor) {
    const page = this.current.page;
    if (page && page.epoch === cursor.epoch && page.revision >= cursor.revision) return;
    await this.reload();
  }

  async reload(): Promise<void> {
    const requestId = ++this.requestId;
    const request = { query: this.current.query, offset: this.current.offset, limit: this.current.limit };
    this.publish({ ...this.current, loading: true, error: undefined });
    try {
      const page = await this.options.load(request);
      if (requestId !== this.requestId) return;
      if (page.items.length === 0 && page.total > 0 && page.offset > 0) {
        const offset = Math.floor((page.total - 1) / page.limit) * page.limit;
        this.current = { ...this.current, offset };
        await this.reload();
        return;
      }
      this.publish({ ...this.current, offset: page.offset, limit: page.limit, loading: false, page });
    } catch (error) {
      if (requestId === this.requestId) this.publish({ ...this.current, loading: false, error });
    }
  }

  dispose() {
    if (this.timer) this.clearTimer(this.timer);
    this.requestId += 1;
  }

  private publish(state: CacheManagerPageState) {
    this.current = state;
    this.options.onChange(state);
  }
}
