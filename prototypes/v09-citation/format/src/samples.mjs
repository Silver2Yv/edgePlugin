// V-09 第一部分：测试语料（自制，覆盖中英文 / 技术文档 / 新闻 / 论文摘要 / 含重复句）。
//
// 说明：这些文本是为本次原型测试手写构造的（不是抓取自某个真实网页），风格上模仿对应类型，
// 用于测量"引用标记写法"本身的模型遵守情况，不依赖语料的真实出处。
// 每个样本按空行分段，chunk.mjs 会把每段切成一个编号块。
// qaPairs 是"问答并逐字引用"任务的人工标注题目：question 是问题，
// expectedBlockId 是人工判定的正确依据块编号，expectedSubstring 是该块内可作为
// 逐字引用答案的一个子串（用于核对模型是否真的逐字摘录、以及是否指向正确块）。

export const SAMPLES = [
  {
    id: "zh-tech-cache",
    lang: "zh",
    style: "技术文档",
    text: [
      "HTTP 缓存分为强缓存和协商缓存两种机制。强缓存由 Cache-Control 和 Expires 响应头控制，浏览器在缓存未过期前不会向服务器发起请求。",
      "Cache-Control 的 max-age 字段表示资源在多少秒内可以被认为是新鲜的，优先级高于 Expires 字段。当 max-age 为 0 时，浏览器仍会发起请求，但会携带协商缓存所需的条件头。",
      "协商缓存依赖 Last-Modified/If-Modified-Since 和 ETag/If-None-Match 两组头部。服务器收到条件请求后，如果判断资源未变化，会返回 304 Not Modified，不携带响应体，从而节省带宽。",
      "ETag 是资源内容的指纹，通常由内容哈希生成，比基于时间戳的 Last-Modified 更精确，能够识别内容相同但修改时间不同的情况，也能避免时间精度不足导致的误判。",
      "在实际工程中，静态资源常用文件内容哈希作为文件名的一部分（例如 app.3f2a1b.js），这样可以设置一个很长的 max-age，同时在内容变化时通过文件名变化而非缓存失效来更新。",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "ETag 相比 Last-Modified 的优势是什么？",
        expectedBlockId: 4,
        expectedSubstring: "能够识别内容相同但修改时间不同的情况",
      },
      {
        question: "服务器判断资源未变化时会返回什么状态码，响应体是什么样的？",
        expectedBlockId: 3,
        expectedSubstring: "会返回 304 Not Modified，不携带响应体",
      },
    ],
  },
  {
    id: "en-tech-queue",
    lang: "en",
    style: "technical documentation",
    text: [
      "A message queue decouples producers from consumers by placing messages in an intermediate buffer. Producers publish messages without knowing which consumer, if any, will process them, and consumers pull or receive messages independently of the producer's pace.",
      "Most queue systems offer at-least-once delivery by default: a message is redelivered if the consumer does not acknowledge it within a visibility timeout. This means consumers must be designed to handle duplicate processing safely, typically through idempotent operations.",
      "Exactly-once delivery is harder to guarantee end-to-end because it requires coordination between the broker and the consumer's own state store. Some systems approximate it by combining at-least-once delivery with deduplication based on a message id stored on the consumer side.",
      "Dead-letter queues capture messages that fail processing repeatedly, after a configured number of retry attempts. Moving a message to a dead-letter queue prevents a single poison message from blocking the rest of the queue indefinitely.",
      "Backpressure happens when consumers cannot keep up with the rate of incoming messages. Queue depth growing without bound is usually the first observable symptom, and autoscaling consumers based on queue depth is a common mitigation.",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "Why must consumers be designed to handle duplicate processing?",
        expectedBlockId: 2,
        expectedSubstring: "consumers must be designed to handle duplicate processing safely, typically through idempotent operations",
      },
      {
        question: "What is the first observable symptom of backpressure?",
        expectedBlockId: 5,
        expectedSubstring: "Queue depth growing without bound is usually the first observable symptom",
      },
    ],
  },
  {
    id: "zh-news-sample",
    lang: "zh",
    style: "新闻",
    text: [
      "本市交通部门昨日发布通告，自下月一日起，中心城区内三条主干道将在工作日早晚高峰实行潮汪式车道调整，以缓解早晚通勤压力。",
      "通告中提到，调整后的车道方案会在路口设置可变车道指示牌，提前十分钟切换方向，避免车辆在切换瞬间滞留在路口中央造成拥堵。",
      "交通部门同时表示，调整初期将安排交通协管员在重点路口值守两周，协助司机适应新的车道指示，两周后根据运行情况评估是否需要延长协管期。",
      "多位接受采访的市民表示支持调整方案，但也担心夜间或节假日车流量较小时段是否会继续执行潮汪车道，建议增加动态感应而非固定时段执行。",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "可变车道指示牌会提前多久切换方向？",
        expectedBlockId: 2,
        expectedSubstring: "提前十分钟切换方向",
      },
      {
        question: "交通协管员安排值守的初期时长是多久？",
        expectedBlockId: 3,
        expectedSubstring: "安排交通协管员在重点路口值守两周",
      },
    ],
  },
  {
    id: "en-news-sample",
    lang: "en",
    style: "news",
    text: [
      "City officials announced yesterday that three major arterial roads downtown will switch to reversible lane configurations during weekday rush hours starting next month, aiming to ease commuter congestion.",
      "According to the announcement, variable lane signs at intersections will switch direction ten minutes ahead of the actual change, preventing vehicles from being stranded in the middle of an intersection during the transition.",
      "Traffic officials also said they would station traffic wardens at key intersections for the first two weeks to help drivers adjust to the new lane signals, with a review afterward to decide whether to extend the staffing period.",
      "Several residents interviewed supported the plan but raised concerns about whether reversible lanes would still run during low-traffic nighttime or holiday periods, suggesting dynamic sensor-based triggers instead of fixed schedules.",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "How far ahead of the actual change do the variable lane signs switch direction?",
        expectedBlockId: 2,
        expectedSubstring: "switch direction ten minutes ahead of the actual change",
      },
      {
        question: "How long will traffic wardens initially be stationed at key intersections?",
        expectedBlockId: 3,
        expectedSubstring: "station traffic wardens at key intersections for the first two weeks",
      },
    ],
  },
  {
    id: "zh-abstract-sample",
    lang: "zh",
    style: "论文摘要",
    text: [
      "摘要一：本文提出一种基于注意力权重稀疏化的长文本压缩方法，在保持下游问答任务准确率基本不变的前提下，将输入序列长度压缩至原始长度的三分之一左右，显著降低了推理阶段的显存占用。",
      "摘要二：针对检索增强生成系统中检索结果与生成内容不一致的问题，本文设计了一种引用一致性校验模块，在生成阶段逐句比对候选引用片段与生成文本的语义相似度，并在相似度低于阈值时触发重新检索。",
      "摘要三：本文通过对比实验发现，模型在长上下文场景下对位于输入中部的信息召回率明显低于位于首尾的信息，这一现象在多个主流模型上均存在，提示应用层在设计提示词结构时应避免将关键信息放在输入中部。",
      "摘要四：本文提出的增量式块锚点方案在文档发生局部增删时仍能以较低计算开销重新定位原有引用，相较于全文重新索引的方案，在十万字级文档上的平均重定位耗时降低了约一个数量级。",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "引用一致性校验模块在什么情况下会触发重新检索？",
        expectedBlockId: 2,
        expectedSubstring: "在相似度低于阈值时触发重新检索",
      },
      {
        question: "增量式块锚点方案相比全文重新索引，在十万字级文档上的性能提升大致是多少？",
        expectedBlockId: 4,
        expectedSubstring: "平均重定位耗时降低了约一个数量级",
      },
    ],
  },
  {
    id: "en-abstract-sample",
    lang: "en",
    style: "paper abstract",
    text: [
      "Abstract one: We propose a sparsification method over attention weights for long-context compression, reducing the effective input length to roughly one third of the original while leaving downstream question-answering accuracy largely unchanged, substantially lowering inference-time memory usage.",
      "Abstract two: To address inconsistency between retrieved passages and generated content in retrieval-augmented generation systems, we introduce a citation consistency module that compares candidate cited spans against generated sentences at the semantic level, triggering a re-retrieval step whenever similarity falls below a threshold.",
      "Abstract three: Through controlled experiments we find that recall of information placed in the middle of a long context is consistently lower than information placed near the beginning or end, a pattern observed across several widely used models, suggesting prompt designers should avoid placing critical facts in the middle of the input.",
      "Abstract four: Our incremental block-anchor scheme relocates existing citations at low computational cost after local insertions or deletions in a document, achieving roughly an order-of-magnitude reduction in average relocation time on hundred-thousand-character documents compared with full re-indexing.",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "When does the citation consistency module trigger a re-retrieval step?",
        expectedBlockId: 2,
        expectedSubstring: "triggering a re-retrieval step whenever similarity falls below a threshold",
      },
      {
        question: "How much faster is the incremental block-anchor scheme compared with full re-indexing on hundred-thousand-character documents?",
        expectedBlockId: 4,
        expectedSubstring: "roughly an order-of-magnitude reduction in average relocation time",
      },
    ],
  },
  {
    id: "zh-duplicate-sentence",
    lang: "zh",
    style: "含重复句",
    text: [
      "在去年的年度报告中，项目组指出“用户留存率在前三个月出现明显下滑”，并将原因归结为新手引导流程过长，用户在完成全部引导步骤前就已经流失。",
      "本季度的复盘会议上，运营团队重新审视了留存数据后发现，去年报告里提到的下滑趋势其实只出现在新注册用户里，老用户的留存率全年保持稳定，并未受到引导流程调整的影响。",
      "针对新手引导过长的问题，产品团队在本季度把原本七步的引导流程精简为三步，上线后的 A/B 测试显示，“用户留存率在前三个月出现明显下滑”这一现象在新版本里没有再出现，三个月留存率回升到了历史平均水平附近。",
      "需要说明的是，上述三个月留存率的回升数据来自小流量灰度测试，样本量约为总用户的百分之五，团队计划下季度扩大灰度范围后再做一次正式评估。",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "A/B 测试显示新版引导流程上线后，“用户留存率在前三个月出现明显下滑”这个现象是否还存在？出自哪里的结论？",
        expectedBlockId: 3,
        expectedSubstring: "“用户留存率在前三个月出现明显下滑”这一现象在新版本里没有再出现",
      },
      {
        question: "去年年度报告最初是如何描述留存率下滑现象的？",
        expectedBlockId: 1,
        expectedSubstring: "用户留存率在前三个月出现明显下滑",
      },
    ],
  },
  {
    id: "en-duplicate-sentence",
    lang: "en",
    style: "duplicate sentence",
    text: [
      "In last year's annual report, the project team noted that \"user retention dropped noticeably within the first three months,\" attributing it to an onboarding flow that was too long, causing users to churn before completing it.",
      "During this quarter's review meeting, the operations team re-examined the retention data and found that the decline mentioned in last year's report had actually only affected newly registered users; retention among existing users stayed stable all year and was not affected by the onboarding changes.",
      "To address the overly long onboarding flow, the product team simplified it this quarter from seven steps down to three. The subsequent A/B test showed that the phrase \"user retention dropped noticeably within the first three months\" no longer applied to the new version, with three-month retention recovering to roughly the historical average.",
      "It should be noted that the recovery figures above come from a small-traffic gray release covering about five percent of total users; the team plans to expand the gray release next quarter before running a formal evaluation.",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "After the new onboarding flow launched, did the A/B test still show the phrase \"user retention dropped noticeably within the first three months\" applying? Which block supports this?",
        expectedBlockId: 3,
        expectedSubstring: "no longer applied to the new version",
      },
      {
        question: "How did last year's annual report originally describe the retention decline?",
        expectedBlockId: 1,
        expectedSubstring: "user retention dropped noticeably within the first three months",
      },
    ],
  },
  {
    id: "zh-long-mixed",
    lang: "zh",
    style: "综合长文",
    text: [
      "侧边栏在首次打开时会经历三个状态：未就绪、连接中、已就绪。只有进入已就绪状态后，用户的提问才会被实际发送给模型，在此之前的输入会被暂存在草稿里。",
      "划词提问和一键总结共享同一套请求装配逻辑，区别只在于页面上下文的选择范围：划词提问以选区为中心向前后各扩展一定字数，一键总结则从正文开头按预算截取。",
      "当页面在回答生成过程中发生跳转或刷新时，系统会判断当前请求所依赖的内容版本是否仍然匹配，如果页面内容版本已经变化，正在生成的回答仍会完整展示，但新的追问会提示用户内容已更新，建议重新发起总结。",
      "模型网关在收到 400 错误且提示某个参数不被支持时，会自动去掉该参数重试一次，并将这次学习到的结果记录到对应连接的能力表里，下次同一连接发起请求时不会再携带这个参数，但这条记录不会影响其他连接使用相同模型时的参数设置。",
      "截图功能在用户完成框选后，会先在本地生成预览图并等待用户确认，只有用户点击提交后图片才会被发送给模型；如果在等待确认期间页面发生了滚动或缩放，预览图不会跟随更新，而是提示用户当前预览可能已经过期，需要重新框选。",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "侧边栏在未就绪状态下，用户的输入会怎么处理？",
        expectedBlockId: 1,
        expectedSubstring: "在此之前的输入会被暂存在草稿里",
      },
      {
        question: "模型网关学习到某个参数不被支持后，这条记录会不会影响其他连接？",
        expectedBlockId: 4,
        expectedSubstring: "不会影响其他连接使用相同模型时的参数设置",
      },
      {
        question: "截图预览等待用户确认期间如果页面发生滚动，会发生什么？",
        expectedBlockId: 5,
        expectedSubstring: "提示用户当前预览可能已经过期，需要重新框选",
      },
    ],
  },
  {
    id: "en-long-mixed",
    lang: "en",
    style: "mixed long-form",
    text: [
      "When the side panel first opens it moves through three states: not ready, connecting, and ready. Only once it reaches the ready state will a user's question actually be sent to the model; anything typed before that is held in a draft.",
      "Selection-based questions and the one-click summary share the same request assembly logic, differing only in how page context is chosen: a selection-based question expands outward from the selected text by a fixed character budget, while a summary truncates from the beginning of the main content according to the budget.",
      "If the page navigates or reloads while an answer is still being generated, the system checks whether the content version the current request depends on still matches. If the content version has changed, the answer already in progress is still shown in full, but any follow-up question will warn the user that the content has updated and suggest re-running the summary.",
      "When the model gateway receives a 400 error indicating an unsupported parameter, it automatically drops that parameter and retries once, recording what it learned in that connection's capability table. The next request on the same connection will no longer send that parameter, but this record does not affect other connections using the same underlying model.",
      "After a user finishes selecting a screenshot region, a local preview is generated and held for confirmation; the image is only sent to the model once the user clicks submit. If the page scrolls or zooms while waiting for confirmation, the preview is not refreshed automatically, and the user is instead told the preview may be stale and asked to reselect the region.",
    ].join("\n\n"),
    qaPairs: [
      {
        question: "What happens to user input while the side panel is in the not-ready state?",
        expectedBlockId: 1,
        expectedSubstring: "anything typed before that is held in a draft",
      },
      {
        question: "Does the capability record learned by the model gateway affect other connections?",
        expectedBlockId: 4,
        expectedSubstring: "this record does not affect other connections using the same underlying model",
      },
      {
        question: "What happens if the page scrolls while the screenshot preview is awaiting confirmation?",
        expectedBlockId: 5,
        expectedSubstring: "the user is instead told the preview may be stale and asked to reselect the region",
      },
    ],
  },
];
