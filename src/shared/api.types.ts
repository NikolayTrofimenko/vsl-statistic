import type { DashDetail, DashPeriodKind, Dashboard } from './dashboard.types';

/**
 * Contract between the Angular client and the Express server.
 *
 * Both sides import this file: the server registers one RPC channel per
 * method, the client calls them by the same name. Keep it free of runtime
 * code — it is compiled by two different toolchains.
 */

/**
 * Every role sees the library; landing stats and upload history are admin
 * only. The role decides whose tags and duplicate marks are visible (tags:
 * buyer — own, team lead — own + their buyers', admin — all; duplicate marks:
 * own, admin — all) and whether admin actions are open (accounts, Drive
 * connection, vertical codes, deleting creatives).
 */
export type UserRole = 'buyer' | 'teamlead' | 'admin';

/** A part of the app an access role can open (see `src/shared/access.ts`). */
export type Section = 'library' | 'caps' | 'domains' | 'quality' | 'history' | 'grants' | 'offers' | 'offersEdit' | 'knowledge' | 'knowledgeEdit';

export interface SessionUser {
  id: number;
  login: string;
  role: UserRole;
  /** Sections this account may open: all for an admin, else its access role's (default: library). */
  sections: Section[];
  /** Name of the access role, if one is set. */
  accessRole: string | null;
  /** Whose tags show: own, own + the team's (a lead), everyone's (admin or a role that says so). */
  tagScope: TagScope;
}

/** Whose tags a role sees in the library. */
export type TagScope = 'own' | 'team' | 'all';

/**
 * An admin-made role ("Баер", "Тимлид", "Биздев"): the sections it opens,
 * whose tags it sees and whether its people lead a team (buyers are attached
 * to them; they share Keitaro access to their team). Admin is built in.
 */
export interface AccessRole {
  id: number;
  name: string;
  sections: Section[];
  tagScope: TagScope;
  leads: boolean;
  /** Accounts that have it. */
  users: number;
}

export interface AccessRoleInput {
  id?: number;
  name: string;
  sections: Section[];
  tagScope?: TagScope;
  leads?: boolean;
}

export interface AuthState {
  authenticated: boolean;
  user: SessionUser | null;
}

/* ============================ Accounts ============================ */

export interface UserInfo {
  id: number;
  login: string;
  role: UserRole;
  /** A buyer's team lead. */
  teamleadId: number | null;
  /** Null — the default sections (library). */
  accessRoleId: number | null;
  active: boolean;
  createdAt: number;
}

export interface UserInput {
  login: string;
  password: string;
  role: UserRole;
  teamleadId: number | null;
  accessRoleId?: number | null;
}

export interface UserPatch {
  role?: UserRole;
  teamleadId?: number | null;
  accessRoleId?: number | null;
  active?: boolean;
}

/* ============================ Drive library ============================ */

export interface DriveStatus {
  /** OAuth client id/secret present in the environment. */
  configured: boolean;
  /** A refresh token is stored and still readable. */
  connected: boolean;
  /** Google account the token belongs to. */
  email: string | null;
  folderId: string;
  /** Redirect URI to register on the OAuth client. */
  redirectUri: string;
  /** The connection may upload (granted full Drive access, not read-only). */
  writable: boolean;
  sync: SyncState;
}

export interface SyncState {
  running: boolean;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastError: string | null;
  /** Videos seen by the last successful sync. */
  lastCount: number | null;
}

export interface LibraryVideo {
  id: string;
  /** Permanent creative ID, e.g. `SUS-0142` — what buyers copy into Kaiten / FB. */
  creoId: string | null;
  /** Vertical of the file's current top-level folder. */
  verticalId: number | null;
  name: string;
  mimeType: string;
  size: number | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /** Path of the parent folder relative to the library root ('' for the root). */
  folderPath: string;
  modifiedAt: string;
  /** When the file was added to Drive. */
  createdAt: string | null;
  /** When it first showed up in this library (ms) — what "new" is measured by. */
  firstSeenAt: number;
  webViewLink: string | null;
  hasThumb: boolean;
  /** Country (ISO 3166-1 alpha-2) the creative was made for. */
  geo: string | null;
  /** 'name' — guessed from the file name; 'manual' — set by a person. */
  geoSource: 'name' | 'manual' | null;
  /** Spoken language (ISO 639-1), detected from the audio. */
  lang: string | null;
  transcribeStatus: 'pending' | 'done' | 'failed';
  hasTranscript: boolean;
  hasTranslation: boolean;
  /** Gone from Drive since the last sync — kept so stats links don't break. */
  removed: boolean;
  note: string;
  /** Tags on this creative that the viewer may see. */
  tagIds: number[];
  /** Landing-page videos linked to this file (count). */
  landingCount: number;
  /** "Это повтор" marks the viewer may see: own; an admin sees everyone's. */
  duplicateMarks: DuplicateMark[];
  /** Open "Ошибка" reports the viewer may see: own; an admin sees everyone's. */
  reports: CreoReport[];
}

/** Someone's note that a creative's card is wrong ("это не Испания"). */
export interface CreoReport {
  id: number;
  userId: number;
  login: string;
  text: string;
  createdAt: number;
  mine: boolean;
}

/** One person's "this creative is a repeat" mark. */
export interface DuplicateMark {
  userId: number;
  login: string;
  /** Creative ID of the original, if the person named it (e.g. `SUS-0087`). */
  originalId: string | null;
  createdAt: number;
  mine: boolean;
}

/** A creative as it entered the library — a row of the admin's upload history. */
export interface HistoryEntry {
  fileId: string;
  creoId: string | null;
  verticalId: number | null;
  name: string;
  geo: string | null;
  /** When it first showed up in this library (ms). */
  firstSeenAt: number;
  /** 'upload' — uploaded through this service; 'drive' — appeared on Drive directly. */
  source: 'upload' | 'drive';
  /** Who uploaded it (uploads through the service only). */
  uploadedBy: string | null;
  /** Gone from Drive without being deleted here. */
  removed: boolean;
  /** Deleted through the service: moved to the Drive trash (ms). */
  deletedAt: number | null;
  deletedBy: string | null;
}

/** A top-level Drive folder: the sidebar's unit and the prefix of creative IDs. */
export interface Vertical {
  id: number;
  /** Folder name; '' for files lying in the library root. */
  name: string;
  /** Prefix of new IDs (three Latin letters). */
  code: string;
  /** The folder is still on Drive. */
  present: boolean;
  /** Videos currently in it, not removed from Drive. */
  count: number;
  /** ID the next creative here will get. */
  nextId: string;
}

/** A user's own label on creatives: "в работе", "на тест"… */
export interface Tag {
  id: number;
  name: string;
  color: string;
  ownerId: number;
  ownerLogin: string;
  /** Belongs to the viewer — only then can it be applied, renamed, deleted. */
  mine: boolean;
  /** Creatives carrying it. */
  count: number;
}

export interface VideoPatch {
  note?: string;
  /** Country code; null clears it. Setting it pins it against name guessing. */
  geo?: string | null;
}

/** Transcript and translation of one creative (loaded when it is opened). */
export interface CreoText {
  status: 'pending' | 'done' | 'failed';
  lang: string | null;
  transcript: string | null;
  transcriptRu: string | null;
  error: string | null;
  translateError: string | null;
}

export interface CreoQueueState {
  /** WHISPER_URL is configured. */
  enabled: boolean;
  /** ANTHROPIC_API_KEY is configured. */
  translationEnabled: boolean;
  pending: number;
  done: number;
  failed: number;
  /** Transcribed, waiting for a Russian translation. */
  untranslated: number;
  current: { id: string; name: string; step: 'transcribe' | 'translate' } | null;
  /** Why the queue is paused (sidecar unreachable…), if it is. */
  lastError: string | null;
  /** Why translation alone is paused (no API credit, bad key…), if it is. */
  translationPaused: string | null;
}

export interface DriveFolder {
  id: string;
  /** Relative to the library root; '' is the root itself. */
  path: string;
}

export interface UploadInput {
  file: File;
  folderId: string;
  /** File name on Drive (defaults to the local one). */
  name?: string;
  geo?: string | null;
}

/* ============================ Офферы ============================ */

export interface Offer {
  id: number;
  name: string;
  vertical: string;
  /** Country code (MX, IN…) or ''. */
  geo: string;
  /** Партнёрка (ПП). */
  partner: string;
  /** Hand-set cap, leads a day. */
  cap: number | null;
  payout: number | null;
  payoutCurrency: string;
  /** Price on the landing, as written ("990 MXN"). */
  landPrice: string;
  /** Гарант: % of leads the partner pays for whatever the outcome. */
  guarantee: number | null;
  /** Бриф / состав. */
  brief: string;
  /** Режим КЦ (hours). */
  ccMode: string;
  ccLanguage: string;
  regionExclusions: string;
  photoUrl: string | null;
  active: boolean;
  updatedAt: number;
  updatedBy: string | null;
}

export type OfferInput = Omit<Offer, 'id' | 'photoUrl' | 'updatedAt' | 'updatedBy'> & { id?: number };

/* ============================ Уведомления ============================ */

/** One event from some module; a person sees those of the sections they can open. */
export interface AppNotification {
  id: number;
  section: Section;
  title: string;
  /** Details, one change per line. */
  body: string;
  /** In-app path, e.g. "/offers?open=12". */
  link: string | null;
  /** Who did it; null — the system. */
  actor: string | null;
  createdAt: number;
  unread: boolean;
}

export interface NotificationPage {
  items: AppNotification[];
  unread: number;
}

/* ============================ База знаний ============================ */

/** A document in the list: no body. */
export interface KbDocSummary {
  id: number;
  title: string;
  /** Free-text section name; documents are grouped by it. '' = no section. */
  topic: string;
  /** The start of the text, for the list. */
  excerpt: string;
  hasVideo: boolean;
  hasImage: boolean;
  createdBy: string | null;
  updatedAt: number;
}

export interface KbDoc extends KbDocSummary {
  /** Sanitized by the server: headings, text marks, lists, links, images and videos of our own. */
  html: string;
}

export interface KbDocInput {
  id?: number;
  title: string;
  topic: string;
  html: string;
}

/** An image or video uploaded for a document; `url` goes into its HTML. */
export interface KbFile {
  id: string;
  url: string;
  kind: 'image' | 'video';
  name: string;
}

/* ============================ Stats ============================ */

export interface StatsFilter {
  /** Inclusive, YYYY-MM-DD (UTC). */
  from: string;
  to: string;
  land?: string | null;
  device?: string | null;
  country?: string | null;
  buyer?: string | null;
}

export interface LandVideoSummary {
  id: number;
  land: string;
  videoKey: string;
  src: string;
  durationSec: number | null;
  popupAtSec: number | null;
  driveFileId: string | null;
  driveFileName: string | null;
  /** Name from craft-lander's video catalog, matched by stream URL. */
  craftName: string | null;
  /** The player hid the stream behind a blob: URL and the tracker could not resolve it. */
  unresolvedSrc: boolean;
  lastSeenAt: number;

  views: number;
  plays: number;
  playRate: number | null;
  avgWatchSec: number | null;
  medianWatchSec: number | null;
  /** Share of plays that watched ≥ 90% of the video. */
  completionRate: number | null;
  submits: number;
  /** Submits / views. */
  conversion: number | null;
  avgWatchSubmittersSec: number | null;
  errors: number;
}

/** The metric block shared by a landing-video row and a group of them. */
export interface StatsMetrics {
  views: number;
  plays: number;
  playRate: number | null;
  avgWatchSec: number | null;
  medianWatchSec: number | null;
  completionRate: number | null;
  submits: number;
  conversion: number | null;
  avgWatchSubmittersSec: number | null;
  errors: number;
}

/** Totals for one video across landings, or one landing across videos. */
export interface GroupSummary extends StatsMetrics {
  /** Stream URL (by video) or landing name (by landing). */
  key: string;
  label: string;
  durationSec: number | null;
  /** Rows of `StatsOverview.rows` in this group. */
  memberIds: number[];
}

export interface StatsOverview {
  rows: LandVideoSummary[];
  byVideo: GroupSummary[];
  byLand: GroupSummary[];
}

export interface RetentionPoint {
  sec: number;
  /** Plays that watched this second. */
  viewers: number;
  /** viewers / plays. */
  share: number;
  /** Same share among plays that went on to submit the form; null without submitters. */
  submitShare: number | null;
}

export interface BreakdownRow {
  key: string;
  views: number;
  plays: number;
  avgWatchSec: number | null;
  submits: number;
}

export interface DailyRow {
  day: string;
  views: number;
  plays: number;
  avgWatchSec: number | null;
  submits: number;
}

export interface LandVideoDetail {
  summary: LandVideoSummary;
  retention: RetentionPoint[];
  /** Share of plays still watching at the popup moment. */
  popupReach: number | null;
  /** Watch-time histogram in buckets of `bucketSec`. */
  histogram: { fromSec: number; plays: number; submits: number }[];
  bucketSec: number;
  byDevice: BreakdownRow[];
  byCountry: BreakdownRow[];
  byBuyer: BreakdownRow[];
  daily: DailyRow[];
}

export interface CraftStatus {
  /** CRAFT_VIDEOS_FILE is set. */
  configured: boolean;
  count: number;
  syncedAt: number | null;
  error: string | null;
}

export interface StatsFacets {
  lands: string[];
  devices: string[];
  countries: string[];
  buyers: string[];
}

export interface LandVideoPatch {
  driveFileId?: string | null;
  popupAtSec?: number | null;
}

/* ============================ Caps ============================ */

/** An offer in Keitaro — what a cap is assembled from. */
export interface KeitaroOffer {
  id: number;
  name: string;
  group: string | null;
  /** Affiliate network (the partner) in Keitaro. */
  networkId: number | null;
  network: string | null;
  country: string | null;
  archived: boolean;
}

/**
 * Which Keitaro offers a cap takes: every offer of the partner, optionally
 * narrowed by geo and words in the name — offers added later join by
 * themselves.
 */
export interface CapRule {
  networkId: number;
  /** Keitaro's country value (e.g. "India"); null — any. */
  country: string | null;
  /** Every word must occur in the offer name; '' — no filter. */
  nameContains: string;
}

/** A partner's daily lead limit for one offer, e.g. "Proman · IN — 600". */
export interface CapInput {
  id?: number;
  name: string;
  dailyLimit: number;
  /** Set: offers come from the rule (minus `excludedIds`). Null: the fixed `offerIds`. */
  rule: CapRule | null;
  excludedIds: number[];
  /** Manual caps: Keitaro offers whose leads count towards it. */
  offerIds: number[];
  note: string;
  active: boolean;
}

/** One test event for Meta Conversions API (`apifb:send`). */
export interface ApifbSendInput {
  pixelId: string;
  accessToken: string;
  /** Lead, Purchase, … — whatever the pixel expects. */
  eventName: string;
  /** Events Manager → Test events; keeps the hit out of production stats. */
  testEventCode?: string | null;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  city?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
  /** Keitaro click id / our external_id. */
  externalId?: string | null;
  /** fbclid or already-built `fb.…` cookie value. */
  fbc?: string | null;
  eventSourceUrl?: string | null;
  value?: number | null;
  currency?: string | null;
  /** Unix seconds from the dump; null → server uses now. */
  eventTime?: number | null;
}

/** What Meta answered; token never comes back. */
export interface ApifbSendResult {
  ok: boolean;
  eventsReceived: number | null;
  fbtraceId: string | null;
  messages: unknown[];
  error: string | null;
  /** Body we POSTed, without the access token. */
  request: unknown;
}

export interface ApifbVerticalInfo {
  id: string;
  label: string;
}

/** Directions from «Пиксельная»; `warning` if Sheets API is off and we used a fallback. */
export interface ApifbVerticalsResult {
  items: ApifbVerticalInfo[];
  warning: string | null;
}

export interface ApifbGeoInfo {
  id: string;
  label: string;
  region: string | null;
  docId: string;
}

export interface ApifbPreview {
  geoLabel: string;
  docId: string;
  count: number;
  /** First few event names + phone/ip, no tokens. */
  sample: string[];
}

/** One dump event without destination pixel/token (filled at send time). */
export type ApifbEventPayload = Omit<ApifbSendInput, 'pixelId' | 'accessToken' | 'testEventCode'>;

export interface ApifbLoadInput {
  verticalId?: string | null;
  geoId?: string | null;
  rawText?: string | null;
}

export interface ApifbLoadResult {
  geoLabel: string;
  docId: string;
  events: ApifbEventPayload[];
}

/** One Graph chunk (≤50 events). UI walks chunks for live progress. */
export interface ApifbBatchInput {
  pixelId: string;
  accessToken: string;
  events: ApifbEventPayload[];
  testEventCode?: string | null;
  /** For numbering errors across chunks. */
  indexOffset?: number | null;
}

export interface ApifbBatchItemResult {
  index: number;
  ok: boolean;
  eventName: string;
  error: string | null;
}

export interface ApifbBatchResult {
  total: number;
  ok: number;
  failed: number;
  items: ApifbBatchItemResult[];
}

/**
 * under — at this pace the day ends below 90% of the limit;
 * ok — on track; risk — at this pace the limit is exceeded; over — already exceeded.
 */
export type CapStatus = 'under' | 'ok' | 'risk' | 'over';

export interface CapDay {
  id: number;
  name: string;
  dailyLimit: number;
  note: string;
  active: boolean;
  rule: (CapRule & { networkName: string | null }) | null;
  excludedIds: number[];
  /** Partners and geos of the cap's offers — for filtering the page. */
  networks: string[];
  countries: string[];
  /** The offers counted (for a rule cap: as resolved from Keitaro just now). */
  offers: { id: number; name: string; leads: number }[];
  /** Every lead today, whatever its status. */
  leads: number;
  /** End-of-day estimate at the pace of the last hours; null for a past day. */
  projected: number | null;
  status: CapStatus;
  /** Leads per hour, 0–23 in the cap's time zone. */
  hourly: number[];
}

/** One buyer's share of a cap: leads on the day, payback over a longer window. */
export interface CapBuyerRow {
  /** Keitaro campaign group = buyer code; null — campaigns outside any group. */
  buyer: string | null;
  /** Leads on the cap's day. */
  dayLeads: number;
  /** Over the window (`CapBuyers.days`, ending on the cap's day). */
  leads: number;
  /** Approved (sales) — revenue comes from these, days after the lead. */
  sales: number;
  /** Leads the network hasn't decided on yet. */
  waiting: number;
  rejected: number;
  /** Payouts of approved leads only. */
  revenue: number;
  /** Expected payout of leads still pending — counted nowhere until approved. */
  pending: number;
  cost: number;
  /** Spend never reached Keitaro (extra landings, sync gap): ROI unknown, not zero. */
  costMissing: boolean;
  /** revenue − cost, approved leads only; null when cost is missing. */
  profit: number | null;
  /** (revenue − cost) / cost, %, on approved leads only; null when cost is missing. */
  roi: number | null;
  /** The same if every pending lead got approved — an upper bound, not a result. */
  roiIfApproved: number | null;
}

export interface CapBuyers {
  date: string;
  days: number;
  rows: CapBuyerRow[];
}

export interface CapsReport {
  /** KEITARO_URL and KEITARO_API_KEY are set. */
  configured: boolean;
  /** YYYY-MM-DD in `timezone`. */
  date: string;
  isToday: boolean;
  timezone: string;
  /** Hours of the day already gone (fractional), for today. */
  elapsedHours: number;
  fetchedAt: number | null;
  /** Keitaro refused or was unreachable. */
  error: string | null;
  /** TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set — alerts go out. */
  telegram: boolean;
  caps: CapDay[];
}

/* ============================ Domains ============================ */

export type RenewDecision = 'yes' | 'no' | 'ask';

/** A registrable domain: Namecheap's record of it plus what Keitaro serves on it. */
export interface RootDomain {
  name: string;
  /** In the Namecheap account (else known only from Keitaro). */
  namecheap: boolean;
  /** YYYY-MM-DD. */
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  autoRenew: boolean;
  /** DNS on Namecheap's own servers, or elsewhere (Cloudflare). */
  dns: 'namecheap' | 'other' | null;
  /** A buyer, or a team whose buyers share it (shared pixel); null — not assigned. */
  owner: string | null;
  team: string | null;
  sharedPixel: boolean;
  /** The team's own infrastructure (tracker, this app): listed apart, never cleaned up. */
  service: boolean;
  banned: boolean;
  renew: RenewDecision | null;
  renewNote: string;
  /** Hosts of it in Keitaro. */
  subdomains: number;
  /** Of the 30 standard names, still free to issue. */
  freeSlots: number;
  bannedSubs: number;
  /** Of those, Keitaro reports an error (doesn't resolve…). */
  keitaroErrors: number;
  /** Keitaro groups = buyers. */
  buyers: string[];
  lastAddedAt: string | null;
  /** USD for a year (renewal; reactivation when expired is priced the same). */
  renewPrice: number | null;
}

export interface DomainsOverview {
  namecheap: boolean;
  keitaro: boolean;
  /** Namecheap account balance, USD (last known). */
  balance: number | null;
  /** Prices or balance are still being fetched for the first time — ask again shortly. */
  pending: boolean;
  error: string | null;
  fetchedAt: number;
  /** TLD → USD for registering a new domain (first year). */
  registerPrices: Record<string, number>;
  roots: RootDomain[];
}

/** One of a root's 30 slots, or an extra host Keitaro has on it. */
export interface SubdomainSlot {
  /** The label (`telemedicine`). */
  name: string;
  host: string;
  state: 'issued' | 'free' | 'banned';
  buyer: string | null;
  campaign: string | null;
  /** Keitaro sees it working. */
  ok: boolean;
  error: string | null;
  createdAt: string | null;
  /** Not one of the 30 standard names. */
  extra: boolean;
}

export interface RootPatch {
  owner?: string | null;
  team?: string | null;
  sharedPixel?: boolean;
  service?: boolean;
  banned?: boolean;
  renew?: RenewDecision | null;
  renewNote?: string;
}

export interface IssueInput {
  root: string;
  /** Keitaro group (buyer code); created if missing. */
  buyer: string;
  /** Labels from the 30 standard names. */
  names: string[];
}

export interface IssueResult {
  host: string;
  ok: boolean;
  error: string | null;
}

export interface DomainCheck {
  domain: string;
  available: boolean;
  /** USD, first year. */
  price: number | null;
}

export interface BuyInput {
  domain: string;
  owner: string | null;
  team: string | null;
  sharedPixel: boolean;
}

export interface BuyResult {
  domain: string;
  ok: boolean;
  charged: number | null;
  steps: { step: string; ok: boolean; detail: string | null }[];
}

export interface RenewResult {
  domain: string;
  ok: boolean;
  charged: number | null;
  expiresAt: string | null;
  error: string | null;
}

/* ============================ Public API keys ============================ */

/** A key for the read-only stats API (`/api/v1`); the key itself is shown only once. */
export interface ApiKeyInfo {
  id: number;
  name: string;
  /** Start of the key, to tell keys apart. */
  prefix: string;
  createdAt: number;
  createdBy: string | null;
  lastUsedAt: number | null;
}

/* ============================ API surface ============================ */

/* ------------------------- Keitaro access ("Доступы") ------------------------- */

/** What gets shared: a Keitaro offer/landing group or a single offer/landing. */
export type GrantKind = 'offer_group' | 'offer' | 'landing_group' | 'landing';

export interface GrantTarget {
  kind: GrantKind;
  id: number;
  name: string;
}

export interface GrantItem {
  id: number;
  name: string;
  archived: boolean;
  /** Keitaro logins holding this one item directly (not through its group). */
  holders: string[];
}

export interface GrantGroup {
  /** 0 — items outside any group (shared only one by one). */
  id: number;
  name: string;
  /** Keitaro logins holding the whole group. */
  holders: string[];
  /** Newest first. */
  items: GrantItem[];
}

export interface GrantTeam {
  id: number;
  name: string;
  /** Our account that leads the team: may share to it and edit it. */
  leadUserId: number | null;
  leadLogin: string | null;
  /** Keitaro logins. */
  members: string[];
}

export interface GrantTeamInput {
  id?: number;
  name: string;
  /** Ignored for a team lead: their team is always theirs. */
  leadUserId: number | null;
  members: string[];
}

export interface GrantsOverview {
  /** Keitaro logins of non-admin users. */
  buyers: string[];
  /** Newest groups first. */
  offerGroups: GrantGroup[];
  landingGroups: GrantGroup[];
  /** Users who see every offer / landing anyway. */
  fullOffers: string[];
  fullLandings: string[];
  /** All teams for the head of buying; a team lead's own otherwise. */
  teams: GrantTeam[];
  /** Head of buying (or admin): every team, every buyer. */
  head: boolean;
  /** Logins the caller may share to; null — anyone. */
  shareable: string[] | null;
  /** Accounts that can lead a team (head only). */
  leads: { id: number; login: string }[];
}

/** Add `target` to some users and take it from others (Keitaro logins). */
export interface GrantChange {
  target: GrantTarget;
  add: string[];
  remove: string[];
}

/** One Keitaro user's outcome of a share. */
export interface GrantResult {
  login: string;
  ok: boolean;
  /** What happened: "выдано 3, забрано 1", "всё уже было как надо"… */
  note?: string;
  error?: string;
}

/** One target of a share; rows of one share have the same `batchId`. */
export interface GrantLogEntry {
  id: number;
  batchId: number;
  at: number;
  by: string | null;
  kind: GrantKind;
  targetId: number;
  targetName: string;
  added: string[];
  removed: string[];
  failed: string[];
}

export interface VslStatApi {
  auth: {
    session(): Promise<AuthState>;
    login(login: string, password: string): Promise<SessionUser>;
    logout(): Promise<void>;
  };
  /** Admin only. */
  users: {
    list(): Promise<UserInfo[]>;
    create(input: UserInput): Promise<UserInfo>;
    update(id: number, patch: UserPatch): Promise<void>;
    setPassword(id: number, password: string): Promise<void>;
    /** Access roles with their sections. */
    roles(): Promise<AccessRole[]>;
    saveRole(role: AccessRoleInput): Promise<AccessRole>;
    /** Accounts that had it fall back to the default sections. */
    deleteRole(id: number): Promise<void>;
  };
  drive: {
    status(): Promise<DriveStatus>;
    /** Absolute URL to start the Google consent screen (full-page navigation). */
    connectUrl(): string;
    disconnect(): Promise<void>;
    sync(): Promise<SyncState>;
  };
  library: {
    list(): Promise<LibraryVideo[]>;
    update(id: string, patch: VideoPatch): Promise<void>;
    thumbUrl(id: string): string;
    streamUrl(id: string): string;
    verticals(): Promise<Vertical[]>;
    /** Admin only: change the code of new IDs in a vertical. */
    saveVertical(id: number, code: string): Promise<void>;
    folders(): Promise<DriveFolder[]>;
    text(id: string): Promise<CreoText>;
    retranscribe(id: string): Promise<void>;
    queue(): Promise<CreoQueueState>;
    /** Upload a creative into a Drive folder; progress is 0–100 or null when unknown. */
    upload(input: UploadInput, onProgress?: (percent: number | null) => void): Promise<{ id: string }>;
    /** Admin only: move the file to the Drive trash and hide it from the library for good. */
    delete(id: string): Promise<void>;
  };
  reports: {
    /** Report a mistake in a creative's card; rewords the viewer's open report. */
    save(fileId: string, text: string): Promise<CreoReport>;
    /** Withdraw the viewer's own open report. */
    remove(fileId: string): Promise<void>;
    /** Admin only: fixed — close every open report on the creative. */
    resolve(fileId: string): Promise<void>;
  };
  duplicates: {
    /** Mark a creative as a repeat (of `originalId`, if given); replaces the viewer's own mark. */
    mark(fileId: string, originalId: string | null): Promise<DuplicateMark>;
    /** Take the viewer's own mark off. */
    unmark(fileId: string): Promise<void>;
    /** Admin only: "не повтор" — drop every mark on the creative. */
    clear(fileId: string): Promise<void>;
  };
  /** Admin only. */
  caps: {
    /** Every cap with its leads for the day (YYYY-MM-DD; today by default). */
    report(date?: string): Promise<CapsReport>;
    /** Offers in Keitaro to pick from. */
    offers(): Promise<KeitaroOffer[]>;
    save(input: CapInput): Promise<void>;
    delete(id: number): Promise<void>;
    /** Send a test message to the alerts chat. */
    testTelegram(): Promise<void>;
    /** Who fills the cap: leads per buyer on `date`, payback over the `days` up to it. */
    buyers(capId: number, date: string, days: number): Promise<CapBuyers>;
  };
  /** Admin only: the owner's company dashboard. */
  dashboard: {
    /** The week / month holding `anchor` (YYYY-MM-DD, default today) and the periods before it. */
    overview(kind: DashPeriodKind, anchor?: string | null): Promise<Dashboard>;
    detail(metricId: string, kind: DashPeriodKind, anchor: string): Promise<DashDetail>;
    /** Re-read Kaiten now instead of waiting for the half-hourly sync. */
    sync(): Promise<void>;
  };
  /** The head of buying (section `grants`) and team leads (their own teams). */
  grants: {
    overview(): Promise<GrantsOverview>;
    /** One share: any number of targets, one Keitaro write per user. */
    apply(changes: GrantChange[]): Promise<GrantResult[]>;
    saveTeam(input: GrantTeamInput): Promise<GrantTeam>;
    deleteTeam(id: number): Promise<void>;
    log(): Promise<GrantLogEntry[]>;
  };
  /** Admin only. */
  domains: {
    /** Root domains from Namecheap, Keitaro and our registry; `fresh` skips the 10-minute cache. */
    overview(fresh?: boolean): Promise<DomainsOverview>;
    /** A root's 30 slots plus any other hosts Keitaro has on it. */
    subdomains(root: string): Promise<SubdomainSlot[]>;
    update(root: string, patch: RootPatch): Promise<void>;
    /** Ban (or unban) one subdomain; a ban can also take it out of Keitaro. */
    banSub(host: string, banned: boolean, removeFromKeitaro: boolean): Promise<void>;
    /** Buyer codes (Keitaro domain groups). */
    buyers(): Promise<string[]>;
    /** Create subdomains for a buyer: Cloudflare record + Keitaro domain each. */
    issue(input: IssueInput): Promise<IssueResult[]>;
    /** Remove every host of a root from Keitaro (expired, not renewed, banned). */
    cleanup(root: string): Promise<{ removed: number }>;
    /** Pay Namecheap for a year of each (reactivates expired ones). */
    renew(domains: string[]): Promise<RenewResult[]>;
    check(domains: string[]): Promise<DomainCheck[]>;
    /** Register on Namecheap, add to Cloudflare, point NS there. */
    buy(input: BuyInput): Promise<BuyResult>;
  };
  /** Everyone signed in; each sees the events of the sections they can open. */
  notifications: {
    /** Newest first; `before` — an id, for the next page. */
    list(before?: number | null): Promise<NotificationPage>;
    unread(): Promise<number>;
    markRead(): Promise<void>;
  };
  /** Section `offers` reads; `offersEdit` writes. */
  offers: {
    list(): Promise<Offer[]>;
    save(input: OfferInput): Promise<Offer>;
    delete(id: number): Promise<void>;
    /** ПП names from Keitaro (affiliate networks), for the form. */
    partners(): Promise<string[]>;
    /** Replace the offer's photo (png, jpg, webp up to 10 MB). */
    uploadPhoto(id: number, file: File): Promise<Offer>;
  };
  /** Everyone reads; the admin adds, edits and deletes. */
  knowledge: {
    list(): Promise<KbDocSummary[]>;
    get(id: number): Promise<KbDoc>;
    save(input: KbDocInput): Promise<KbDoc>;
    /** The document and the files only it used (to the Drive trash). */
    delete(id: number): Promise<void>;
    /** An image or video for a document, uploaded to Drive. */
    upload(file: File, onProgress?: (percent: number | null) => void): Promise<KbFile>;
  };
  /** Admin only. */
  history: {
    /** Every creative that ever entered the library, deleted ones included. */
    list(): Promise<HistoryEntry[]>;
  };
  /**
   * Admin only: Facebook Conversions API — one-off test and batch replay
   * from «Пиксельная» dumps (pixel+token replaced; same as Keitaro `/apifb`).
   */
  apifb: {
    send(input: ApifbSendInput): Promise<ApifbSendResult>;
    /** Sheet tabs of «Пиксельная»; `fresh` bypasses the short server cache. */
    verticals(fresh?: boolean): Promise<ApifbVerticalsResult>;
    geos(verticalId: string, fresh?: boolean): Promise<ApifbGeoInfo[]>;
    preview(verticalId: string, geoId: string): Promise<ApifbPreview>;
    /** Pull parsed events from the Doc / paste (no Meta call yet). */
    load(input: ApifbLoadInput): Promise<ApifbLoadResult>;
    /** Send ≤50 events in one Meta request. */
    batch(input: ApifbBatchInput): Promise<ApifbBatchResult>;
  };
  tags: {
    /** Tags the viewer may see, with their owners. */
    list(): Promise<Tag[]>;
    /** Create or rename/recolor one of the viewer's own tags. */
    save(tag: { id?: number; name: string; color: string }): Promise<Tag>;
    delete(id: number): Promise<void>;
    /** Put one of the viewer's tags on a creative, or take it off. */
    toggle(fileId: string, tagId: number, on: boolean): Promise<void>;
  };
  stats: {
    facets(): Promise<StatsFacets>;
    overview(filter: StatsFilter): Promise<StatsOverview>;
    detail(id: number, filter: StatsFilter): Promise<LandVideoDetail>;
    updateLandVideo(id: number, patch: LandVideoPatch): Promise<void>;
    deleteLandVideo(id: number): Promise<void>;
    /** Snippet to paste into a landing, built from the server's public URL. */
    snippet(): Promise<string>;
    /** Keys for the read-only stats API. */
    apiKeys(): Promise<ApiKeyInfo[]>;
    /** Issue a key; `key` is returned this once only. */
    createApiKey(name: string): Promise<{ key: string; info: ApiKeyInfo }>;
    revokeApiKey(id: number): Promise<void>;
    /** Base URL of the stats API, e.g. https://…/api/v1. */
    apiBase(): Promise<string>;
    craftStatus(): Promise<CraftStatus>;
  };
}
