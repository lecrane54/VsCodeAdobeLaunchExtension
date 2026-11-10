/** Library workflow helpers: pick a library, revise resources, add revisions to a library, build. */

import { ReactorClient } from './client';

export interface LibrarySummary {
  id: string;
  name: string;
  state: string;
  updatedAt?: string;
  updatedBy?: string;
}

export interface LibraryDetail extends LibrarySummary {
  buildRequired: boolean;
}

export interface LibraryResource {
  id: string;
  originId?: string;
  name: string;
  revisionNumber?: number;
  enabled?: boolean;
  version?: string;
  delegateDescriptorId?: string;
  updatedAt?: string;
}

export interface LibraryRuleComponent {
  id: string;
  name: string;
  kind: string;
  delegateDescriptorId?: string;
  order?: number;
}

export interface BuildStatus {
  id: string;
  status: string;
}

/**
 * The resource types that can be revised and added to a library. Extensions
 * revise exactly like rules and data elements — an extension settings change
 * that is never revised into the library is silently dropped by the build.
 */
export const REVISABLE_TYPES = ['rules', 'data_elements', 'extensions'] as const;
export type RevisableType = (typeof REVISABLE_TYPES)[number];

export interface ResourceRef {
  type: RevisableType;
  originId: string;
}

type Raw = { id: string; attributes: any; relationships?: any };

export async function listLibraries(
  client: ReactorClient,
  propertyId: string,
  state?: string
): Promise<LibrarySummary[]> {
  const raw = await client.paged<Raw>(`/properties/${propertyId}/libraries`);
  return raw
    .map((l) => ({
      id: l.id,
      name: l.attributes.name,
      state: l.attributes.state,
      updatedAt: l.attributes.updated_at,
      updatedBy: l.attributes.updated_by_display_name,
    }))
    .filter((l) => (state ? l.state === state : true))
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export async function getLibrary(client: ReactorClient, libraryId: string): Promise<LibraryDetail> {
  const resp = (await client.get<{ data: Raw }>(`/libraries/${libraryId}`))!;
  const a = resp.data.attributes;
  return {
    id: resp.data.id,
    name: a.name,
    state: a.state,
    updatedAt: a.updated_at,
    updatedBy: a.updated_by_display_name,
    buildRequired: a.build_required === true,
  };
}

/** The revisions of one resource type included in a library. */
export async function listLibraryResources(
  client: ReactorClient,
  libraryId: string,
  type: RevisableType
): Promise<LibraryResource[]> {
  const raw = await client.paged<Raw>(`/libraries/${libraryId}/${type}`);
  return raw
    .map((r) => ({
      id: r.id,
      originId: r.relationships?.origin?.data?.id,
      name: r.attributes.display_name || r.attributes.name || r.id,
      revisionNumber: r.attributes.revision_number,
      enabled: r.attributes.enabled,
      version: r.attributes.version,
      delegateDescriptorId: r.attributes.delegate_descriptor_id,
      updatedAt: r.attributes.updated_at,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The components of a rule *revision* — same endpoint as a head rule. */
export async function listRuleComponents(
  client: ReactorClient,
  ruleId: string
): Promise<LibraryRuleComponent[]> {
  const raw = await client.paged<Raw>(`/rules/${ruleId}/rule_components`);
  return raw
    .map((c) => ({
      id: c.id,
      name: c.attributes.name || '(unnamed)',
      kind: (c.attributes.delegate_descriptor_id ?? '').split('::')[1] ?? 'component',
      delegateDescriptorId: c.attributes.delegate_descriptor_id,
      order: c.attributes.order,
    }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
}

export async function createLibrary(
  client: ReactorClient,
  propertyId: string,
  name: string
): Promise<LibrarySummary> {
  const resp = (await client.post<{ data: Raw }>(`/properties/${propertyId}/libraries`, {
    data: { type: 'libraries', attributes: { name } },
  }))!;
  const l = resp.data;
  return {
    id: l.id,
    name: l.attributes.name,
    state: l.attributes.state,
    updatedAt: l.attributes.updated_at,
    updatedBy: l.attributes.updated_by_display_name,
  };
}

/** Revise a rule/data element/extension to snapshot the head into an immutable revision. */
async function revise(client: ReactorClient, type: RevisableType, originId: string): Promise<void> {
  await client.patch(`/${type}/${originId}`, {
    data: { type, id: originId, meta: { action: 'revise' } },
  });
}

/** Find the highest revision id for an origin resource. Assumes head has been revised. */
async function latestRevisionId(
  client: ReactorClient,
  type: RevisableType,
  originId: string
): Promise<string> {
  const revs = await client.paged<Raw>(`/${type}/${originId}/revisions`);
  if (revs.length === 0) {
    throw new Error(`${type}/${originId} has no revisions`);
  }
  const latest = revs.reduce((best, r) =>
    (r.attributes.revision_number ?? 0) > (best.attributes.revision_number ?? 0) ? r : best
  );
  return latest.id;
}

/**
 * For each origin resource: revise it, look up the freshly-created revision id, and add it to the library.
 * Batched per type.
 */
export async function reviseAndAddToLibrary(
  client: ReactorClient,
  libraryId: string,
  resources: ResourceRef[]
): Promise<{ revised: ResourceRef[]; added: Partial<Record<RevisableType, string[]>> }> {
  const unique = new Map<string, ResourceRef>();
  for (const r of resources) unique.set(`${r.type}/${r.originId}`, r);
  const revs: Record<RevisableType, string[]> = { rules: [], data_elements: [], extensions: [] };
  for (const ref of unique.values()) {
    await revise(client, ref.type, ref.originId);
    const revId = await latestRevisionId(client, ref.type, ref.originId);
    revs[ref.type].push(revId);
  }
  const added: Partial<Record<RevisableType, string[]>> = {};
  for (const type of REVISABLE_TYPES) {
    if (revs[type].length === 0) continue;
    await client.post(`/libraries/${libraryId}/relationships/${type}`, {
      data: revs[type].map((id) => ({ type, id })),
    });
    added[type] = revs[type];
  }
  return { revised: [...unique.values()], added };
}

function toBuildStatus(resp: any): BuildStatus {
  return { id: resp?.data?.id, status: resp?.data?.attributes?.status };
}

export async function buildLibrary(client: ReactorClient, libraryId: string): Promise<BuildStatus> {
  return toBuildStatus(await client.post(`/libraries/${libraryId}/builds`));
}

export async function getBuild(client: ReactorClient, buildId: string): Promise<BuildStatus> {
  return toBuildStatus(await client.get(`/builds/${buildId}`));
}

export function isBuildSettled(status: string | undefined): boolean {
  return status === 'succeeded' || status === 'failed';
}
