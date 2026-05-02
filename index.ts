import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Api } from "@mariozechner/pi-ai";
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
const DEFAULT_API_TYPE: Api = "openai-responses";
const API_TYPE_ENV = "PIMM_API_TYPE";
const PRICE_SCALE = 1_000_000;
const LOG_PREFIX = "[pi-models-metadata]";
const CACHE_DIR_ENV = "PIMM_CACHE_DIR";
const CACHE_TTL_SECONDS_ENV = "PIMM_CACHE_TTL_SECONDS";
const SKIP_CACHE_ENV = "PIMM_SKIP_CACHE";
const DEBUG_ENV = "PIMM_DEBUG";
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60;
const DOT_ENV_FILE = ".env";
const DOT_ENV_PREFIX = "PIMM_";

interface OrmcModelsResponse {
	data: OrmcModel[];
}

interface ProviderModelsResponse {
	data: ProviderListedModel[];
}

interface ProviderListedModel {
	id: string;
	name?: string;
	context_length?: number;
	architecture?: OrmcModel["architecture"];
	pricing?: OrmcModel["pricing"];
	top_provider?: OrmcModel["top_provider"];
	supported_parameters?: string[];
}

interface CacheEntry {
	cachedAt: number;
	data: unknown;
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

interface MetadataIndex {
	byId: Map<string, OrmcModel>;
	byNormalizedId: Map<string, OrmcModel>;
	byUniqueBasename: Map<string, OrmcModel>;
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

function readCacheEntry(value: unknown): CacheEntry | undefined {
	if (!isRecord(value)) return undefined;

	const cachedAt = asNumber(value.cachedAt);
	if (cachedAt === undefined || !("data" in value)) return undefined;

	return {
		cachedAt,
		data: value.data,
	};
}

function parseDotEnvValue(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function loadDotEnv(): Promise<void> {
	let content: string;
	try {
		content = await readFile(DOT_ENV_FILE, "utf8");
	} catch {
		return;
	}

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^export\s+/, "");
		if (!line || line.startsWith("#")) continue;

		const equalsIndex = line.indexOf("=");
		if (equalsIndex <= 0) continue;

		const key = line.slice(0, equalsIndex).trim();
		if (
			!key ||
			!key.startsWith(DOT_ENV_PREFIX) ||
			process.env[key] !== undefined
		) {
			continue;
		}

		process.env[key] = parseDotEnvValue(line.slice(equalsIndex + 1));
	}
}

function readCacheTtlMs(): number {
	const rawValue = process.env[CACHE_TTL_SECONDS_ENV];
	if (!rawValue) return DEFAULT_CACHE_TTL_SECONDS * 1000;

	const ttlSeconds = Number.parseFloat(rawValue);
	if (!Number.isFinite(ttlSeconds) || ttlSeconds < 0) {
		console.warn(
			`${LOG_PREFIX} Invalid ${CACHE_TTL_SECONDS_ENV}=${rawValue}; using ${DEFAULT_CACHE_TTL_SECONDS}s.`,
		);
		return DEFAULT_CACHE_TTL_SECONDS * 1000;
	}

	return ttlSeconds * 1000;
}

function readBooleanEnv(name: string): boolean {
	const rawValue = process.env[name];
	if (!rawValue) return false;

	const value = rawValue.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;

	console.warn(`${LOG_PREFIX} Invalid ${name}=${rawValue}; using false.`);
	return false;
}

function readApiType(): Api {
	const rawValue = process.env[API_TYPE_ENV];
	if (!rawValue) return DEFAULT_API_TYPE;

	return rawValue as Api;
}

function readCacheDir(): string {
	return (
		process.env[CACHE_DIR_ENV] ??
		join(
			process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
			"pi-models-metadata",
		)
	);
}

function cachePath(cacheDir: string, type: string, key: string): string {
	const digest = createHash("sha256").update(`${type}:${key}`).digest("hex");
	return join(cacheDir, `${type}-${digest}.json`);
}

async function readFreshCache(
	path: string,
	ttlMs: number,
): Promise<unknown | undefined> {
	if (ttlMs === 0) return undefined;

	try {
		const entry = readCacheEntry(JSON.parse(await readFile(path, "utf8")));
		if (!entry) return undefined;

		if (Date.now() - entry.cachedAt <= ttlMs) {
			return entry.data;
		}
	} catch {
		return undefined;
	}

	return undefined;
}

async function writeCache(path: string, data: unknown): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({ cachedAt: Date.now(), data } satisfies CacheEntry),
			"utf8",
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`${LOG_PREFIX} Failed to write cache ${path}: ${message}.`);
	}
}

async function fetchJsonWithCache(
	url: string,
	cacheType: string,
	cacheKey: string,
	ttlMs: number,
	cacheDir: string,
	skipCache: boolean,
	init?: RequestInit,
): Promise<unknown> {
	const path = cachePath(cacheDir, cacheType, cacheKey);
	if (!skipCache) {
		const cached = await readFreshCache(path, ttlMs);
		if (cached !== undefined) return cached;
	}

	const response = await fetch(url, init);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText}`);
	}

	const data = await response.json();
	await writeCache(path, data);
	return data;
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

function readProviderModel(value: unknown): ProviderListedModel | undefined {
	if (!isRecord(value)) return undefined;

	const id = asString(value.id);
	if (!id) return undefined;

	return {
		id,
		name: asString(value.name),
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

function readProviderModelsResponse(
	value: unknown,
): ProviderModelsResponse | undefined {
	if (!isRecord(value) || !Array.isArray(value.data)) return undefined;

	const data: ProviderListedModel[] = [];
	for (const entry of value.data) {
		const model = readProviderModel(entry);
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

function displayNameFromId(id: string): string {
	return id.split("/").at(-1) || id;
}

function normalizeModelId(id: string): string {
	return id.trim().toLowerCase();
}

function buildMetadataIndex(models: OrmcModel[]): MetadataIndex {
	const byId = new Map<string, OrmcModel>();
	const byNormalizedId = new Map<string, OrmcModel>();
	const basenameBuckets = new Map<string, OrmcModel[]>();

	for (const model of models) {
		byId.set(model.id, model);
		byNormalizedId.set(normalizeModelId(model.id), model);

		const basename = normalizeModelId(displayNameFromId(model.id));
		basenameBuckets.set(basename, [
			...(basenameBuckets.get(basename) ?? []),
			model,
		]);
	}

	const byUniqueBasename = new Map<string, OrmcModel>();
	for (const [basename, bucket] of basenameBuckets) {
		if (bucket.length === 1) {
			byUniqueBasename.set(basename, bucket[0]);
		}
	}

	return { byId, byNormalizedId, byUniqueBasename };
}

function findMetadata(
	listedModel: ProviderListedModel,
	index: MetadataIndex,
): OrmcModel | undefined {
	const exact = index.byId.get(listedModel.id);
	if (exact) return exact;

	const normalizedId = normalizeModelId(listedModel.id);
	const normalized = index.byNormalizedId.get(normalizedId);
	if (normalized) return normalized;

	if (!listedModel.id.includes("/")) {
		return index.byUniqueBasename.get(normalizedId);
	}

	return undefined;
}

function toProviderModel(
	listedModel: ProviderListedModel,
	metadata: OrmcModel | undefined,
): ProviderModelConfig {
	const enriched = metadata ?? listedModel;

	return {
		id: listedModel.id,
		name:
			metadata?.name ?? listedModel.name ?? displayNameFromId(listedModel.id),
		reasoning: supportsReasoning(enriched.supported_parameters),
		input: toInputTypes(enriched.architecture?.input_modalities),
		cost: {
			input: parsePricePerMillion(enriched.pricing?.prompt),
			output: parsePricePerMillion(enriched.pricing?.completion),
			cacheRead: parsePricePerMillion(enriched.pricing?.input_cache_read),
			cacheWrite: parsePricePerMillion(enriched.pricing?.input_cache_write),
		},
		contextWindow:
			enriched.top_provider?.context_length ??
			enriched.context_length ??
			128000,
		maxTokens: enriched.top_provider?.max_completion_tokens ?? 16384,
	};
}

function buildModelsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/models`;
}

async function fetchProviderModels(
	baseUrl: string,
	apiKey: string | undefined,
	ttlMs: number,
	cacheDir: string,
	skipCache: boolean,
): Promise<ProviderListedModel[]> {
	const headers: Record<string, string> = {};
	if (apiKey) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	const modelsUrl = buildModelsUrl(baseUrl);
	const payload = readProviderModelsResponse(
		await fetchJsonWithCache(
			modelsUrl,
			"provider-models",
			`${modelsUrl}:${apiKey ?? ""}`,
			ttlMs,
			cacheDir,
			skipCache,
			{ headers },
		),
	);
	if (!payload) {
		throw new Error("Invalid provider models response");
	}

	return payload.data;
}

async function fetchMetadata(
	url: string,
	ttlMs: number,
	cacheDir: string,
	skipCache: boolean,
): Promise<MetadataIndex> {
	const payload = readResponse(
		await fetchJsonWithCache(url, "metadata", url, ttlMs, cacheDir, skipCache),
	);
	if (!payload) {
		throw new Error("Invalid models metadata response");
	}

	return buildMetadataIndex(payload.data);
}

async function fetchOptionalMetadata(
	url: string,
	ttlMs: number,
	cacheDir: string,
	skipCache: boolean,
): Promise<MetadataIndex> {
	try {
		return await fetchMetadata(url, ttlMs, cacheDir, skipCache);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`${LOG_PREFIX} Failed to load metadata from ${url}: ${message}. Using provider model list without metadata enrichment.`,
		);
		return buildMetadataIndex([]);
	}
}

export default async function (pi: ExtensionAPI) {
	await loadDotEnv();

	const modelsUrl = process.env[METADATA_URL_ENV] || DEFAULT_METADATA_URL;
	const baseUrl = process.env[BASE_URL_ENV] || DEFAULT_BASE_URL;
	const apiKey = process.env[API_KEY_ENV];
	const apiType = readApiType();
	const providerName = process.env[PROVIDER_NAME_ENV] || DEFAULT_PROVIDER_NAME;
	const cacheTtlMs = readCacheTtlMs();
	const cacheDir = readCacheDir();
	const skipCache = readBooleanEnv(SKIP_CACHE_ENV);

	try {
		const [listedModels, metadataById] = await Promise.all([
			fetchProviderModels(baseUrl, apiKey, cacheTtlMs, cacheDir, skipCache),
			fetchOptionalMetadata(modelsUrl, cacheTtlMs, cacheDir, skipCache),
		]);
		const models = listedModels.map((model) =>
			toProviderModel(model, findMetadata(model, metadataById)),
		);
		if (models.length === 0) {
			console.warn(
				`${LOG_PREFIX} No models found in ${buildModelsUrl(baseUrl)}; keeping built-in OpenRouter models.`,
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
			`${LOG_PREFIX} Failed to load provider models from ${buildModelsUrl(baseUrl)}: ${message}. Keeping built-in OpenRouter models.`,
		);
	}
}
