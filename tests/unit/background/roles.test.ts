import { describe, expect, it } from 'vitest';
import { senderRole, senderSummary } from '@/background/roles';

const self = { runtimeId: 'pkahgpgifechjgdpecaebajnocgcnnnd', protocol: 'chrome-extension:' };
const ext = (path: string, host = self.runtimeId) => `chrome-extension://${host}${path}`;

describe('从 sender 推角色（SenderRole 判定表）', () => {
  it('内容脚本：本扩展、网页地址、带 tab 与 frameId', () => {
    expect(
      senderRole({ id: self.runtimeId, url: 'https://a.test/x', tab: { id: 1 }, frameId: 0 }, self),
    ).toBe('content');
    expect(senderRole({ id: self.runtimeId, url: 'about:blank', tab: { id: 1 }, frameId: 2 }, self)).toBe(
      'content',
    );
    // 缺 tab 或 frameId 推不出
    expect(senderRole({ id: self.runtimeId, url: 'https://a.test/x', frameId: 0 }, self)).toBe('unknown');
    expect(senderRole({ id: self.runtimeId, url: 'https://a.test/x', tab: { id: 1 } }, self)).toBe('unknown');
  });

  it('小窗：路径 /float.html 且在标签页里；主机是动态 ID 也认', () => {
    const tab = { id: 1 };
    expect(senderRole({ id: self.runtimeId, url: ext('/float.html'), tab, frameId: 3 }, self)).toBe('float');
    expect(
      senderRole(
        { id: self.runtimeId, url: ext('/float.html#t=abc', '1b2c-dynamic'), tab, frameId: 3 },
        self,
      ),
    ).toBe('float');
    expect(senderRole({ id: self.runtimeId, url: ext('/float.html') }, self)).toBe('unknown');
  });

  it('侧边栏不在标签页里；设置页与欢迎页是 options', () => {
    expect(senderRole({ id: self.runtimeId, url: ext('/sidepanel.html') }, self)).toBe('sidepanel');
    expect(senderRole({ id: self.runtimeId, url: ext('/sidepanel.html'), tab: { id: 1 } }, self)).toBe(
      'unknown',
    );
    expect(senderRole({ id: self.runtimeId, url: ext('/options.html'), tab: { id: 1 } }, self)).toBe(
      'options',
    );
    expect(senderRole({ id: self.runtimeId, url: ext('/welcome.html') }, self)).toBe('options');
    expect(senderRole({ id: self.runtimeId, url: ext('/background.js') }, self)).toBe('unknown');
  });

  it('别的扩展、缺 id、缺地址、地址不合法一律 unknown', () => {
    const tab = { id: 1 };
    expect(senderRole({ id: 'other', url: 'https://a.test/', tab, frameId: 0 }, self)).toBe('unknown');
    expect(senderRole({ url: 'https://a.test/', tab, frameId: 0 }, self)).toBe('unknown');
    expect(senderRole({ id: self.runtimeId, tab, frameId: 0 }, self)).toBe('unknown');
    expect(senderRole({ id: self.runtimeId, url: 'not a url', tab, frameId: 0 }, self)).toBe('unknown');
  });

  it('诊断摘要去掉地址片段（片段里是令牌），不带 documentId 本身', () => {
    const s = senderSummary(
      {
        id: self.runtimeId,
        url: ext('/float.html#t=0123456789abcdef0123456789abcdef', 'dyn'),
        documentId: 'secret-doc',
      },
      self,
    );
    expect(JSON.stringify(s)).not.toContain('0123456789abcdef');
    expect(JSON.stringify(s)).not.toContain('secret-doc');
    expect(s).toMatchObject({ urlHasFragment: true, hostIsRuntimeId: false, hasDocumentId: true });
  });
});
