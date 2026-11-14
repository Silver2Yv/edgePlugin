// 身份与编号（5.5、5.6、5.7）。只是字符串别名，用名字说明含义；生成规则在各自模块。

/** 规范化的页面归档身份，见 `core/context/page-key.ts` */
export type PageKey = string;
/** 浏览器给出的文档实例（`sender.documentId`），只从 sender 取，不信消息体 */
export type DocumentId = string;
/** 内容指纹：标题 + 各块文本摘要的哈希 */
export type ContentVersion = string;
/** 某次请求实际发送的快照编号 */
export type ContextSnapshotId = string;
/** PageDoc 内的块编号，只在一次抽取（一个 contentVersion）里有效 */
export type BlockId = string;

export type ConversationId = string;
export type MessageId = string;
/** 客户端为一次发问生成的去重编号；同一个只接单一次 */
export type ClientRequestId = string;
/** 后台任务编号；与助手消息一一对应（D-03） */
export type JobId = string;
/** 同一任务的第几次网络尝试；重试换新的 */
export type AttemptId = string;
export type ConnectionId = string;
export type FavoriteId = string;
export type BlobId = string;
export type HandoffId = string;

/** 统一的编号格式：小写字母数字、短横线，8–64 位（crypto.randomUUID 满足） */
export const ID_PATTERN = /^[a-z0-9-]{8,64}$/;
