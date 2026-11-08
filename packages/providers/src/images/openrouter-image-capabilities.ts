import type {
  CoverImageMediaType,
  GeneratedImageReferenceCapabilities,
  GeneratedImageReferenceRole,
} from './generated-image-contract';

export const OPENROUTER_IMAGE_PARAMS = [
  'resolution',
  'aspect_ratio',
  'quality',
  'negative_prompt',
  'n',
  'seed',
  'input_references',
] as const;
export type OpenRouterImageParam = (typeof OPENROUTER_IMAGE_PARAMS)[number];

export interface OpenRouterImageCapabilityAssertion {
  supportedParameters: readonly OpenRouterImageParam[];
  maxPromptCharacters?: number;
  maxCandidates?: number;
  referenceLimits?: Partial<GeneratedImageReferenceCapabilities>;
  costReporting?: boolean;
}

const MEDIA_TYPES: CoverImageMediaType[] = ['image/jpeg', 'image/png', 'image/webp'];

export interface EndpointDescriptor {
  providerTag?: string;
  supportedParameters: Set<OpenRouterImageParam>;
  maxPromptCharacters?: number;
  maxCandidates?: number;
  referenceLimits?: Partial<GeneratedImageReferenceCapabilities>;
  costReporting?: boolean;
  acceptedValues: Partial<Record<OpenRouterImageParam, Set<string>>>;
  candidateRange?: { min?: number; max?: number };
}

export function parseOpenRouterImageParams(
  value: string | undefined,
): OpenRouterImageParam[] | null {
  if (!value?.trim()) return null;
  return value
    .split(',')
    .map((param) => param.trim())
    .filter((param): param is OpenRouterImageParam =>
      (OPENROUTER_IMAGE_PARAMS as readonly string[]).includes(param),
    );
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function readAcceptedValues(value: unknown): Set<string> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = value as Record<string, unknown>;
  const values = Array.isArray(descriptor.values)
    ? descriptor.values
    : Array.isArray(descriptor.enum)
      ? descriptor.enum
      : null;
  if (!values) return undefined;
  const strings = values.filter((entry): entry is string => typeof entry === 'string');
  return strings.length > 0 ? new Set(strings) : undefined;
}

function readMediaTypes(value: unknown): CoverImageMediaType[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter(
    (entry): entry is CoverImageMediaType =>
      typeof entry === 'string' && (MEDIA_TYPES as readonly string[]).includes(entry),
  );
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function readRoles(value: unknown): GeneratedImageReferenceRole[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const allowed: GeneratedImageReferenceRole[] = ['subject', 'style'];
  const values = value.filter(
    (entry): entry is GeneratedImageReferenceRole =>
      typeof entry === 'string' && (allowed as string[]).includes(entry),
  );
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function referenceLimits(
  descriptors: Record<string, unknown>,
): Partial<GeneratedImageReferenceCapabilities> | undefined {
  if (!Object.hasOwn(descriptors, 'input_references')) return undefined;
  const value = descriptors.input_references;
  const descriptor = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const roles = readRoles(descriptor?.roles);
  const maxCount = readPositiveInteger(descriptor?.max_items ?? descriptor?.max);
  const mediaTypes = readMediaTypes(descriptor?.media_types);
  const multiSubjectIdentity = descriptor?.multi_subject_identity === true;
  const maxBytesPerReference = readPositiveInteger(descriptor?.max_bytes_per_item);
  const maxTotalBytes = readPositiveInteger(descriptor?.max_total_bytes);
  const parsed: Partial<GeneratedImageReferenceCapabilities> = descriptor
    ? {
        ...(roles ? { roles } : {}),
        ...(maxCount ? { maxCount } : {}),
        ...(mediaTypes ? { mediaTypes } : {}),
        multiSubjectIdentity,
        ...(maxBytesPerReference ? { maxBytesPerReference } : {}),
        ...(maxTotalBytes ? { maxTotalBytes } : {}),
      }
    : {};
  return {
    roles: parsed.roles ?? ['subject', 'style'],
    maxCount: parsed.maxCount ?? 1,
    multiSubjectIdentity: parsed.multiSubjectIdentity === true,
    mediaTypes: parsed.mediaTypes ?? [...MEDIA_TYPES],
    ...(parsed.maxBytesPerReference ? { maxBytesPerReference: parsed.maxBytesPerReference } : {}),
    ...(parsed.maxTotalBytes ? { maxTotalBytes: parsed.maxTotalBytes } : {}),
  };
}

export function parseEndpointDescriptor(payload: unknown): EndpointDescriptor | null {
  if (!payload || typeof payload !== 'object') return null;
  const endpoints = (payload as { endpoints?: unknown }).endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0) return null;
  const endpoint = endpoints
    .filter((candidate): candidate is Record<string, unknown> =>
      Boolean(
        candidate &&
        typeof candidate === 'object' &&
        typeof (candidate as Record<string, unknown>).provider_tag === 'string',
      ),
    )
    .toSorted((left, right) =>
      String(left.provider_tag).localeCompare(String(right.provider_tag)),
    )[0];
  if (!endpoint) return null;
  const descriptors =
    endpoint.supported_parameters && typeof endpoint.supported_parameters === 'object'
      ? (endpoint.supported_parameters as Record<string, unknown>)
      : {};
  const supported = Object.keys(descriptors).filter((value): value is OpenRouterImageParam =>
    (OPENROUTER_IMAGE_PARAMS as readonly string[]).includes(value),
  );
  const prompt =
    descriptors.prompt && typeof descriptors.prompt === 'object'
      ? (descriptors.prompt as Record<string, unknown>)
      : null;
  const candidates =
    descriptors.n && typeof descriptors.n === 'object'
      ? (descriptors.n as Record<string, unknown>)
      : null;
  const pricing =
    endpoint.pricing && typeof endpoint.pricing === 'object'
      ? (endpoint.pricing as Record<string, unknown>)
      : null;
  const references = referenceLimits(descriptors);
  return {
    providerTag: endpoint.provider_tag as string,
    supportedParameters: new Set(supported),
    ...(readPositiveInteger(prompt?.max_length ?? prompt?.max)
      ? { maxPromptCharacters: readPositiveInteger(prompt?.max_length ?? prompt?.max) }
      : {}),
    ...(readPositiveInteger(candidates?.max ?? candidates?.maximum)
      ? { maxCandidates: readPositiveInteger(candidates?.max ?? candidates?.maximum) }
      : {}),
    ...(references ? { referenceLimits: references } : {}),
    costReporting: Boolean(pricing && Object.keys(pricing).length > 0),
    acceptedValues: Object.fromEntries(
      supported.flatMap((parameter) => {
        const values = readAcceptedValues(descriptors[parameter]);
        return values ? [[parameter, values]] : [];
      }),
    ),
    ...(candidates
      ? {
          candidateRange: {
            ...(readPositiveInteger(candidates.min ?? candidates.minimum)
              ? { min: readPositiveInteger(candidates.min ?? candidates.minimum) }
              : {}),
            ...(readPositiveInteger(candidates.max ?? candidates.maximum)
              ? { max: readPositiveInteger(candidates.max ?? candidates.maximum) }
              : {}),
          },
        }
      : {}),
  };
}

export function assertionDescriptor(config: {
  capabilityAssertion?: OpenRouterImageCapabilityAssertion;
  supportedParams?: readonly OpenRouterImageParam[];
}): EndpointDescriptor | null {
  const assertion =
    config.capabilityAssertion ??
    (config.supportedParams ? { supportedParameters: config.supportedParams } : null);
  if (!assertion) return null;
  const assertedReferences = assertion.supportedParameters.includes('input_references')
    ? (assertion.referenceLimits ?? {
        roles: ['subject', 'style'] as GeneratedImageReferenceRole[],
        maxCount: 1,
        mediaTypes: [...MEDIA_TYPES],
      })
    : undefined;
  return {
    supportedParameters: new Set(assertion.supportedParameters),
    acceptedValues: {},
    ...(assertion.maxPromptCharacters
      ? { maxPromptCharacters: assertion.maxPromptCharacters }
      : {}),
    ...(assertion.maxCandidates ? { maxCandidates: assertion.maxCandidates } : {}),
    ...(assertedReferences ? { referenceLimits: assertedReferences } : {}),
    ...(assertion.costReporting !== undefined ? { costReporting: assertion.costReporting } : {}),
  };
}

function lower(left?: number, right?: number): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

export function intersectDescriptor(
  discovered: EndpointDescriptor,
  restriction: EndpointDescriptor | null,
): EndpointDescriptor {
  if (!restriction) return discovered;
  const discoveredReferences = discovered.referenceLimits;
  const restrictedReferences = restriction.referenceLimits;
  const references = discoveredReferences
    ? {
        ...(discoveredReferences.roles
          ? {
              roles: restrictedReferences?.roles
                ? discoveredReferences.roles.filter((role) =>
                    restrictedReferences.roles!.includes(role),
                  )
                : discoveredReferences.roles,
            }
          : {}),
        ...(lower(discoveredReferences.maxCount, restrictedReferences?.maxCount)
          ? { maxCount: lower(discoveredReferences.maxCount, restrictedReferences?.maxCount) }
          : {}),
        multiSubjectIdentity: Boolean(
          discoveredReferences.multiSubjectIdentity &&
          restrictedReferences?.multiSubjectIdentity !== false,
        ),
        ...(discoveredReferences.mediaTypes
          ? {
              mediaTypes: restrictedReferences?.mediaTypes
                ? discoveredReferences.mediaTypes.filter((mediaType) =>
                    restrictedReferences.mediaTypes!.includes(mediaType),
                  )
                : discoveredReferences.mediaTypes,
            }
          : {}),
        ...(lower(
          discoveredReferences.maxBytesPerReference,
          restrictedReferences?.maxBytesPerReference,
        )
          ? {
              maxBytesPerReference: lower(
                discoveredReferences.maxBytesPerReference,
                restrictedReferences?.maxBytesPerReference,
              ),
            }
          : {}),
        ...(lower(discoveredReferences.maxTotalBytes, restrictedReferences?.maxTotalBytes)
          ? {
              maxTotalBytes: lower(
                discoveredReferences.maxTotalBytes,
                restrictedReferences?.maxTotalBytes,
              ),
            }
          : {}),
      }
    : undefined;
  return {
    ...(discovered.providerTag ? { providerTag: discovered.providerTag } : {}),
    supportedParameters: new Set(
      [...discovered.supportedParameters].filter((value) =>
        restriction.supportedParameters.has(value),
      ),
    ),
    ...(lower(discovered.maxPromptCharacters, restriction.maxPromptCharacters)
      ? {
          maxPromptCharacters: lower(
            discovered.maxPromptCharacters,
            restriction.maxPromptCharacters,
          ),
        }
      : {}),
    ...(lower(discovered.maxCandidates, restriction.maxCandidates)
      ? { maxCandidates: lower(discovered.maxCandidates, restriction.maxCandidates) }
      : {}),
    ...(references ? { referenceLimits: references } : {}),
    costReporting: Boolean(discovered.costReporting && restriction.costReporting !== false),
    acceptedValues: discovered.acceptedValues,
    ...(discovered.candidateRange ? { candidateRange: discovered.candidateRange } : {}),
  };
}
