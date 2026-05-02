import hashlib, logging, threading
from collections import OrderedDict
from typing import Optional

logger = logging.getLogger("gitmind.cache")

DEFAULT_CAPACITY = 128
DIFF_HASH_CHARS  = 64

class LRUCache:
    def __init__(self, capacity: int = DEFAULT_CAPACITY):
        self.capacity  = capacity
        self._store: OrderedDict[str, str] = OrderedDict()
        self._lock     = threading.Lock()
        self._hits     = 0
        self._misses   = 0

    def _make_key(self, diff: str) -> str:
        content = diff[:DIFF_HASH_CHARS].encode("utf-8")
        return hashlib.sha256(content).hexdigest()[:16]

    def get(self, diff: str) -> Optional[str]:
        key = self._make_key(diff)
        with self._lock:
            if key not in self._store:
                self._misses += 1
                return None
            self._store.move_to_end(key)
            self._hits += 1
            logger.debug(f"Cache HIT  key={key[:8]} "
                         f"(hits={self._hits}, misses={self._misses})")
            return self._store[key]

    def set(self, diff: str, message: str) -> None:
        key = self._make_key(diff)
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
            self._store[key] = message
            if len(self._store) > self.capacity:
                evicted_key, _ = self._store.popitem(last=False)
                logger.debug(f"Cache evicted key={evicted_key[:8]}")
        logger.debug(f"Cache SET  key={key[:8]}")

    def invalidate(self, diff: str) -> bool:
        key = self._make_key(diff)
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
        return False

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self._hits   = 0
            self._misses = 0
        logger.info("LRU cache cleared")

    def stats(self) -> dict:
        with self._lock:
            total = self._hits + self._misses
            return {
                "size":      len(self._store),
                "capacity":  self.capacity,
                "hits":      self._hits,
                "misses":    self._misses,
                "hit_rate":  round(
                    self._hits / total if total > 0 else 0.0, 3
                ),
            }

_cache = LRUCache(capacity=DEFAULT_CAPACITY)

def get_cache() -> LRUCache:
    return _cache
