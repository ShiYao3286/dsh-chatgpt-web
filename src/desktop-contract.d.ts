/** Minimal consumed surface of desktop 0.2.1-rc.3, whose ASAR omits .d.ts.
 * Derived from shipped LlmAdapter, adapterStream, BlockAssembler and native Schema.
 * Not an upstream SDK declaration; tests/check-desktop-contract.test.mjs verifies runtime seams.
 * Runtime imports still resolve the actual host packages, never these declarations.
 */
declare module '@deepseek-ai/dsh-typert-protocol' {
  export class TypertRemoteService { constructor(ctx: unknown, key: string); }
  export function Remote(method: unknown, context: ClassMethodDecoratorContext): void;
}
declare module '@deepseek-ai/dsh-llm/brand' {
  export type ToolCallId = string & { readonly __toolCallId: unique symbol };
}
declare module '@deepseek-ai/dsh-llm/types' {
  import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand';
  export type ContentBlock = { type: 'text'; text: string } | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; id: ToolCallId; name: string; arguments: string }
    | { type: 'image'; [key: string]: unknown }
    | { type: 'file'; [key: string]: unknown };
  export interface RequestMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: readonly ContentBlock[]; toolCallId?: string; isError?: boolean }
  export interface ToolSchema { name: string; description: string; parameters: Record<string, unknown> }
  export interface GenerateOptions {
    provider: string; model: string; messages: readonly RequestMessage[];
    tools?: ToolSchema[]; system?: string; signal?: AbortSignal; sessionId?: string; purpose?: string;
  }
  export interface Failure { code: string; message: string; status?: number; providerRetryAfterMs?: number }
  export type StreamChunk = { type: 'block-start'; index: number; blockType: 'text' | 'tool-call' }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: ToolCallId; name: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: ContentBlock }
    | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' } | { kind: 'error' | 'aborted'; failure: Failure } };
}
declare module '@deepseek-ai/dsh-llm' {
  import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm/types';
  interface ModelInfo { provider: string; id: string; name: string; inputModalities?: readonly ('text' | 'image')[]; context?: { contextWindow: number }; defaultMaxTokens?: number }
  export abstract class LlmAdapter {
    providerInfo(provider: string): { id: string; name: string };
    listModels(provider: string): Promise<ModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<{ model: ModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }>;
    abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
  }
  export function attributionHeaders(): Record<string, string>;
}
declare module '@deepseek-ai/schemastery' {
  interface NativeSchema {
    volatile(): NativeSchema;
    default(value: unknown): NativeSchema; description(text: string): NativeSchema;
    min(value: number): NativeSchema; max(value: number): NativeSchema; step(value: number): NativeSchema;
  }
  const Schema: {
    object(fields: Record<string, NativeSchema>): NativeSchema;
    const(value: unknown): NativeSchema; string(): NativeSchema; number(): NativeSchema;
  };
  export default Schema;
}
