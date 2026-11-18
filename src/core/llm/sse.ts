// SSE 行解析（5.8 响应校验链）。只负责把已解码的字符串块切成一个个事件的 data 字段拼接，
// 不理解具体业务 JSON（那是适配器的事）。容忍 \n、\r\n、\r 混用、`:` 开头的注释行、
// 事件跨网络块、一块里含多个事件（H7）。
export interface SseEvent {
  /** 一个事件里所有 data 字段按 SSE 规范拼接后的结果（可能是 JSON 文本，也可能是字面量 "[DONE]"） */
  data: string;
}

export interface SseLineParser {
  /** 喂入这一块收到的文本，返回这块里凑齐的完整事件（可能为空，也可能不止一个） */
  push(chunk: string): SseEvent[];
  /** 流结束时调用。残留的、未以空行结束的半成品事件一律丢弃，不是合法事件 */
  end(): SseEvent[];
}

/** 把 buf 按行切开；\r\n 可能被切在网络块边界，遇到结尾处单独的 \r 时留到下次确认 */
function splitLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  let i = 0;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === '\n') {
      lines.push(buf.slice(start, i));
      i += 1;
      start = i;
    } else if (ch === '\r') {
      if (i + 1 >= buf.length) break; // 可能是被切断的 \r\n，等下一块
      lines.push(buf.slice(start, i));
      i += buf[i + 1] === '\n' ? 2 : 1;
      start = i;
    } else {
      i += 1;
    }
  }
  return { lines, rest: buf.slice(start) };
}

export function createSseLineParser(): SseLineParser {
  let buf = '';
  let dataLines: string[] = [];

  function consumeLine(line: string, out: SseEvent[]): void {
    if (line === '') {
      // 空行：事件边界。没有收到过 data 字段的事件（如纯心跳注释）不产出
      if (dataLines.length > 0) out.push({ data: dataLines.join('\n') });
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return; // 注释行（心跳）
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  }

  return {
    push(chunk) {
      buf += chunk;
      const { lines, rest } = splitLines(buf);
      buf = rest;
      const out: SseEvent[] = [];
      for (const line of lines) consumeLine(line, out);
      return out;
    },
    end() {
      buf = '';
      dataLines = [];
      return [];
    },
  };
}
