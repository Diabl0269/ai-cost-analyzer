/**
 * Runtime validation for the user-editable pricing table (`PUT /api/pricing`).
 * zod v4's `z.number()` already rejects NaN/Infinity, so `.min(0)` is enough for "finite ≥ 0".
 */
import { z } from 'zod';
import type { PricingConfig } from '../types.js';

const nonNegative = z.number().min(0);
const positive = z.number().gt(0);
const nonEmpty = z.string().trim().min(1);

const tokenPricesSchema = z.object({
  input: nonNegative,
  output: nonNegative,
  cacheWrite5m: nonNegative,
  cacheWrite1h: nonNegative,
  cacheRead: nonNegative,
});

export const modelFamilySchema = z.enum([
  'fable',
  'mythos',
  'opus',
  'sonnet',
  'haiku',
  'synthetic',
  'other',
]);

export const modelPriceSchema = z.object({
  key: nonEmpty,
  label: nonEmpty,
  match: z.array(nonEmpty).min(1),
  exact: z.boolean().optional(),
  input: nonNegative,
  output: nonNegative,
  cacheWrite5m: nonNegative,
  cacheWrite1h: nonNegative,
  cacheRead: nonNegative,
  fast: tokenPricesSchema.optional(),
  longContext: z.object({
    threshold: z.number().int().min(0),
    inputMultiplier: positive,
    outputMultiplier: positive,
  }).optional(),
  supportsUsGeo: z.boolean(),
  charsPerToken: positive,
  family: modelFamilySchema,
  retired: z.boolean().optional(),
  custom: z.boolean().optional(),
});

export const pricingConfigSchema = z
  .object({
    version: z.literal(1),
    updatedAt: nonEmpty,
    source: z.string(),
    models: z.array(modelPriceSchema).min(1),
    webSearchPer1000: nonNegative,
    usGeoMultiplier: nonNegative,
    batchMultiplier: nonNegative,
    unknownModelPolicy: z.enum(['zero', 'fallbackModel']),
    fallbackModelKey: z.string().optional(),
    assumeCacheWriteTtlWhenUnknown: z.enum(['5m', '1h']),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    config.models.forEach((model, i) => {
      if (seen.has(model.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', i, 'key'],
          message: `duplicate model key "${model.key}"`,
        });
      }
      seen.add(model.key);
    });
    if (config.unknownModelPolicy === 'fallbackModel') {
      if (!config.fallbackModelKey || !seen.has(config.fallbackModelKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fallbackModelKey'],
          message: 'fallbackModelKey must name one of the configured models',
        });
      }
    }
  });

/** Throws a ZodError with a field path when the body is invalid. */
export function parsePricingConfig(input: unknown): PricingConfig {
  return pricingConfigSchema.parse(input);
}
