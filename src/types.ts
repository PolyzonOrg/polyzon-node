/**
 * Public data types of the Polyzon API and the known values of its string enums.
 *
 * Enum-like values are plain strings: the constants list what the API knows today, but
 * new sources, licenses and so on appear over time, so every type also accepts any string.
 */

/** Model sources (sites) the catalog knows today. New ones appear; any string is accepted. */
export const SOURCES = [
  'thingiverse',
  'cults3d',
  'printables',
  'makerworld',
  '3dtoday',
  'crealitycloud',
  'myminifactory',
  'thangs',
  'youmagine',
  'grabcad',
  'sketchfab',
  'threeding',
  'nexprint',
  'nasa',
  'nih3d',
  'smithsonian',
  'pinshape',
  'cgtrader',
  'gambody',
  'jewelmodel',
  'makeronline',
  '3dexport',
] as const;

/** License ids the catalog knows today. New ones may appear; any string is accepted. */
export const LICENSES = [
  'cc0',
  'cc-by',
  'cc-by-sa',
  'cc-by-nd',
  'cc-by-nc',
  'cc-by-nc-sa',
  'cc-by-nc-nd',
  'gpl',
  'lgpl',
  'mit',
  'bsd',
  'private-use',
  'commercial',
  'custom',
  'unknown',
] as const;

/** Sort orders of `search`. `relevant` is the server default. */
export const SORTS = ['relevant', 'popular', 'newest', 'likes', 'makes', 'downloads'] as const;

/** Languages of titles, descriptions and tags. `ru` is the server default. */
export const LANGS = ['ru', 'en'] as const;

/** Values of {@link Price.type}. */
export const PRICE_TYPES = ['free', 'paid', 'open'] as const;

/** Values of {@link SearchPage.totalRelation}: `eq` — exact total, `gte` — a lower bound. */
export const TOTAL_RELATIONS = ['eq', 'gte'] as const;

/** A source id: one of {@link SOURCES} or any newer one. */
export type Source = (typeof SOURCES)[number] | (string & {});
/** A license id: one of {@link LICENSES} or any newer one. */
export type License = (typeof LICENSES)[number] | (string & {});
/** A sort order: one of {@link SORTS} or any newer one. */
export type Sort = (typeof SORTS)[number] | (string & {});
/** A language: one of {@link LANGS} or any newer one. */
export type Lang = (typeof LANGS)[number] | (string & {});
/** A price type: one of {@link PRICE_TYPES} or any newer one. */
export type PriceType = (typeof PRICE_TYPES)[number] | (string & {});
/** A total relation: one of {@link TOTAL_RELATIONS} or any newer one. */
export type TotalRelation = (typeof TOTAL_RELATIONS)[number] | (string & {});

/** Query parameters of {@link Polyzon.search}. Unset parameters are not sent. */
export interface SearchParams {
  /** Search text in Russian or English, up to 200 characters. Required. */
  q: string;
  /** Page number, from 1 (server limit: 100). Default 1. */
  page?: number | undefined;
  /** Models per page, 1..50. Default 20. `page × size` must not exceed 2400. */
  size?: number | undefined;
  /** Sort order. Default `relevant`. */
  sort?: Sort | undefined;
  /** `true` — only free models. `false` or unset — no price filter. */
  free?: boolean | undefined;
  /** Only these sources, e.g. `['thingiverse', 'printables']`. */
  sources?: readonly Source[] | undefined;
  /** Only models with these file formats, e.g. `['stl', '3mf']`. */
  formats?: readonly string[] | undefined;
  /** Only models under these licenses, e.g. `['cc0', 'cc-by']`. */
  license?: readonly License[] | undefined;
  /** Language of titles and tags (machine-translated when needed). Default `ru`. */
  lang?: Lang | undefined;
}

/** Query parameters of {@link Polyzon.getModel}. */
export interface ModelParams {
  /** Language of the title, description and tags. Default `ru`. */
  lang?: Lang | undefined;
}

/** Price of a model. */
export interface Price {
  /** `free`, `paid` or `open` (pay what you want); newer values may appear. */
  readonly type: PriceType;
  /** Amount in `currency`, or `null` when unknown. */
  readonly value: number | null;
  /** ISO 4217 currency code, or `null`. */
  readonly currency: string | null;
  /** Human-readable price, e.g. `Бесплатно` or `$4.99`. */
  readonly display: string;
}

/** Counters of a search item; `null` — the source does not report it. */
export interface ItemStats {
  readonly likes: number | null;
  readonly comments: number | null;
  readonly makes: number | null;
  /** Saves to collections; downloads when the source does not count collections. */
  readonly collects: number | null;
}

/** Counters of a model; `null` — the source does not report it. */
export interface ModelStats extends ItemStats {
  readonly downloads: number | null;
  readonly views: number | null;
}

/** One model in search results. */
export interface SearchItem {
  /** Source id, e.g. `thingiverse`. */
  readonly source: Source;
  /** Model id within Polyzon, e.g. `tv-1234567`; use it with {@link Polyzon.getModel}. */
  readonly id: string;
  readonly title: string;
  /** Model page on the source site. */
  readonly url: string;
  readonly thumbnail: string | null;
  readonly creator: string | null;
  /** License id (see {@link LICENSES}), or `null`. */
  readonly license: License | null;
  readonly price: Price | null;
  readonly formats: readonly string[];
  readonly tags: readonly string[];
  readonly stats: ItemStats;
  /** ISO-8601 date as sent by the source (not validated), or `null`. */
  readonly publishedAt: string | null;
}

/** A page of search results. */
export interface SearchPage {
  /** The query as the server understood it. */
  readonly query: string;
  /** The query the server searched for instead (typo fixed), or `null`. */
  readonly correctedQuery: string | null;
  /** A suggested alternative query, or `null`. */
  readonly didYouMean: string | null;
  /** Number of matching models (see `totalRelation`). */
  readonly total: number;
  /** `eq` — `total` is exact, `gte` — it is a lower bound. */
  readonly totalRelation: TotalRelation;
  readonly page: number;
  readonly size: number;
  /** Whether a next page exists within the 2400-result window. */
  readonly hasMore: boolean;
  /** `true` — part of the catalog did not answer, the results are incomplete. */
  readonly partial: boolean;
  readonly items: readonly SearchItem[];
}

/** License of a model. */
export interface ModelLicense {
  /** License id (see {@link LICENSES}). */
  readonly id: License;
  /** License text as shown on the source, or `null`. */
  readonly raw: string | null;
}

/** Reference to a model: its source and id. Search items are model references too. */
export interface ModelRef {
  readonly source: Source;
  readonly id: string;
}

/** A model card. */
export interface Model {
  readonly source: Source;
  readonly id: string;
  readonly title: string;
  /** Model page on the source site. */
  readonly url: string;
  readonly description: string | null;
  readonly thumbnail: string | null;
  /** Image URLs on the source's CDN. */
  readonly images: readonly string[];
  readonly creator: string | null;
  readonly creatorUrl: string | null;
  readonly category: string | null;
  readonly license: ModelLicense | null;
  readonly price: Price | null;
  readonly formats: readonly string[];
  readonly tags: readonly string[];
  readonly stats: ModelStats;
  /** ISO-8601 date as sent by the source (not validated), or `null`. */
  readonly publishedAt: string | null;
  /** ISO-8601 date as sent by the source (not validated), or `null`. */
  readonly updatedAt: string | null;
  /** The same model on other sources. */
  readonly copies: readonly ModelRef[];
}

/** The account and the token a request was made with. */
export interface Me {
  readonly account: {
    readonly id: string;
    readonly displayName: string | null;
    /** ISO-8601 date. */
    readonly createdAt: string;
  };
  readonly token: {
    readonly id: string;
    readonly name: string;
    /** First characters of the token, e.g. `pzk_Q7xR2mVb`. */
    readonly prefix: string;
    /** ISO-8601 date. */
    readonly createdAt: string;
  };
}

/** One quota window. */
export interface QuotaWindow {
  readonly limit: number;
  readonly used: number;
  readonly remaining: number;
  /** Start of the next window, Unix seconds. */
  readonly resetAt: number;
}

/** Quota windows of the account. */
export interface Limits {
  /** Requests per minute, every method counts. */
  readonly perMinute: QuotaWindow;
  /** Requests per UTC day, only `search` and `getModel` count. */
  readonly daily: QuotaWindow;
}

/** Daily quota state from the `x-ratelimit-*` response headers. */
export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  /** Start of the next UTC day, Unix seconds. */
  readonly resetAt: number;
}

/** Metadata of a successful response. */
export interface ResponseMeta {
  /** `X-Request-ID` of the response — quote it when contacting support. `null` when absent. */
  readonly requestId: string | null;
  /** The daily quota after this request, or `null` when the headers are absent. */
  readonly rateLimit: RateLimit | null;
}

/**
 * A result with response metadata in `meta`. `meta` is non-enumerable, so it stays out of
 * `JSON.stringify`, `util.inspect`, spreading and deep-equality checks.
 */
export type WithMeta<T> = T & { readonly meta: ResponseMeta };
