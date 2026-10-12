/**
 * Lenient parsing of response bodies. The server is treated as untrusted input: unknown
 * fields are dropped, wrong-typed optional fields become `null` / `[]`, missing required
 * strings become `''` and missing counts `0`. Nothing here throws on a wrong type.
 */
import type {
  ItemStats,
  Limits,
  Me,
  Model,
  ModelRef,
  Price,
  QuotaWindow,
  SearchItem,
  SearchPage,
} from './types.js';

/** A JSON object. */
export type Json = Record<string, unknown>;

const EMPTY: Json = {};

/** The value if it is a JSON object, else `null`. */
export const object = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
/** Counts may arrive as floats (`12.0`): truncated to an integer. */
const int = (value: unknown): number | null => {
  const number = numberOrNull(value);
  return number === null ? null : Math.trunc(number);
};
const intOr0 = (value: unknown): number => int(value) ?? 0;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const objects = (value: unknown): Json[] =>
  Array.isArray(value) ? value.map(object).filter((entry): entry is Json => entry !== null) : [];

function price(value: unknown): Price | null {
  const p = object(value);
  if (!p) return null;
  return {
    type: text(p.type),
    value: numberOrNull(p.value),
    currency: textOrNull(p.currency),
    display: text(p.display),
  };
}

function itemStats(stats: Json): ItemStats {
  return {
    likes: int(stats.likes),
    comments: int(stats.comments),
    makes: int(stats.makes),
    collects: int(stats.collects),
  };
}

function item(value: Json): SearchItem {
  return {
    source: text(value.source),
    id: text(value.id),
    title: text(value.title),
    url: text(value.url),
    thumbnail: textOrNull(value.thumbnail),
    creator: textOrNull(value.creator),
    license: textOrNull(value.license),
    price: price(value.price),
    formats: strings(value.formats),
    tags: strings(value.tags),
    stats: itemStats(object(value.stats) ?? EMPTY),
    publishedAt: textOrNull(value.publishedAt),
  };
}

function ref(value: Json): ModelRef {
  return { source: text(value.source), id: text(value.id) };
}

function quotaWindow(value: unknown): QuotaWindow {
  const w = object(value) ?? EMPTY;
  return {
    limit: intOr0(w.limit),
    used: intOr0(w.used),
    remaining: intOr0(w.remaining),
    resetAt: intOr0(w.resetAt),
  };
}

/** `GET /v1/search` body → {@link SearchPage}. Non-object items are skipped. */
export function parseSearchPage(body: Json): SearchPage {
  return {
    query: text(body.query),
    correctedQuery: textOrNull(body.correctedQuery),
    didYouMean: textOrNull(body.didYouMean),
    total: intOr0(body.total),
    totalRelation: text(body.totalRelation),
    page: intOr0(body.page),
    size: intOr0(body.size),
    hasMore: body.hasMore === true,
    partial: body.partial === true,
    items: objects(body.items).map(item),
  };
}

/** `GET /v1/models/{source}/{id}` body → {@link Model}. */
export function parseModel(body: Json): Model {
  const stats = object(body.stats) ?? EMPTY;
  const license = object(body.license);
  return {
    source: text(body.source),
    id: text(body.id),
    title: text(body.title),
    url: text(body.url),
    description: textOrNull(body.description),
    thumbnail: textOrNull(body.thumbnail),
    images: strings(body.images),
    creator: textOrNull(body.creator),
    creatorUrl: textOrNull(body.creatorUrl),
    category: textOrNull(body.category),
    license: license ? { id: text(license.id), raw: textOrNull(license.raw) } : null,
    price: price(body.price),
    formats: strings(body.formats),
    tags: strings(body.tags),
    stats: { ...itemStats(stats), downloads: int(stats.downloads), views: int(stats.views) },
    publishedAt: textOrNull(body.publishedAt),
    updatedAt: textOrNull(body.updatedAt),
    copies: objects(body.copies).map(ref),
  };
}

/** `GET /v1/me` body → {@link Me}. */
export function parseMe(body: Json): Me {
  const account = object(body.account) ?? EMPTY;
  const token = object(body.token) ?? EMPTY;
  return {
    account: {
      id: text(account.id),
      displayName: textOrNull(account.displayName),
      createdAt: text(account.createdAt),
    },
    token: {
      id: text(token.id),
      name: text(token.name),
      prefix: text(token.prefix),
      createdAt: text(token.createdAt),
    },
  };
}

/** `GET /v1/limits` body → {@link Limits}. */
export function parseLimits(body: Json): Limits {
  return { perMinute: quotaWindow(body.perMinute), daily: quotaWindow(body.daily) };
}
