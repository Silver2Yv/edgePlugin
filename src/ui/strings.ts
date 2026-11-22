// 小窗与侧边栏的界面文案（J3）：集中在这一张表里，界面代码只引用键，不写死文字。
// 现在只有中文；以后加英文界面时再加一张同结构的表（类型 Strings 保证键齐全），按语言选一张赋给 T 即可。
// 带数字的文案写成函数，数字的千分位也在这里统一。
// 设置页与欢迎页的文案还没搬进来（下一轮重做时一起）；模型错误分类的文案在 error-labels.ts。

/** 字数、token 数的显示：千分位 */
export const fmt = (n: number): string => n.toLocaleString('en-US');

const zh = {
  brand: '阅读助手',

  conn: {
    float: {
      noToken: '没有有效的令牌，无法连接',
      connecting: '连接中…',
      versionMismatch: '扩展版本与页面不一致，请刷新页面后重试',
      reconnecting: '连接已断开，正在重连…',
      expired: '连接已失效，请关闭小窗后重新点「问」',
    },
    panel: {
      connecting: '连接中…',
      versionMismatch: '扩展版本已更新，请关闭侧边栏后重新打开',
      reconnecting: '连接已断开，正在重连…',
      expired: '连接已失效，请关闭侧边栏后重新打开',
    },
  },

  header: {
    newConversation: '新对话',
    newConversationTitle: '开始一个新对话（之前的回答不再带给模型）',
    toPanel: '转到侧边栏',
    toPanelTitle: '转到侧边栏继续这个对话',
    pin: '钉住小窗',
    pinTitle: '钉住：点网页时小窗不收起，方便对照原文；会一直占着屏幕一角',
    unpinTitle: '已钉住。点一下恢复「点网页自动收起」',
    close: '收起小窗',
    closeTitle: '收起（Esc）。回答会继续生成，再次打开还在',
  },

  notice: {
    floatTransient: '小窗这次没能加载出来，已改在侧边栏继续。',
    floatUnsupported: '这个网站放不了小窗，已改在侧边栏继续。',
    noConnection: '请先在设置里添加连接',
    requestRefused: '这次请求没有发出，请重新试一次',
    openSettings: '打开设置',
    handoffSlow: '侧边栏还没有接上，小窗先留着；可以稍后再点一次',
    newConversationStarted: '已开启新对话，旧的仍可在历史里找回',
  },

  reject: {
    tooLarge: '内容过长',
    invalid: '消息格式不对',
    notAllowed: '当前状态不允许该操作',
    notHandshaken: '尚未完成握手',
    badToken: '连接已失效',
    notOwner: '无权限操作该任务',
    busy: '回答进行中，请等这一轮答完或先停止',
    gone: '后台重启过，这段对话没法转过去，回答仍留在这里',
    unknown: '未知原因',
    retryNotOwner: '后台已重启，这次没法重试，请重新提问',
    retryNotAllowed: '这次请求没有发出，没法重试，请重新提问',
    action: (reason: string) => `操作失败：${reason}`,
    send: (reason: string) => `发送失败：${reason}`,
    handoff: (reason: string) => `没能转到侧边栏：${reason}`,
    subscribe: (reason: string) => `没能显示这个标签页：${reason}`,
  },

  error: {
    generating: '回答进行中',
    notReady: '还没准备好，请稍后再点一次',
    panelNotOpened: '浏览器没有打开侧边栏，请点工具栏里的「阅读助手」图标',
  },

  wait: {
    waiting: '正在等待回答…',
    thinkingHard: '正在努力思考中…',
    long: '等待时间较长，仍在尝试中…',
    reasoning: '正在思考…（思考过程可展开查看）',
    paused: '回答暂停了一会儿，仍在等待…',
  },

  composer: {
    inputLabel: '输入问题',
    placeholder: '输入问题，Enter 发送',
    send: '问',
    stop: '停止',
    quoteLabel: '本次引用',
    quoteDismiss: '取消引用',
    quoteDismissTitle: '取消引用：之后的发问不带这段选中的文字',
    quoteTruncated: (total: number) => `选区过长，只发送了其中一部分（原文共 ${fmt(total)} 字）`,
    tierLabel: '上下文档位',
    tier: { selection: '只看选中', nearby: '带上下文', fullPage: '带全文' },
    /** K4：悬停说明，与设置页同款的一两句（开了会怎样、代价是什么） */
    tierHelp: {
      selection: '只看选中：只发送选中的文字，最快最省，但回答不会参考页面其他内容。',
      nearby: '带上下文：带上选区前后几段、所在章节标题和回指到的段落，大多数问题够用。',
      fullPage: '带全文：把整篇正文发给模型，回答更完整，但首次等待更久；超长页面会截断并写明。',
    },
    thinkingLabel: '思考强度',
    thinking: { off: '思考 关', low: '思考 低', medium: '思考 中', high: '思考 高' },
    thinkingHelp: '思考：开启后更适合复杂问题，但等待更久、费用更高；只是解释一句话时建议关闭。',
    scopeHelp: '临时切换，只影响这个对话之后的发问；默认值在设置里改。',
    modelTitle: (model: string) => `当前模型：${model}（在设置里改）`,
  },

  list: {
    emptyFloat: '输入问题后按 Enter 发送，Shift+Enter 换行',
    emptyPanel: '在网页上选中文字后点「问」，或直接在下方提问',
    userNoText: '（没有输入问题，只发送了选中的文字）',
    quoted: (chars: number) => `引用 ${fmt(chars)} 字`,
  },

  answer: {
    reasoning: '思考过程',
    reasoningNow: '思考中…',
    stopped: '已停止',
    interrupted: '上次请求的结果未知，重试可能重新计费',
    retry: '重试',
    expand: '展开讲讲',
    expandTitle: '在这个对话里接着问一句，让它展开细说',
    usage: '用量',
    usageInput: (n: number) => `输入 ${fmt(n)} token`,
    usageOutput: (n: number) => `输出 ${fmt(n)} token`,
    usageReasoning: (n: number) => `其中思考 ${fmt(n)} token`,
  },

  /** 「实际发送说明」（B8），从发送计划派生 */
  sent: {
    label: '本次发送',
    selected: (chars: number) => `选中 ${fmt(chars)} 字`,
    selectionTruncated: '选区过长已截断',
    selectionOnly: '只发送了选中的文字',
    nothing: '没有带页面内容',
    notRead: '未读取页面',
    nearby: (blocks: number) => `带上下文 ${fmt(blocks)} 段`,
    fullPage: '带全文',
    fullPagePartial: (sent: number) => `带全文的一部分（${fmt(sent)} 字，已截断）`,
    pageTotal: (chars: number) => `全文共 ${fmt(chars)} 字`,
    droppedHistory: (turns: number) => `较早的 ${fmt(turns)} 轮对话超出预算，没有发送`,
    historyHasPageText: '历史中仍包含之前发送的原文',
    removedEarlierPageText: '已移除先前发送的页面全文',
    estimatedTokens: (n: number) => `估算输入约 ${fmt(n)} token`,
    model: (model: string) => `模型 ${model}`,
  },

  /** 侧边栏顶部的当前页信息（C3） */
  page: {
    untitled: '当前页面',
    readable: (chars: number) => `可读取 ${fmt(chars)} 字`,
    notRead: '未读取页面内容',
    truncated: '全文超出预算，发送时有截断',
    complete: '全文完整发送',
    lastSummary: (time: string) => `上次总结 ${time}`,
  },
};

export type Strings = typeof zh;
export const T: Strings = zh;
