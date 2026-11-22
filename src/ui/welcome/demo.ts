// 欢迎页示例文章上的「亲手试一遍」（L3、决策 038）与页面侧模块之间的接口。
// 界面层不能引用 page/（依赖方向：ui 只依赖 core、platform），工具栏由入口（entrypoints/welcome）装配后经这个接口传进来。

/** 一次示例操作的结果，界面据此在文章下方显示一行状态 */
export type DemoEvent =
  /** 点了「问」：侧边栏已打开，引用已带上 */
  | 'asked'
  /** 点了「解释」：已发给模型，回答在侧边栏里生成 */
  | 'explained'
  /** 点了「解释」但还没有默认模型 */
  | 'noModel'
  /** 浏览器没让打开侧边栏 */
  | 'panelFailed'
  /** 后台没接这次请求 */
  | 'failed';

export interface DemoHost {
  /**
   * 在示例文章上挂工具栏：只认文章里的选区。saveTip 是点「存」时工具栏上的一行提示。
   * 返回卸载函数（移除监听与工具栏）
   */
  mount(article: HTMLElement, opts: { saveTip: string; onEvent: (e: DemoEvent) => void }): () => void;
}
