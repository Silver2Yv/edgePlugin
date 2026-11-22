// storage.session 键名登记表（5.4、5.11）。后台用这里的函数拼键，不手写字符串，避免两处约定对不上。
// storage.session 只对扩展自身可见（默认 TRUSTED_CONTEXTS），浏览器重启即清空。
import type { HandoffId, JobId } from './ids';

export const SESSION_KEYS = {
  /** 在途任务的进度（JobRecord 的热副本）；先写库，再写这里 */
  job: (jobId: JobId) => `job:${jobId}`,
  /** 小窗握手令牌（FloatToken），一次性 */
  token: (token: string) => `token:${token}`,
  /** 标签页最近一次选区（action/click 存下的文字与锚点），conv/ask 按 selectionRevision 取 */
  selection: (tabId: number) => `selection:${tabId}`,
  /** 标签页的小窗就绪状态（FloatReadiness） */
  float: (tabId: number) => `float:${tabId}`,
  /** 标签页的小窗绑定（FloatBinding），断线重连用 */
  floatBinding: (tabId: number) => `floatBinding:${tabId}`,
  /** 小窗转侧边栏（Handoff） */
  handoff: (id: HandoffId) => `handoff:${id}`,
  /** 窗口最近一次「开关侧边栏」命令的时间（5.4）：面板加载时读，晚于自己创建时间就自行关闭 */
  sidepanelToggle: (windowId: number) => `sidepanelToggle:${windowId}`,
  /** 本次后台进程的编号；启动扫描用它判断任务是否属于已结束的进程 */
  workerEpoch: 'workerEpoch',
  /** 标签页上进行中的框选（CaptureStart，5.13）：后台在用户拖框期间被回收，收到 capture/rect 时从这里接上 */
  captureStart: (tabId: number) => `captureStart:${tabId}`,
  /** 标签页待确认的截图（PendingCapture，含原图 data URL）：发问时取走；只在内存型的 storage.session，不落盘 */
  capture: (tabId: number) => `capture:${tabId}`,
} as const;
