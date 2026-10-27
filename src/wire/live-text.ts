/** Incremental user-visible projection. Tool calls are never published here. */
import { ToolCallStreamParser } from '../protocol/parse.ts';
import { TurnAccumulator, classifyFrame } from './sse.ts';

export class LiveText {
  private readonly accumulator = new TurnAccumulator();
  private readonly parser = new ToolCallStreamParser();
  private source = '';
  private pending = '';
  private handoff = false;
  private visible = '';
  published = '';
  assertComplete(): void {
    if (this.pending || this.handoff || this.parser.feed('').pending) throw new Error('TOOL_PROTOCOL');
  }
  push(frame: string): string {
    this.accumulator.push(classifyFrame(frame));
    const next = this.accumulator.textValue;
    if (!next.startsWith(this.source)) throw new Error('NON_MONOTONIC_STREAM');
    this.pending += next.slice(this.source.length);
    this.source = next;
    let input = '';
    for (;;) {
      const marker = this.handoff ? '</state_handoff>' : '<state_handoff>';
      const index = this.pending.toLowerCase().indexOf(marker);
      if (index >= 0) {
        if (!this.handoff) input += this.pending.slice(0, index);
        this.pending = this.pending.slice(index + marker.length);
        this.handoff = !this.handoff;
        continue;
      }
      let hold = 0;
      for (let n = 1; n < marker.length; n++) if (this.pending.toLowerCase().endsWith(marker.slice(0, n))) hold = n;
      if (!this.handoff) input += this.pending.slice(0, this.pending.length - hold);
      this.pending = this.pending.slice(this.pending.length - hold);
      break;
    }
    const parsed = this.parser.feed(input);
    if (parsed.unparsed.length) throw new Error('TOOL_PROTOCOL');
    this.visible += parsed.text;
    // Delay trailing whitespace, not words. Final projection trims protocol boundaries.
    const safe = this.visible.replace(/\n{3,}/g, '\n\n').trim();
    if (!safe.startsWith(this.published)) throw new Error('NON_MONOTONIC_STREAM');
    const delta = safe.slice(this.published.length);
    this.published = safe;
    return delta;
  }
}
