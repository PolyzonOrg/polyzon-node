/**
 * Official Node.js / TypeScript SDK for the Polyzon public API (https://api.polyzon.org).
 *
 * @packageDocumentation
 */
import { Polyzon } from './client.js';

export { Polyzon };
export default Polyzon;
export type {
  ClientOptions,
  DerivedClientOptions,
  GetModelsParams,
  Logger,
  ModelResult,
  RequestOptions,
} from './client.js';
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  GoneError,
  InternalServerError,
  InvalidResponseError,
  NotFoundError,
  PermissionDeniedError,
  PolyzonError,
  QuotaExceededError,
  RateLimitError,
} from './errors.js';
export { LANGS, LICENSES, PRICE_TYPES, SORTS, SOURCES, TOTAL_RELATIONS } from './types.js';
export type {
  ItemStats,
  Lang,
  License,
  Limits,
  Me,
  Model,
  ModelLicense,
  ModelParams,
  ModelRef,
  ModelStats,
  Price,
  PriceType,
  QuotaWindow,
  RateLimit,
  ResponseMeta,
  SearchItem,
  SearchPage,
  SearchParams,
  Sort,
  Source,
  TotalRelation,
  WithMeta,
} from './types.js';
export { VERSION } from './version.js';
