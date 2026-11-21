// 小工具：一组样本算 p50/p95/mean/min/max；数值格式化。无副作用，纯函数。
export function percentile(samples, p) {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function summarize(samples) {
  const nums = samples.filter((n) => typeof n === 'number' && Number.isFinite(n));
  if (nums.length === 0) return { n: 0 };
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    n: nums.length,
    p50: percentile(nums, 50),
    p95: percentile(nums, 95),
    mean: sum / nums.length,
    min: Math.min(...nums),
    max: Math.max(...nums),
  };
}

export const fmt = (n, digits = 1) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(digits) : 'N/A');
export const fmtKb = (bytes) => (typeof bytes === 'number' ? `${(bytes / 1024).toFixed(1)} KB` : 'N/A');
export const fmtMb = (bytes) => (typeof bytes === 'number' ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : 'N/A');
