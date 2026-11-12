import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ApiService } from '../../core/services/api.service';
import { formatBytes } from '../../core/format';
import { COUNTRIES, countryName, geoFromName } from '../../../shared/geo';
import type { DriveFolder } from '../../../shared/api.types';
import { NONE, orNull } from '../../core/select';

export interface UploadDialogData {
  folders: DriveFolder[];
  /** Pre-selected folder path (the section the user was looking at). */
  folderPath?: string;
}

interface Item {
  file: File;
  /** Geo for this file: the dialog's choice, else guessed from the name. */
  geo: string | null;
  progress: number | null;
  state: 'waiting' | 'uploading' | 'done' | 'failed';
  error?: string;
}

/**
 * Upload creatives into a library folder on Google Drive. Files go one after
 * another; each one is transcribed and translated by the server afterwards.
 */
@Component({
  selector: 'app-upload-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatProgressBarModule,
    MatSelectModule,
  ],
  template: `
    <h2 mat-dialog-title>Загрузить крео</h2>
    <mat-dialog-content>
      <div class="fields">
        <mat-form-field>
          <mat-label>Вертикаль (папка на Drive)</mat-label>
          <mat-select [(ngModel)]="folderId" [disabled]="busy()">
            @for (f of data.folders; track f.id) {
              <mat-option [value]="f.id">{{ f.path || 'Корень библиотеки' }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Гео</mat-label>
          <mat-select [ngModel]="geo() ?? NONE" (ngModelChange)="setGeo(orNull($event))" [disabled]="busy()">
            <mat-option [value]="NONE">Из имени файла</mat-option>
            @for (c of countries; track c.code) {
              <mat-option [value]="c.code">{{ c.name }} · {{ c.code }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      </div>

      <label class="drop" [class.over]="dragOver()" (dragover)="onDragOver($event)" (dragleave)="dragOver.set(false)" (drop)="onDrop($event)">
        <input type="file" accept="video/*" multiple (change)="onPick($event)" [disabled]="busy()" />
        <mat-icon>upload_file</mat-icon>
        <span>Перетащи видео сюда или нажми, чтобы выбрать</span>
        <small>Язык и расшифровка определятся автоматически после загрузки</small>
      </label>

      @if (items().length) {
        <ul class="items">
          @for (it of items(); track it.file) {
            <li [class]="'st-' + it.state">
              <div class="row">
                <mat-icon class="state">{{ icon(it) }}</mat-icon>
                <span class="name" [title]="it.file.name">{{ it.file.name }}</span>
                <span class="meta mono">{{ size(it.file.size) }}</span>
                <span class="geo">{{ it.geo ? geoLabel(it.geo) : 'гео не задано' }}</span>
                @if (it.state === 'waiting' && !busy()) {
                  <button mat-icon-button (click)="remove(it)" aria-label="Убрать"><mat-icon>close</mat-icon></button>
                }
              </div>
              @if (it.state === 'uploading') {
                <mat-progress-bar [mode]="it.progress === null ? 'indeterminate' : 'determinate'" [value]="it.progress ?? 0" />
              }
              @if (it.error) {
                <div class="error">{{ it.error }}</div>
              }
            </li>
          }
        </ul>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="close()" [disabled]="busy()">{{ finished() ? 'Готово' : 'Отмена' }}</button>
      @if (!finished()) {
        <button mat-flat-button color="primary" (click)="start()" [disabled]="busy() || !folderId || !waiting()">
          <mat-icon>cloud_upload</mat-icon>
          <span>Загрузить{{ waiting() > 1 ? ' (' + waiting() + ')' : '' }}</span>
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: [
    `
      .fields {
        display: grid;
        grid-template-columns: 1fr 220px;
        gap: 12px;
        padding-top: 4px;
        min-width: 560px;
      }
      .drop {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        margin: 14px 0;
        padding: 26px 16px;
        border: 1px dashed var(--divider-strong);
        color: var(--text-muted);
        cursor: pointer;
        text-align: center;

        input {
          display: none;
        }
        mat-icon {
          font-size: 32px;
          width: 32px;
          height: 32px;
        }
        small {
          color: var(--text-faint);
        }
        &.over,
        &:hover {
          border-color: var(--accent-text);
          background: var(--hover);
        }
      }
      .items {
        list-style: none;
        margin: 0;
        padding: 0;
        max-height: 280px;
        overflow: auto;
      }
      li {
        padding: 6px 0;
        border-bottom: 1px solid var(--divider);
      }
      .row {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .meta,
      .geo {
        color: var(--text-faint);
        font-size: 12px;
        white-space: nowrap;
      }
      .state {
        font-size: 18px;
        width: 18px;
        height: 18px;
        color: var(--text-faint);
      }
      .st-done .state {
        color: var(--success);
      }
      .st-failed .state,
      .error {
        color: var(--danger);
      }
      .error {
        font-size: 12px;
        margin-top: 2px;
      }
    `,
  ],
})
export class UploadDialog {
  readonly NONE = NONE;
  readonly orNull = orNull;
  readonly data = inject<UploadDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<UploadDialog, boolean>);
  private readonly api = inject(ApiService);

  readonly countries = Object.entries(COUNTRIES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  folderId = this.data.folders.find((f) => f.path === this.data.folderPath)?.id ?? '';
  readonly geo = signal<string | null>(null);
  readonly items = signal<Item[]>([]);
  readonly busy = signal(false);
  readonly dragOver = signal(false);
  private uploadedAny = false;

  readonly waiting = computed(() => this.items().filter((i) => i.state === 'waiting').length);
  readonly finished = computed(
    () => this.items().length > 0 && !this.busy() && this.items().every((i) => i.state === 'done'),
  );

  readonly size = formatBytes;

  geoLabel(code: string): string {
    return `${countryName(code)} · ${code}`;
  }

  setGeo(code: string | null): void {
    this.geo.set(code);
    this.items.update((list) =>
      list.map((it) => (it.state === 'waiting' ? { ...it, geo: code ?? geoFromName(it.file.name) } : it)),
    );
  }

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.add([...(input.files ?? [])]);
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    if (!this.busy()) this.add([...(event.dataTransfer?.files ?? [])]);
  }

  remove(item: Item): void {
    this.items.update((list) => list.filter((i) => i !== item));
  }

  icon(it: Item): string {
    return { waiting: 'schedule', uploading: 'cloud_upload', done: 'check_circle', failed: 'error' }[it.state];
  }

  async start(): Promise<void> {
    if (!this.folderId) return;
    this.busy.set(true);
    for (const item of this.items()) {
      if (item.state !== 'waiting' && item.state !== 'failed') continue;
      this.patch(item, { state: 'uploading', progress: 0, error: undefined });
      try {
        await this.api.library.upload(
          { file: item.file, folderId: this.folderId, geo: item.geo },
          (progress) => this.patch(item, { progress }),
        );
        this.patch(item, { state: 'done' });
        this.uploadedAny = true;
      } catch (err) {
        this.patch(item, { state: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
    this.busy.set(false);
  }

  close(): void {
    this.ref.close(this.uploadedAny);
  }

  private add(files: File[]): void {
    const videos = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
    this.items.update((list) => [
      ...list,
      ...videos.map((file) => ({
        file,
        geo: this.geo() ?? geoFromName(file.name),
        progress: null,
        state: 'waiting' as const,
      })),
    ]);
  }

  /** Items are matched by identity, so replace in place to keep track stable. */
  private patch(item: Item, change: Partial<Item>): void {
    Object.assign(item, change);
    this.items.update((list) => [...list]);
  }
}
