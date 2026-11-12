import { MonogramComponent } from '../../core/components/monogram.component';
import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../core/services/api.service';

/**
 * Sign-in screen: personal login + password.
 *
 * Shown by the app shell instead of the navigation whenever there is no valid
 * session, so no page ever renders (and fires API calls) while logged out.
 */
@Component({
  selector: 'app-login',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MonogramComponent,
  ],
  template: `
    <div class="login-screen">
      <form class="login-card" (ngSubmit)="submit()">
        <div class="login-brand">
          <app-monogram [size]="40" />
          <div class="login-wordmark">
            <span class="login-parent">Euphoria</span>
            <span class="login-sep">/</span>
            <span class="login-product">analytics</span>
          </div>
        </div>

        <mat-form-field appearance="outline">
          <mat-label>Логин</mat-label>
          <input
            matInput
            name="login"
            autocomplete="username"
            [(ngModel)]="login"
            [disabled]="busy()"
            autofocus
          />
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Пароль</mat-label>
          <input
            matInput
            type="password"
            name="password"
            autocomplete="current-password"
            [(ngModel)]="password"
            [disabled]="busy()"
          />
        </mat-form-field>

        @if (error(); as message) {
          <div class="login-error">{{ message }}</div>
        }

        <button
          mat-flat-button
          color="primary"
          type="submit"
          [disabled]="busy() || !login().trim() || !password()"
        >
          <mat-icon>login</mat-icon>
          <span>{{ busy() ? 'Проверяю…' : 'Войти' }}</span>
        </button>

        @if (busy()) {
          <mat-progress-bar mode="indeterminate" />
        }
      </form>
    </div>
  `,
  styles: [
    `
      .login-screen {
        height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .login-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 320px;
      }
      /* The first screen anyone sees, so the mark gets room: monogram above,
         wordmark under it, nothing else competing. */
      .login-brand {
        display: flex;
        flex-direction: column;
        gap: 16px;
        margin-bottom: 20px;
        color: var(--text);
      }
      .login-wordmark {
        display: flex;
        align-items: baseline;
        gap: 8px;
        font-family: var(--font-mono);
        font-size: 11px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
      }
      .login-parent {
        color: var(--text);
      }
      .login-sep {
        color: var(--divider-strong);
      }
      .login-product {
        color: var(--text-faint);
      }
      .login-error {
        font-size: 13px;
        color: var(--danger);
      }
    `,
  ],
})
export class LoginPage {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly login = signal('');
  readonly password = signal('');
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    const login = this.login().trim();
    const password = this.password();
    if (!login || !password || this.busy()) return;

    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.login(login, password);
      this.password.set('');
      // Stay on the deep link unless this account can't open it.
      if (!this.api.canOpen(this.router.url)) {
        void this.router.navigateByUrl(this.api.homePath());
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
