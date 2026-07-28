import type { EmbeddingModel } from "./semantic-types";
import type { OpenRouterModel } from "./types";

export const compactOpenRouterModel = (model: OpenRouterModel): OpenRouterModel => ({
  id: model.id,
  canonical_slug: model.canonical_slug,
  name: model.name,
  context_length: model.context_length,
  pricing: model.pricing,
  supported_parameters: model.supported_parameters,
  architecture: model.architecture ? {
    input_modalities: model.architecture.input_modalities,
    output_modalities: model.architecture.output_modalities,
    tokenizer: model.architecture.tokenizer
  } : undefined,
  top_provider: model.top_provider ? {
    context_length: model.top_provider.context_length,
    max_completion_tokens: model.top_provider.max_completion_tokens
  } : undefined
});

export const compactEmbeddingModel = (model: EmbeddingModel): EmbeddingModel => ({
  id: model.id,
  name: model.name,
  description: model.description,
  context_length: model.context_length,
  pricing: model.pricing,
  created: model.created
});
