import { computed, Injectable, signal } from '@angular/core';
import type { Section, SessionUser, VslStatApi } from '../../../shared/api.types';
import { SECTIONS } from '../../../shared/access';
import { createHttpApi } from './api-client';

/**
 * Single entry point to the server API. Also owns the session state, since it
 * is the one place that sees every 401.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  /** null until the first session check resolves. */
  readonly authenticated = signal<boolean | null>(null);

  /** The signed-in account. The server enforces roles; this only shapes the UI. */
  readonly user = signal<SessionUser | null>(null);
  readonly role = computed(() => this.user()?.role ?? null);
  readonly isAdmin = computed(() => this.role() === 'admin');
  /** Sections this account may open (the server decides; this only shapes the UI). */
  readonly sections = computed<Section[]>(() => this.user()?.sections ?? []);

  /**
   * The first session check. Started in the constructor, not as a field
   * initializer: fields initialise top to bottom, and starting it here once
   * ran before `api` below existed — the call threw, the catch read that as
   * "signed out", and every page reload showed the login screen.
   */
  private readonly firstCheck: Promise<boolean>;

  constructor() {
    this.firstCheck = this.refreshSession();
  }

  /** Resolves once the role is known — route guards wait for it. */
  whenReady(): Promise<boolean> {
    return this.firstCheck;
  }

  can(section: Section): boolean {
    return this.isAdmin() || this.sections().includes(section);
  }

  /** "Доступы": the head of buying, and team leads for their own teams. */
  readonly canGrants = computed(() => this.can('grants') || this.role() === 'teamlead');

  /** May this account open the page at `url`? Admin pages need the admin role. */
  canOpen(url: string): boolean {
    if (/^\/(users|verticals|dashboard)(\/|\?|$)/.test(url)) return this.isAdmin();
    if (/^\/grants(\/|\?|$)/.test(url)) return this.canGrants();
    const section = SECTIONS.find((s) => url === s.path || url.startsWith(`${s.path}/`) || url.startsWith(`${s.path}?`));
    return !section || this.can(section.id);
  }

  /** Where to land after sign-in, or when a page is out of reach: the first section it may open. */
  homePath(): string {
    return SECTIONS.find((s) => this.can(s.id))?.path ?? '/library';
  }

  private readonly api: VslStatApi = createHttpApi({
    onUnauthorized: () => this.authenticated.set(false),
  });

  readonly users = this.api.users;
  readonly drive = this.api.drive;
  readonly library = this.api.library;
  readonly tags = this.api.tags;
  readonly duplicates = this.api.duplicates;
  readonly reports = this.api.reports;
  readonly history = this.api.history;
  readonly knowledge = this.api.knowledge;
  readonly offers = this.api.offers;
  readonly caps = this.api.caps;
  readonly domains = this.api.domains;
  readonly grants = this.api.grants;
  readonly dashboard = this.api.dashboard;
  readonly stats = this.api.stats;

  async refreshSession(): Promise<boolean> {
    try {
      const state = await this.api.auth.session();
      this.user.set(state.user);
      this.authenticated.set(state.authenticated);
      return state.authenticated;
    } catch {
      this.authenticated.set(false);
      return false;
    }
  }

  async login(login: string, password: string): Promise<void> {
    this.user.set(await this.api.auth.login(login, password));
    this.authenticated.set(true);
  }

  async logout(): Promise<void> {
    await this.api.auth.logout();
    this.user.set(null);
    this.authenticated.set(false);
  }
}
