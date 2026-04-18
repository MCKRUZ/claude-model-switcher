// Anthropic request shapes used for signal extraction. Permissive by design:
// only fields relevant to routing are typed; unknown fields round-trip.

export interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly input?: unknown;
  readonly name?: string;
  readonly [k: string]: unknown;
}

export type AnthropicContent = string | readonly ContentBlock[];

export interface AnthropicMessage {
  readonly role: string;
  readonly content: AnthropicContent;
  readonly [k: string]: unknown;
}

export interface AnthropicToolDefinition {
  readonly name: string;
  readonly [k: string]: unknown;
}

export interface AnthropicRequestBody {
  readonly model?: unknown;
  readonly system?: AnthropicContent;
  readonly messages?: readonly AnthropicMessage[];
  readonly tools?: readonly AnthropicToolDefinition[];
  readonly metadata?: { readonly user_id?: unknown; readonly [k: string]: unknown };
  readonly [k: string]: unknown;
}
