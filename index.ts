import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	getAgentDir,
	type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

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
const DEFAULT_CACHE_TTL_SECONDS = 60 * 60;
const FETCH_TIMEOUT_MS = 10_000;
const OFFLINE_ENV = "PI_OFFLINE";
const CONFIG_FILE_NAME = "pi-models-metadata.env";
// TODO: Remove with the legacy project .env warning.
const LEGACY_DOT_ENV_FILE = ".env";
const ENV_PREFIX = "PIMM_";

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

interface Settings {
	baseUrl: string;
	apiKey: string | undefined;
	metadataUrl: string;
	cacheDir: string;
	cacheTtlMs: number;
}

interface LoadOptions {
	/** When false, cached responses are used regardless of age and no request is sent. */
	allowNetwork: boolean;
	/** Ignore fresh cached responses and request immediately. */
	force: boolean;
	signal?: AbortSignal;
	warn: (message: string) => void;
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

function errorMessage(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return error.cause instanceof Error
		? `${error.message}: ${error.cause.message}`
		: error.message;
}

function isFileNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

/** Reads `PIMM_*` entries from a dotenv-style file; other keys are ignored. */
async function readEnvFile(path: string): Promise<Map<string, string>> {
	const entries = new Map<string, string>();
	const content = await readFile(path, "utf8");

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim().replace(/^export\s+/, "");
		if (!line || line.startsWith("#")) continue;

		const equalsIndex = line.indexOf("=");
		if (equalsIndex <= 0) continue;

		const key = line.slice(0, equalsIndex).trim();
		if (!key.startsWith(ENV_PREFIX)) continue;

		entries.set(key, parseDotEnvValue(line.slice(equalsIndex + 1)));
	}

	return entries;
}

/**
 * Loads the user-level config file. Real environment variables take precedence.
 * Values are written to `process.env` because pi resolves `$PIMM_API_KEY` there.
 */
async function loadConfigFile(path: string): Promise<void> {
	let entries: Map<string, string>;
	try {
		entries = await readEnvFile(path);
	} catch (error) {
		if (!isFileNotFound(error)) {
			console.warn(
				`${LOG_PREFIX} Failed to read ${path}: ${errorMessage(error)}.`,
			);
		}
		return;
	}

	for (const [key, value] of entries) {
		if (process.env[key] === undefined) {
			process.env[key] = value;
		}
	}
}

// TODO: Remove this migration warning after project .env files have been unsupported for a few releases.
async function warnLegacyDotEnv(configPath: string): Promise<void> {
	const path = resolve(LEGACY_DOT_ENV_FILE);
	let keys: string[];
	try {
		keys = [...(await readEnvFile(path)).keys()];
	} catch {
		return;
	}
	if (keys.length === 0) return;

	console.warn(
		`${LOG_PREFIX} Ignoring ${keys.join(", ")} in ${path}: project .env files are no longer read because any repository could redirect the provider API key. Move these variables to ${configPath} or export them.`,
	);
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

/** Mirrors pi's own `PI_OFFLINE` parsing (`--offline` sets it to `1`). */
function isOfflineMode(): boolean {
	const value = process.env[OFFLINE_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function readSettings(): Settings {
	return {
		baseUrl: process.env[BASE_URL_ENV] || DEFAULT_BASE_URL,
		apiKey: process.env[API_KEY_ENV],
		metadataUrl: process.env[METADATA_URL_ENV] || DEFAULT_METADATA_URL,
		cacheDir: readCacheDir(),
		cacheTtlMs: readCacheTtlMs(),
	};
}

function cachePath(cacheDir: string, type: string, key: string): string {
	const digest = createHash("sha256").update(`${type}:${key}`).digest("hex");
	return join(cacheDir, `${type}-${digest}.json`);
}

async function readCache(path: string): Promise<CacheEntry | undefined> {
	try {
		return readCacheEntry(JSON.parse(await readFile(path, "utf8")));
	} catch {
		return undefined;
	}
}

async function writeCache(
	path: string,
	data: unknown,
	warn: LoadOptions["warn"],
): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(
			path,
			JSON.stringify({ cachedAt: Date.now(), data } satisfies CacheEntry),
			"utf8",
		);
	} catch (error) {
		warn(`Failed to write cache ${path}: ${errorMessage(error)}.`);
	}
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Fetches and parses JSON through the local cache. Only responses accepted by
 * `parse` are cached. A cached response of any age is used when network access
 * is not allowed or when the request fails.
 */
async function fetchWithCache<T>(
	url: string,
	cacheType: string,
	cacheKey: string,
	parse: (value: unknown) => T | undefined,
	settings: Settings,
	options: LoadOptions,
	init?: RequestInit,
): Promise<T> {
	const path = cachePath(settings.cacheDir, cacheType, cacheKey);
	const cachedEntry = await readCache(path);
	const cached = cachedEntry && parse(cachedEntry.data);

	if (cachedEntry && cached !== undefined) {
		const fresh =
			settings.cacheTtlMs > 0 &&
			Date.now() - cachedEntry.cachedAt <= settings.cacheTtlMs;
		if (!options.allowNetwork || (fresh && !options.force)) return cached;
	}
	if (!options.allowNetwork) {
		throw new Error("Offline mode is enabled and no cached response exists");
	}

	try {
		const response = await fetch(url, {
			...init,
			signal: requestSignal(options.signal),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}

		const data: unknown = await response.json();
		const parsed = parse(data);
		if (parsed === undefined) {
			throw new Error("Invalid response");
		}

		await writeCache(path, data, options.warn);
		return parsed;
	} catch (error) {
		if (!cachedEntry || cached === undefined) throw error;

		options.warn(
			`Request to ${url} failed: ${errorMessage(error)}. Using cached response from ${new Date(cachedEntry.cachedAt).toISOString()}.`,
		);
		return cached;
	}
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
	settings: Settings,
	options: LoadOptions,
): Promise<ProviderListedModel[]> {
	const headers: Record<string, string> = {};
	if (settings.apiKey) {
		headers.Authorization = `Bearer ${settings.apiKey}`;
	}

	const modelsUrl = buildModelsUrl(settings.baseUrl);
	const payload = await fetchWithCache(
		modelsUrl,
		"provider-models",
		`${modelsUrl}:${settings.apiKey ?? ""}`,
		readProviderModelsResponse,
		settings,
		options,
		{ headers },
	);

	return payload.data;
}

async function fetchOptionalMetadata(
	settings: Settings,
	options: LoadOptions,
): Promise<MetadataIndex> {
	try {
		const payload = await fetchWithCache(
			settings.metadataUrl,
			"metadata",
			settings.metadataUrl,
			readResponse,
			settings,
			options,
		);
		return buildMetadataIndex(payload.data);
	} catch (error) {
		options.warn(
			`Failed to load metadata from ${settings.metadataUrl}: ${errorMessage(error)}. Using provider model list without metadata enrichment.`,
		);
		return buildMetadataIndex([]);
	}
}

async function loadModels(
	settings: Settings,
	options: LoadOptions,
): Promise<ProviderModelConfig[]> {
	const [listedModels, metadataIndex] = await Promise.all([
		fetchProviderModels(settings, options),
		fetchOptionalMetadata(settings, options),
	]);

	return listedModels.map((model) =>
		toProviderModel(model, findMetadata(model, metadataIndex)),
	);
}

export default async function (pi: ExtensionAPI) {
	const configPath = join(getAgentDir(), CONFIG_FILE_NAME);
	await loadConfigFile(configPath);
	await warnLegacyDotEnv(configPath);

	const settings = readSettings();
	const apiType = readApiType();
	const providerName = process.env[PROVIDER_NAME_ENV] || DEFAULT_PROVIDER_NAME;
	const modelsUrl = buildModelsUrl(settings.baseUrl);
	const notRegistered = `Provider "${providerName}" was not registered.`;

	let models: ProviderModelConfig[];
	try {
		models = await loadModels(settings, {
			allowNetwork: !isOfflineMode(),
			force: readBooleanEnv(SKIP_CACHE_ENV),
			warn: (message) => console.warn(`${LOG_PREFIX} ${message}`),
		});
	} catch (error) {
		console.warn(
			`${LOG_PREFIX} Failed to load provider models from ${modelsUrl}: ${errorMessage(error)}. ${notRegistered}`,
		);
		return;
	}

	// Registering an empty list would also replace the models of a built-in
	// provider when PIMM_PROVIDER_NAME overrides one.
	if (models.length === 0) {
		console.warn(
			`${LOG_PREFIX} No models found in ${modelsUrl}. ${notRegistered}`,
		);
		return;
	}

	pi.registerProvider(providerName, {
		baseUrl: settings.baseUrl,
		apiKey: `$${API_KEY_ENV}`,
		api: apiType,
		models,
		// Pi refreshes catalogs in the background (e.g. after interactive startup
		// and from /model search). Fresh cached responses are reused, so this only
		// sends requests after PIMM_CACHE_TTL_SECONDS expires or when pi forces it.
		async refreshModels({ allowNetwork, force, signal }) {
			if (!allowNetwork) return models;

			const refreshed = await loadModels(settings, {
				allowNetwork,
				force: force ?? false,
				signal,
				// Console output would corrupt the TUI; thrown errors are reported by pi.
				warn: () => {},
			});
			// Throwing keeps the current models instead of publishing an empty list.
			if (refreshed.length === 0) {
				throw new Error(`No models found in ${modelsUrl}`);
			}

			models = refreshed;
			return models;
		},
	});
}
