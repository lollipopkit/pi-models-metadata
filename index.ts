import type {
	ExtensionAPI,
	ProviderModelConfig,
} from "@mariozechner/pi-coding-agent";

const DEFAULT_METADATA_URL = "https://ormc.lollipopkit.com/models-data.json";
const METADATA_URL_ENV = "PIMM_METADATA_DATA_URL";
const DEFAULT_PROVIDER_NAME = "pimm"; // pi-model-metadata
const PROVIDER_NAME_ENV = "PIMM_PROVIDER_NAME";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const BASE_URL_ENV = "PIMM_BASE_URL";
const API_KEY_ENV = "PIMM_API_KEY";
const DEFAULT_API_TYPE = "openai-response";
const API_TYPE_ENV = "PIMM_API_TYPE";
const PRICE_SCALE = 1_000_000;

interface OrmcModelsResponse {
	data: OrmcModel[];
}

interface OrmcModel {
	id: string;
	name: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
	};
	pricing?: {
		prompt?: string;
		completion?: string;
		input_cache_read?: string;
		input_cache_write?: string;
	};
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number;
	};
	supported_parameters?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function asStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
		? value
		: undefined;
}

function readPricing(value: unknown): OrmcModel["pricing"] {
	if (!isRecord(value)) return undefined;
	return {
		prompt: asString(value.prompt),
		completion: asString(value.completion),
		input_cache_read: asString(value.input_cache_read),
		input_cache_write: asString(value.input_cache_write),
	};
}

function readArchitecture(value: unknown): OrmcModel["architecture"] {
	if (!isRecord(value)) return undefined;
	return {
		input_modalities: asStringArray(value.input_modalities),
	};
}

function readTopProvider(value: unknown): OrmcModel["top_provider"] {
	if (!isRecord(value)) return undefined;
	return {
		context_length: asNumber(value.context_length),
		max_completion_tokens: asNumber(value.max_completion_tokens),
	};
}

function readModel(value: unknown): OrmcModel | undefined {
	if (!isRecord(value)) return undefined;

	const id = asString(value.id);
	const name = asString(value.name);
	if (!id || !name) return undefined;

	return {
		id,
		name,
		context_length: asNumber(value.context_length),
		architecture: readArchitecture(value.architecture),
		pricing: readPricing(value.pricing),
		top_provider: readTopProvider(value.top_provider),
		supported_parameters: asStringArray(value.supported_parameters),
	};
}

function readResponse(value: unknown): OrmcModelsResponse | undefined {
	if (!isRecord(value) || !Array.isArray(value.data)) return undefined;

	const data: OrmcModel[] = [];
	for (const entry of value.data) {
		const model = readModel(entry);
		if (model) {
			data.push(model);
		}
	}

	return { data };
}

function parsePricePerMillion(value: string | undefined): number {
	if (!value) return 0;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed * PRICE_SCALE : 0;
}

function toInputTypes(
	inputModalities: string[] | undefined,
): ProviderModelConfig["input"] {
	if (inputModalities?.includes("image")) {
		return ["text", "image"];
	}
	return ["text"];
}

function supportsReasoning(parameters: string[] | undefined): boolean {
	return (
		parameters?.some(
			(parameter) =>
				parameter === "reasoning" || parameter === "reasoning_effort",
		) ?? false
	);
}

function toProviderModel(model: OrmcModel): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name,
		reasoning: supportsReasoning(model.supported_parameters),
		input: toInputTypes(model.architecture?.input_modalities),
		cost: {
			input: parsePricePerMillion(model.pricing?.prompt),
			output: parsePricePerMillion(model.pricing?.completion),
			cacheRead: parsePricePerMillion(model.pricing?.input_cache_read),
			cacheWrite: parsePricePerMillion(model.pricing?.input_cache_write),
		},
		contextWindow:
			model.top_provider?.context_length ?? model.context_length ?? 128000,
		maxTokens: model.top_provider?.max_completion_tokens ?? 16384,
	};
}

async function fetchModels(url: string): Promise<ProviderModelConfig[]> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const payload = readResponse(await response.json());
	if (!payload) {
		throw new Error("Invalid models metadata response");
	}

	return payload.data.map(toProviderModel);
}

export default async function (pi: ExtensionAPI) {
	const modelsUrl = process.env[METADATA_URL_ENV] || DEFAULT_METADATA_URL;
	const baseUrl = process.env[BASE_URL_ENV] || DEFAULT_BASE_URL;
	const apiType = process.env[API_TYPE_ENV] || DEFAULT_API_TYPE;
	const providerName = process.env[PROVIDER_NAME_ENV] || DEFAULT_PROVIDER_NAME;

	try {
		const models = await fetchModels(modelsUrl);
		if (models.length === 0) {
			console.warn(
				`[ormc-model-metadata] No models found in ${modelsUrl}; keeping built-in OpenRouter models.`,
			);
			return;
		}

		pi.registerProvider(providerName, {
			baseUrl,
			apiKey: API_KEY_ENV,
			api: apiType,
			models,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[ormc-model-metadata] Failed to load ${modelsUrl}: ${message}. Keeping built-in OpenRouter models.`,
		);
	}
}
