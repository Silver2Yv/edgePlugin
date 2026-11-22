// contract-v1.4 增量里界面这一块加的两项：小窗私有端口的 float/pin（图钉），设置里的小窗默认关闭方式
// （settings.float.closeMode）。单独成文件，不与别的块对 contracts.test.ts 的改动冲突。
import { describe, expect, it } from 'vitest';
import { floatToReader } from '@/core/domain/messages';
import { DEFAULT_SETTINGS, migrateSettings } from '@/core/domain/settings';

describe('float/pin（小窗 → 阅读器）', () => {
  it('pinned 为布尔值时合法', () => {
    expect(floatToReader.parse({ type: 'float/pin', pinned: true })).toMatchObject({
      ok: true,
      value: { type: 'float/pin', pinned: true },
    });
    expect(floatToReader.parse({ type: 'float/pin', pinned: false }).ok).toBe(true);
  });

  it('缺字段、类型不对、带未知字段的一律拒绝', () => {
    expect(floatToReader.parse({ type: 'float/pin' }).ok).toBe(false);
    expect(floatToReader.parse({ type: 'float/pin', pinned: 1 }).ok).toBe(false);
    expect(floatToReader.parse({ type: 'float/pin', pinned: true, tabId: 3 }).ok).toBe(false);
  });
});

describe('settings.float.closeMode（小窗默认关闭方式）', () => {
  it('出厂是「点网页自动收起」', () => {
    expect(DEFAULT_SETTINGS.float.closeMode).toBe('auto');
  });

  it('旧数据没有这个字段：迁移时补上默认值，其余小窗设置原样保留', () => {
    const r = migrateSettings({
      version: 1,
      float: { placement: 'remembered', rect: { x: 10, y: 20, w: 400, h: 300 } },
    });
    expect(r).toMatchObject({
      ok: true,
      settings: {
        float: { placement: 'remembered', rect: { x: 10, y: 20, w: 400, h: 300 }, closeMode: 'auto' },
      },
    });
  });

  it('「钉住」合法；其他值按损坏处理，不静默改写', () => {
    const pinned = migrateSettings({
      version: 1,
      float: { placement: 'nearSelection', closeMode: 'pinned' },
    });
    expect(pinned).toMatchObject({ ok: true, settings: { float: { closeMode: 'pinned' } } });
    const bad = migrateSettings({ version: 1, float: { placement: 'nearSelection', closeMode: 'always' } });
    expect(bad).toMatchObject({ ok: false, error: 'corrupt' });
  });
});
