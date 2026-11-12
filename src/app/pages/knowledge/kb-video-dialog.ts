import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { ApiService } from '../../core/services/api.service';
import { formatBytes } from '../../core/format';
import type { KbDoc } from '../../../shared/api.types';

export interface KbVideoData {
  topics: string[];
  topic: string;
}

/** Admin: a video as a document of its own — pick the file, name it, put it in a section. */
@Component({
  selector: 'app-kb-video',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <h2 mat-dialog-title>Добавить видео</h2>
    <mat-dialog-content>
      <div class="fields">
        <div class="file">
          <button mat-stroked-button type="button" (click)="picker.click()" [disabled]="busy()">
            <mat-icon>upload_file</mat-icon>{{ file() ? 'Другой файл' : 'Выбрать видео' }}
          </button>
          <input #picker type="file" accept="video/*" hidden (change)="pick(picker)" />
          @if (file(); as f) {
            <span class="fname">{{ f.name }} · {{ bytes(f.size) }}</span>
          }
        </div>
        <label>
          <span>Название</span>
          <input [(ngModel)]="title" [disabled]="busy()" maxlength="200" placeholder="Например: «Как заводить кампанию в Keitaro»" />
        </label>
        <label>
          <span>Раздел</span>
          <input [(ngModel)]="topic" [disabled]="busy()" maxlength="80" list="kb-video-topics" placeholder="Существующий или новый" />
          <datalist id="kb-video-topics">
            @for (t of data.topics; track t) {
              <option [value]="t"></option>
            }
          </datalist>
        </label>
      </div>
      @if (busy()) {
        <mat-progress-bar [mode]="progress() === null ? 'indeterminate' : 'determinate'" [value]="progress() ?? 0" />
        <div class="hint">Загружаю на Google Drive{{ progress() !== null ? ' · ' + progress() + '%' : '' }}…</div>
      }
      @if (error(); as e) {
        <div class="error">{{ e }}</div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close [disabled]="busy()">Отмена</button>
      <button mat-flat-button (click)="save()" [disabled]="busy() || !file() || !title.trim()">Загрузить</button>
    </mat-dialog-actions>
  `,
  styles: [
    `
      .fields {
        display: flex;
        flex-direction: column;
        gap: 14px;
        width: min(480px, 100%);
        margin-bottom: 12px;
      }
      .file {
        display: flex;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
      }
      .fname {
        font-size: 13px;
        color: var(--text-muted);
        overflow-wrap: anywhere;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        color: var(--text-muted);
      }
      label input {
        padding: 9px 12px;
        border: 1px solid var(--divider-strong);
        border-radius: 8px;
        background: var(--surface);
        color: var(--text);
        font: inherit;
        font-size: 14px;
      }
      label input:focus {
        outline: 2px solid var(--ring);
      }
      .hint {
        margin-top: 6px;
        font-size: 12px;
        color: var(--text-muted);
      }
      .error {
        margin-top: 10px;
        color: var(--danger);
        font-size: 13px;
      }
    `,
  ],
})
export class KbVideoDialog {
  private readonly api = inject(ApiService);
  private readonly ref = inject(MatDialogRef<KbVideoDialog, KbDoc>);
  readonly data = inject<KbVideoData>(MAT_DIALOG_DATA);

  title = '';
  topic = this.data.topic;
  readonly file = signal<File | null>(null);
  readonly busy = signal(false);
  readonly progress = signal<number | null>(null);
  readonly error = signal<string | null>(null);
  bytes = formatBytes;

  pick(el: HTMLInputElement): void {
    const f = el.files?.[0] ?? null;
    el.value = '';
    this.file.set(f);
    if (f && !this.title.trim()) this.title = f.name.replace(/\.[^.]+$/, '');
  }

  async save(): Promise<void> {
    const f = this.file();
    if (!f) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const up = await this.api.knowledge.upload(f, (p) => this.progress.set(p));
      const doc = await this.api.knowledge.save({
        title: this.title.trim(),
        topic: this.topic.trim(),
        html: `<video src="${up.url}"></video>`,
      });
      this.ref.close(doc);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
      this.busy.set(false);
    }
  }
}
