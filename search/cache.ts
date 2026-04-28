/**
 * search/cache.ts
 * 轻量级 LRU + TTL 内存缓存，用于搜索结果缓存
 */

export interface CacheOptions {
    maxSize?: number;      // 最大缓存条目数 (默认 500)
    ttlMs?: number;        // 过期时间毫秒 (默认 10 分钟)
  }
  
  interface CacheEntry<T> {
    value: T;
    expireAt: number;
    lastAccess: number;
  }
  
  export class LRUCache<K, V> {
    private cache = new Map<K, CacheEntry<V>>();
    private maxSize: number;
    private ttlMs: number;
  
    constructor(options: CacheOptions = {}) {
      this.maxSize = options.maxSize ?? 500;
      this.ttlMs = options.ttlMs ?? 10 * 60 * 1000; // 10 分钟
    }
  
    /**
     * 规范化缓存键：对字符串查询做标准化处理
     */
    private normalizeKey(key: K): string {
      if (typeof key === "string") {
        return key.trim().toLowerCase();
      }
      return String(key);
    }
  
    get(key: K): V | null {
      const nKey = this.normalizeKey(key) as unknown as K;
      const entry = this.cache.get(nKey);
      if (!entry) return null;
  
      // 检查是否过期
      if (Date.now() > entry.expireAt) {
        this.cache.delete(nKey);
        return null;
      }
  
      // 更新访问时间（用于 LRU 淘汰）
      entry.lastAccess = Date.now();
      return entry.value;
    }
  
    set(key: K, value: V): void {
      const nKey = this.normalizeKey(key) as unknown as K;
      
      // 如果已满且是新 key，淘汰最少使用的条目
      if (this.cache.size >= this.maxSize && !this.cache.has(nKey)) {
        this.evictLRU();
      }
  
      const now = Date.now();
      this.cache.set(nKey, {
        value,
        expireAt: now + this.ttlMs,
        lastAccess: now,
      });
    }
  
    /**
     * 淘汰最近最少使用的条目
     */
    private evictLRU(): void {
      let oldestKey: K | null = null;
      let oldestTime = Infinity;
  
      for (const [key, entry] of this.cache.entries()) {
        if (entry.lastAccess < oldestTime) {
          oldestTime = entry.lastAccess;
          oldestKey = key;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
  
    clear(): void {
      this.cache.clear();
    }
  
    /**
     * 获取缓存统计信息
     */
    get stats() {
      return { 
        size: this.cache.size, 
        maxSize: this.maxSize,
        ttlMs: this.ttlMs,
      };
    }
  }
  