/**
 * `brave-search` domain — model-facing contracts for the Brave API tools.
 *
 * Defines the strict input schemas, inferred input types, and Agent-scope tool
 * service identities contributed by the Brave Search feature.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { AgentTool } from '#/tool/toolContract';

const nonEmptyString = z.string().min(1);
const goggles = z.array(nonEmptyString).min(1).optional();
const freshness = nonEmptyString.optional();
const standardSafeSearch = z.enum(['off', 'moderate', 'strict']);
const resultFilterValues = [
  'discussions',
  'faq',
  'infobox',
  'news',
  'query',
  'videos',
  'web',
  'locations',
] as const;
const resultFilterValueSet = new Set<string>(resultFilterValues);

export const BraveWebSearchInputSchema = z
  .object({
    q: nonEmptyString,
    count: z.number().int().min(1).max(20).default(20),
    offset: z.number().int().min(0).max(9).optional(),
    country: nonEmptyString.optional(),
    search_lang: nonEmptyString.optional(),
    ui_lang: nonEmptyString.optional(),
    freshness,
    safesearch: standardSafeSearch.default('moderate'),
    extra_snippets: z.boolean().optional(),
    spellcheck: z.boolean().optional(),
    text_decorations: z.boolean().optional(),
    result_filter: nonEmptyString
      .refine(
        (value) => value.split(',').every((entry) => resultFilterValueSet.has(entry)),
        'result_filter must be a CSV list of supported result types',
      )
      .optional(),
    goggles,
  })
  .strict();

export const BraveNewsSearchInputSchema = z
  .object({
    q: nonEmptyString,
    count: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(9).optional(),
    freshness,
    country: nonEmptyString.optional(),
    search_lang: nonEmptyString.optional(),
    ui_lang: nonEmptyString.optional(),
    extra_snippets: z.boolean().optional(),
    safesearch: standardSafeSearch.default('strict'),
    goggles,
  })
  .strict();

export const BraveImageSearchInputSchema = z
  .object({
    q: nonEmptyString,
    count: z.number().int().min(1).max(200).default(50),
    country: nonEmptyString.optional(),
    search_lang: nonEmptyString.optional(),
    safesearch: z.enum(['off', 'strict']).default('strict'),
    spellcheck: z.boolean().optional(),
  })
  .strict();

export const BraveVideoSearchInputSchema = z
  .object({
    q: nonEmptyString,
    count: z.number().int().min(1).max(50).default(20),
    offset: z.number().int().min(0).max(9).optional(),
    country: nonEmptyString.optional(),
    search_lang: nonEmptyString.optional(),
    ui_lang: nonEmptyString.optional(),
    freshness,
    safesearch: standardSafeSearch.default('moderate'),
    spellcheck: z.boolean().optional(),
  })
  .strict();

const llmQuery = z
  .string()
  .min(1)
  .max(400)
  .refine((value) => value.trim().split(/\s+/u).length <= 50, 'q must contain at most 50 words');

export const BraveLLMContextLocationSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    long: z.number().min(-180).max(180).optional(),
    city: nonEmptyString.optional(),
    state: nonEmptyString.optional(),
    state_name: nonEmptyString.optional(),
    country: nonEmptyString.optional(),
    postal_code: nonEmptyString.optional(),
  })
  .strict();

export const BraveLLMContextInputSchema = z
  .object({
    q: llmQuery,
    method: z.enum(['GET', 'POST']).default('GET'),
    country: nonEmptyString.default('us'),
    search_lang: nonEmptyString.default('en'),
    count: z.number().int().min(1).max(50).default(20),
    freshness,
    maximum_number_of_urls: z.number().int().min(1).max(50).default(20),
    maximum_number_of_tokens: z.number().int().min(1024).max(32768).default(8192),
    maximum_number_of_snippets: z.number().int().min(1).max(256).default(50),
    maximum_number_of_tokens_per_url: z.number().int().min(512).max(8192).default(4096),
    maximum_number_of_snippets_per_url: z.number().int().min(1).max(100).default(50),
    context_threshold_mode: z.enum(['strict', 'balanced', 'lenient', 'disabled']).optional(),
    safesearch: standardSafeSearch.optional(),
    enable_local: z.boolean().optional(),
    goggles,
    enable_source_metadata: z.boolean().optional(),
    location: BraveLLMContextLocationSchema.optional(),
  })
  .strict();

export const BraveAnswerMessageSchema = z
  .object({
    role: z.enum(['user', 'system', 'assistant']),
    content: z.string(),
  })
  .strict();

export const BraveAnswersInputSchema = z
  .object({
    messages: z.array(BraveAnswerMessageSchema).min(1),
    stream: z.boolean().default(false),
    country: nonEmptyString.optional(),
    language: nonEmptyString.optional(),
    enable_entities: z.boolean().optional(),
    enable_citations: z.boolean().optional(),
    enable_research: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.stream !== true &&
      (value.enable_entities === true ||
        value.enable_citations === true ||
        value.enable_research === true)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'entities, citations, and research require stream=true',
        path: ['stream'],
      });
    }
  });

export const BraveSuggestInputSchema = z
  .object({
    q: nonEmptyString,
    country: nonEmptyString.optional(),
    count: z.number().int().positive().optional(),
    rich: z.boolean().optional(),
  })
  .strict();

export const BraveSpellcheckInputSchema = z
  .object({
    q: nonEmptyString,
    country: nonEmptyString.optional(),
  })
  .strict();

export const BraveLocalSearchInputSchema = z
  .object({
    q: nonEmptyString,
    country: nonEmptyString.optional(),
    search_lang: nonEmptyString.optional(),
    ui_lang: nonEmptyString.optional(),
    units: z.enum(['metric', 'imperial']).optional(),
    include_descriptions: z.boolean().default(false),
  })
  .strict();

export const BraveRichResultsInputSchema = z.object({ q: nonEmptyString }).strict();

export type BraveWebSearchInput = z.infer<typeof BraveWebSearchInputSchema>;
export type BraveNewsSearchInput = z.infer<typeof BraveNewsSearchInputSchema>;
export type BraveImageSearchInput = z.infer<typeof BraveImageSearchInputSchema>;
export type BraveVideoSearchInput = z.infer<typeof BraveVideoSearchInputSchema>;
export type BraveLLMContextInput = z.infer<typeof BraveLLMContextInputSchema>;
export type BraveAnswersInput = z.infer<typeof BraveAnswersInputSchema>;
export type BraveSuggestInput = z.infer<typeof BraveSuggestInputSchema>;
export type BraveSpellcheckInput = z.infer<typeof BraveSpellcheckInputSchema>;
export type BraveLocalSearchInput = z.infer<typeof BraveLocalSearchInputSchema>;
export type BraveRichResultsInput = z.infer<typeof BraveRichResultsInputSchema>;

export interface IBraveWebSearchTool extends AgentTool<BraveWebSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveWebSearchTool = createDecorator<IBraveWebSearchTool>('braveWebSearchTool');
export interface IBraveNewsSearchTool extends AgentTool<BraveNewsSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveNewsSearchTool = createDecorator<IBraveNewsSearchTool>('braveNewsSearchTool');
export interface IBraveImageSearchTool extends AgentTool<BraveImageSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveImageSearchTool = createDecorator<IBraveImageSearchTool>('braveImageSearchTool');
export interface IBraveVideoSearchTool extends AgentTool<BraveVideoSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveVideoSearchTool = createDecorator<IBraveVideoSearchTool>('braveVideoSearchTool');
export interface IBraveLLMContextTool extends AgentTool<BraveLLMContextInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveLLMContextTool = createDecorator<IBraveLLMContextTool>('braveLLMContextTool');
export interface IBraveAnswersTool extends AgentTool<BraveAnswersInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveAnswersTool = createDecorator<IBraveAnswersTool>('braveAnswersTool');
export interface IBraveSuggestTool extends AgentTool<BraveSuggestInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveSuggestTool = createDecorator<IBraveSuggestTool>('braveSuggestTool');
export interface IBraveSpellcheckTool extends AgentTool<BraveSpellcheckInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveSpellcheckTool = createDecorator<IBraveSpellcheckTool>('braveSpellcheckTool');
export interface IBraveLocalSearchTool extends AgentTool<BraveLocalSearchInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveLocalSearchTool = createDecorator<IBraveLocalSearchTool>('braveLocalSearchTool');
export interface IBraveRichResultsTool extends AgentTool<BraveRichResultsInput> {
  readonly _serviceBrand: undefined;
}
export const IBraveRichResultsTool = createDecorator<IBraveRichResultsTool>('braveRichResultsTool');
