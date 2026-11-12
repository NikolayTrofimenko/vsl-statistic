import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Clipboard } from '@angular/cdk/clipboard';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';
import { formatDate } from '../../core/format';
import type { AccessRole, AccessRoleInput, Section, TagScope, UserInfo, UserPatch } from '../../../shared/api.types';
import { SECTIONS } from '../../../shared/access';

const TAG_SCOPES: { value: TagScope; label: string }[] = [
  { value: 'own', label: 'Свои' },
  { value: 'team', label: 'Своей команды' },
  { value: 'all', label: 'Все' },
];

/** The "Роль" select: admin is built in, 0 — no role (library only), else a role id. */
const ADMIN = -1;

/**
 * Admin page: create accounts, give each one role (or admin) and a team lead,
 * reset a password, disable an account (disabling or resetting ends its
 * sessions); and the roles themselves — sections, whose tags show, whether
 * the role leads a team.
 */
@Component({
  selector: 'app-users',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
  ],
  template: `
    <header class="page-header">
      <div>
        <h1>Пользователи</h1>
        <p>
          Учётки команды. У каждого одна роль — она решает, какие разделы открыты и чьи теги видно
          (роли настраиваются ниже). Админ видит всё. Саморегистрации нет: логин и пароль выдаёт админ.
        </p>
      </div>
    </header>

    <form class="create" (ngSubmit)="create()">
      <mat-form-field>
        <mat-label>Логин</mat-label>
        <input matInput name="login" [(ngModel)]="login" autocomplete="off" maxlength="40" />
      </mat-form-field>
      <mat-form-field class="password">
        <mat-label>Пароль</mat-label>
        <input matInput name="password" [(ngModel)]="password" autocomplete="new-password" />
        <button mat-icon-button matSuffix type="button" (click)="generate()" matTooltip="Сгенерировать">
          <mat-icon>casino</mat-icon>
        </button>
      </mat-form-field>
      <mat-form-field class="role">
        <mat-label>Роль</mat-label>
        <mat-select name="role" [(ngModel)]="pick">
          @for (r of accessRoles(); track r.id) {
            <mat-option [value]="r.id">{{ r.name }}</mat-option>
          }
          <mat-option [value]="NONE">Без роли (библиотека)</mat-option>
          <mat-option [value]="ADMIN">Админ</mat-option>
        </mat-select>
      </mat-form-field>
      @if (hasLead(pick())) {
        <mat-form-field class="lead">
          <mat-label>Тимлид</mat-label>
          <mat-select name="teamlead" [(ngModel)]="teamleadId">
            <mat-option [value]="NONE">Без тимлида</mat-option>
            @for (t of teamleads(); track t.id) {
              <mat-option [value]="t.id">{{ t.login }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
      <button mat-flat-button color="primary" type="submit" [disabled]="busy() || !login().trim() || password().length < 8">
        <mat-icon>person_add</mat-icon>
        <span>Создать</span>
      </button>
    </form>

    <div class="table-wrap">
      <table class="users">
        <thead>
          <tr>
            <th class="left">Логин</th>
            <th class="left">Роль</th>
            <th class="left">Тимлид</th>
            <th class="left">Создан</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (u of users(); track u.id) {
            <tr [class.inactive]="!u.active">
              <td class="left">
                <span class="login">{{ u.login }}</span>
                @if (u.id === me()?.id) {
                  <span class="me">это ты</span>
                }
                @if (!u.active) {
                  <span class="off">отключён</span>
                }
              </td>
              <td class="left">
                <mat-select
                  class="inline"
                  [value]="pickOf(u)"
                  [disabled]="u.id === me()?.id"
                  (selectionChange)="setPick(u, $event.value)"
                  aria-label="Роль"
                >
                  @for (r of accessRoles(); track r.id) {
                    <mat-option [value]="r.id">{{ r.name }}</mat-option>
                  }
                  <mat-option [value]="NONE">Без роли (библиотека)</mat-option>
                  <mat-option [value]="ADMIN">Админ</mat-option>
                </mat-select>
              </td>
              <td class="left">
                @if (hasLead(pickOf(u))) {
                  <mat-select
                    class="inline"
                    [value]="u.teamleadId ?? NONE"
                    (selectionChange)="update(u, { teamleadId: idOrNull($event.value) })"
                    aria-label="Тимлид"
                  >
                    <mat-option [value]="NONE">—</mat-option>
                    @for (t of teamleads(); track t.id) {
                      <mat-option [value]="t.id">{{ t.login }}</mat-option>
                    }
                  </mat-select>
                } @else {
                  <span class="faint">{{ u.role === 'teamlead' ? 'сам руководит' : '—' }}</span>
                }
              </td>
              <td class="left mono faint">{{ date(u.createdAt) }}</td>
              <td class="actions">
                <button mat-button (click)="resetPassword(u)">
                  <mat-icon>key</mat-icon><span>Сменить пароль</span>
                </button>
                @if (u.id !== me()?.id) {
                  <button mat-button (click)="update(u, { active: !u.active })">
                    <mat-icon>{{ u.active ? 'block' : 'check_circle' }}</mat-icon>
                    <span>{{ u.active ? 'Отключить' : 'Включить' }}</span>
                  </button>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>

    <section class="roles">
      <h2>Роли</h2>
      <p class="hint">
        Роль открывает отмеченные разделы — и только их. «Теги» — чьи теги человек видит в библиотеке.
        «Руководит командой» — к нему можно привязать людей, и он раздаёт им доступы в Keitaro.
        Пользователи, вертикали, подключение Drive, удаление крео и API-ключи остаются только у админа.
        Права меняются сразу; меню у человека обновится, когда он перезагрузит страницу.
      </p>
      <div class="table-wrap">
        <table class="users">
          <thead>
            <tr>
              <th class="left">Роль</th>
              @for (s of sections; track s.id) {
                <th>{{ s.label }}</th>
              }
              <th>Теги</th>
              <th>Руководит командой</th>
              <th>Людей</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (r of accessRoles(); track r.id) {
              <tr>
                <td class="left">
                  <input class="role-name" [value]="r.name" (change)="renameRole(r, $any($event.target).value)" maxlength="40" aria-label="Название роли" />
                </td>
                @for (s of sections; track s.id) {
                  <td class="center">
                    <mat-checkbox [checked]="r.sections.includes(s.id)" (change)="toggleSection(r, s.id, $event.checked)" [attr.aria-label]="s.label" />
                  </td>
                }
                <td class="center">
                  <mat-select class="inline scope" [value]="r.tagScope" (selectionChange)="saveRole({ id: r.id, name: r.name, sections: r.sections, tagScope: $event.value })" aria-label="Чьи теги видно">
                    @for (t of tagScopes; track t.value) {
                      <mat-option [value]="t.value">{{ t.label }}</mat-option>
                    }
                  </mat-select>
                </td>
                <td class="center">
                  <mat-checkbox [checked]="r.leads" (change)="setLeads(r, $event.checked)" aria-label="Руководит командой" />
                </td>
                <td class="center mono">{{ r.users }}</td>
                <td class="actions">
                  <button mat-button (click)="deleteRole(r)"><mat-icon>delete_outline</mat-icon><span>Удалить</span></button>
                </td>
              </tr>
            }
            <tr class="new-role">
              <td class="left">
                <input class="role-name" [(ngModel)]="newRoleName" placeholder="Новая роль, например «Биздев»" maxlength="40" aria-label="Название новой роли" />
              </td>
              @for (s of sections; track s.id) {
                <td class="center">
                  <mat-checkbox [checked]="newRoleSections().has(s.id)" (change)="toggleNewSection(s.id, $event.checked)" [attr.aria-label]="s.label" />
                </td>
              }
              <td class="center">
                <mat-select class="inline scope" [(value)]="newRoleScope" aria-label="Чьи теги видно">
                  @for (t of tagScopes; track t.value) {
                    <mat-option [value]="t.value">{{ t.label }}</mat-option>
                  }
                </mat-select>
              </td>
              <td class="center">
                <mat-checkbox [(ngModel)]="newRoleLeads" aria-label="Руководит командой" />
              </td>
              <td></td>
              <td class="actions">
                <button mat-flat-button [disabled]="!newRoleName.trim()" (click)="createRole()"><mat-icon>add</mat-icon><span>Создать</span></button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .create {
        display: flex;
        align-items: flex-end;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      .password {
        width: 240px;
      }
      .role,
      .lead {
        width: 170px;
      }
      .table-wrap {
        overflow-x: auto;
        background: var(--surface);
        border: 1px solid var(--divider);
      }
      table.users {
        border-collapse: collapse;
        width: 100%;
        font-size: 13px;

        th {
          font-family: var(--font-mono);
          font-size: 10.5px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 400;
          color: var(--text-faint);
          padding: 10px 8px;
          border-bottom: 1px solid var(--divider-strong);
          white-space: nowrap;
        }
        td {
          padding: 6px 8px;
          border-bottom: 1px solid var(--divider);
          white-space: nowrap;
        }
        .left {
          text-align: left;
          padding-left: 14px;
        }
        .actions {
          text-align: right;
          padding-right: 8px;
        }
        tr.inactive td:not(.actions) {
          opacity: 0.5;
        }
      }
      /* Bare mat-selects in the table, at the table's type size. */
      .inline {
        width: 150px;
        font-size: 13px;
        --mat-select-trigger-text-size: 13px;
        --mat-select-trigger-text-line-height: 20px;
      }
      .login {
        font-weight: 500;
      }
      .me,
      .off {
        margin-left: 8px;
        font-family: var(--font-mono);
        font-size: 11px;
        color: var(--text-faint);
      }
      .off {
        color: var(--danger);
      }
      .faint {
        color: var(--text-faint);
      }
      .roles {
        margin-top: 32px;

        h2 {
          font-size: 18px;
          margin: 0 0 4px;
        }
      }
      .hint {
        margin: 0 0 12px;
        color: var(--text-muted);
        font-size: 13px;
        max-width: 760px;
      }
      table.users .center {
        text-align: center;
      }
      .inline.scope {
        width: 130px;
      }
      .role-name {
        width: 220px;
        padding: 4px 8px;
        font: inherit;
        font-size: 13px;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--divider-strong);
      }
      tr.new-role td {
        background: var(--surface-2);
      }
    `,
  ],
})
export class UsersPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);
  private readonly clipboard = inject(Clipboard);

  readonly ADMIN = ADMIN;
  readonly tagScopes = TAG_SCOPES;
  readonly users = signal<UserInfo[]>([]);
  readonly teamleads = computed(() => this.users().filter((u) => u.role === 'teamlead' && u.active));
  readonly me = this.api.user;
  readonly busy = signal(false);
  readonly date = (ms: number) => formatDate(new Date(ms).toISOString());

  readonly login = signal('');
  readonly password = signal('');
  /**
   * "Not set" in the selects: mat-select shows no label for a null value, so
   * the "—" / "Без роли" options carry 0 and are mapped back to null.
   */
  readonly NONE = 0;
  /** The new account's role: ADMIN, NONE or a role id. */
  readonly pick = signal<number>(0);
  readonly teamleadId = signal<number>(0);

  readonly sections = SECTIONS;
  readonly accessRoles = signal<AccessRole[]>([]);
  readonly newRoleSections = signal(new Set<Section>());
  newRoleName = '';
  newRoleScope: TagScope = 'own';
  newRoleLeads = false;

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  idOrNull(id: number | null): number | null {
    return id ? id : null;
  }

  pickOf(u: UserInfo): number {
    return u.role === 'admin' ? ADMIN : (u.accessRoleId ?? this.NONE);
  }

  /** A person with this pick can be attached to a team lead: not admin, and the role doesn't lead. */
  hasLead(pick: number): boolean {
    if (pick === ADMIN) return false;
    return !this.accessRoles().find((r) => r.id === pick)?.leads;
  }

  async setPick(u: UserInfo, pick: number): Promise<void> {
    await this.update(u, pick === ADMIN ? { role: 'admin' } : { role: 'buyer', accessRoleId: this.idOrNull(pick) });
  }

  generate(): void {
    this.password.set(randomPassword());
  }

  async create(): Promise<void> {
    const login = this.login().trim();
    const password = this.password();
    if (!login || password.length < 8 || this.busy()) return;
    this.busy.set(true);
    const created = await this.guard(() =>
      this.api.users.create({
        login,
        password,
        role: this.pick() === ADMIN ? 'admin' : 'buyer',
        teamleadId: this.hasLead(this.pick()) ? this.idOrNull(this.teamleadId()) : null,
        accessRoleId: this.pick() === ADMIN ? null : this.idOrNull(this.pick()),
      }),
    );
    this.busy.set(false);
    if (!created) return;
    this.clipboard.copy(`${login} / ${password}`);
    this.snack.open(`Создан «${login}». Логин и пароль скопированы — передай их.`, 'OK', { duration: 6000 });
    this.login.set('');
    this.password.set('');
    await this.reload();
  }

  async update(user: UserInfo, patch: UserPatch): Promise<void> {
    if (
      patch.active === false &&
      !(await this.ask.confirm({
        title: `Отключить «${user.login}»?`,
        message: 'Его сессии закончатся сразу, войти он больше не сможет.',
        ok: 'Отключить',
        danger: true,
      }))
    ) {
      return;
    }
    await this.guard(() => this.api.users.update(user.id, patch));
    await this.reload();
  }

  async resetPassword(user: UserInfo): Promise<void> {
    const password = await this.ask.prompt({
      title: `Новый пароль для «${user.login}»`,
      message: 'Пароль сменится сразу, все его сессии закончатся. После смены он скопируется в буфер.',
      input: { label: 'Пароль', value: randomPassword(), minLength: 8, hint: 'От 8 символов' },
      ok: 'Сменить пароль',
    });
    if (password == null) return;
    const done = await this.guard(() => this.api.users.setPassword(user.id, password).then(() => true));
    if (!done) return;
    this.clipboard.copy(password);
    this.snack.open(
      user.id === this.me()?.id
        ? 'Пароль сменён и скопирован. Войди заново.'
        : `Пароль «${user.login}» сменён и скопирован. Его сессии закончились.`,
      'OK',
      { duration: 6000 },
    );
    if (user.id === this.me()?.id) await this.api.refreshSession();
  }

  /* ------------------------- access roles ------------------------- */

  toggleNewSection(id: Section, on: boolean): void {
    const next = new Set(this.newRoleSections());
    if (on) next.add(id);
    else next.delete(id);
    this.newRoleSections.set(next);
  }

  async createRole(): Promise<void> {
    const name = this.newRoleName.trim();
    if (!name) return;
    const saved = await this.guard(() =>
      this.api.users.saveRole({ name, sections: [...this.newRoleSections()], tagScope: this.newRoleScope, leads: this.newRoleLeads }),
    );
    if (!saved) return;
    this.newRoleName = '';
    this.newRoleSections.set(new Set());
    this.newRoleScope = 'own';
    this.newRoleLeads = false;
    this.accessRoles.update((list) => [...list, saved].sort((a, b) => a.name.localeCompare(b.name, 'ru')));
    this.snack.open(`Роль «${saved.name}» создана — выбери её в колонке «Роль» у нужных людей.`, 'OK', { duration: 5000 });
  }

  async toggleSection(role: AccessRole, id: Section, on: boolean): Promise<void> {
    const sections = on ? [...role.sections, id] : role.sections.filter((s) => s !== id);
    await this.saveRole({ id: role.id, name: role.name, sections });
  }

  async renameRole(role: AccessRole, name: string): Promise<void> {
    if (name.trim() && name.trim() !== role.name) await this.saveRole({ id: role.id, name: name.trim(), sections: role.sections });
  }

  async setLeads(role: AccessRole, leads: boolean): Promise<void> {
    if (
      !leads &&
      role.users &&
      !(await this.ask.confirm({
        title: `Роль «${role.name}» больше не руководит командой?`,
        message: 'Люди, привязанные к её тимлидам, станут без тимлида, а сами тимлиды перестанут раздавать доступы своей команде.',
        ok: 'Да, снять',
      }))
    ) {
      await this.reload();
      return;
    }
    await this.saveRole({ id: role.id, name: role.name, sections: role.sections, leads });
    // Leads change who can be attached to whom: reload people too.
    await this.reload();
  }

  async deleteRole(role: AccessRole): Promise<void> {
    const sure = await this.ask.confirm({
      title: `Удалить роль «${role.name}»?`,
      message: role.users
        ? `${role.users} чел. останутся без роли — только библиотека крео.`
        : 'Её пока ни у кого нет.',
      ok: 'Удалить',
      danger: true,
    });
    if (!sure) return;
    const ok = await this.guard(() => this.api.users.deleteRole(role.id).then(() => true));
    if (ok) await this.reload();
  }

  async saveRole(role: AccessRoleInput): Promise<void> {
    const saved = await this.guard(() => this.api.users.saveRole(role));
    if (saved) this.accessRoles.update((list) => list.map((r) => (r.id === saved.id ? saved : r)));
    else await this.reload();
  }

  private async reload(): Promise<void> {
    const [users, roles] = await Promise.all([this.guard(() => this.api.users.list()), this.guard(() => this.api.users.roles())]);
    if (users) this.users.set(users);
    if (roles) this.accessRoles.set(roles);
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 6000 });
      return null;
    }
  }
}

/** 12 characters without look-alikes (0/O, 1/l/I), easy to dictate. */
function randomPassword(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
