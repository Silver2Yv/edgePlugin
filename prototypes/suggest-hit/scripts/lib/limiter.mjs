// 简单并发限制器：同时最多 `limit` 个 Promise 在跑。
export function createLimiter(limit) {
  let active = 0;
  const queue = [];
  function next() {
    if (active >= limit || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn()
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }
  return function run(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
  };
}
