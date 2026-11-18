import { Component, computed, DestroyRef, effect, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatListModule } from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ApiService } from './core/services/api.service';
import { MonogramComponent } from './core/components/monogram.component';
import { LoginPage } from './pages/login/login';
import { ThemeService } from './core/services/theme.service';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    LoginPage,
    MonogramComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  readonly api = inject(ApiService);
  readonly theme = inject(ThemeService);

  readonly nav = computed(() =>
    [
      { path: '/notifications', icon: 'notifications', label: 'Уведомления', show: true, badge: this.api.unread() },
      { path: '/dashboard', icon: 'dashboard', label: 'Дашборд', show: this.api.isAdmin() },
      { path: '/library', icon: 'video_library', label: 'Библиотека крео', show: this.api.can('library') },
      { path: '/quality', icon: 'insights', label: 'Качество на лендах', show: this.api.can('quality') },
      { path: '/users', icon: 'group', label: 'Пользователи', show: this.api.isAdmin() },
      { path: '/caps', icon: 'speed', label: 'Капы', show: this.api.can('caps') },
      { path: '/domains', icon: 'language', label: 'Домены', show: this.api.can('domains') },
      { path: '/grants', icon: 'key', label: 'Доступы', show: this.api.canGrants() },
      { path: '/offers', icon: 'local_offer', label: 'Офферы', show: this.api.can('offers') },
      { path: '/knowledge', icon: 'school', label: 'База знаний', show: this.api.can('knowledge') },
      { path: '/apifb', icon: 'send', label: 'Тест Facebook', show: this.api.isAdmin() },
    ].filter((item) => item.show),
  );

  constructor() {
    // The unread counter: now, every minute, and when the tab comes back.
    let timer: ReturnType<typeof setInterval> | null = null;
    const poll = () => {
      if (this.api.authenticated()) this.api.notifications.unread().then((n) => this.api.unread.set(n), () => undefined);
    };
    const onVisible = () => document.visibilityState === 'visible' && poll();
    effect(() => {
      if (timer) clearInterval(timer);
      timer = null;
      if (!this.api.authenticated()) return;
      poll();
      timer = setInterval(poll, 60_000);
    });
    document.addEventListener('visibilitychange', onVisible);
    inject(DestroyRef).onDestroy(() => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    });
  }

  readonly roleLabel = computed(() => this.api.user()?.accessRole ?? ROLE_LABELS[this.api.role() ?? 'buyer']);

  async logout(): Promise<void> {
    await this.api.logout();
  }
}

const ROLE_LABELS = { buyer: 'без роли', teamlead: 'тимлид', admin: 'админ' } as const;
