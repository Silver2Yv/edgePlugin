// 哨兵（4.3 规则 3）：无第三方依赖；加载时只挂被动监听，不读写 DOM、不建观察器。
export function startSentinel(): void {}
