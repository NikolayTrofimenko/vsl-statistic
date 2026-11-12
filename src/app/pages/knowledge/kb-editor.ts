import { AfterViewInit, Component, ElementRef, inject, input, OnDestroy, output, signal, viewChild } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSnackBar } from '@angular/material/snack-bar';
import { Editor, mergeAttributes, Node } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Image } from '@tiptap/extension-image';
import { ApiService } from '../../core/services/api.service';
import { ConfirmService } from '../../core/services/confirm.service';

/** A video of our own (uploaded to Drive), as a block with player controls. */
const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return { src: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'video[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, { controls: 'true', preload: 'metadata' })];
  },
});

const MEDIA_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/*';

/**
 * The document editor: text with headings, marks, lists, quotes, links,
 * images and videos — nothing else. Images and videos are uploaded to Drive
 * first (button, paste or drop) and go in at the cursor.
 */
@Component({
  selector: 'app-kb-editor',
  imports: [MatIconModule, MatProgressBarModule, MatTooltipModule],
  template: `
    <div class="toolbar" role="toolbar">
      <button type="button" [class.on]="active('heading', { level: 2 })" (click)="cmd('h2')" matTooltip="Заголовок">
        <span class="txt">H2</span>
      </button>
      <button type="button" [class.on]="active('heading', { level: 3 })" (click)="cmd('h3')" matTooltip="Подзаголовок">
        <span class="txt">H3</span>
      </button>
      <span class="sep"></span>
      <button type="button" [class.on]="active('bold')" (click)="cmd('bold')" matTooltip="Жирный (Ctrl+B)">
        <mat-icon>format_bold</mat-icon>
      </button>
      <button type="button" [class.on]="active('italic')" (click)="cmd('italic')" matTooltip="Курсив (Ctrl+I)">
        <mat-icon>format_italic</mat-icon>
      </button>
      <button type="button" [class.on]="active('underline')" (click)="cmd('underline')" matTooltip="Подчёркнутый (Ctrl+U)">
        <mat-icon>format_underlined</mat-icon>
      </button>
      <button type="button" [class.on]="active('strike')" (click)="cmd('strike')" matTooltip="Зачёркнутый">
        <mat-icon>strikethrough_s</mat-icon>
      </button>
      <span class="sep"></span>
      <button type="button" [class.on]="active('bulletList')" (click)="cmd('bullet')" matTooltip="Список">
        <mat-icon>format_list_bulleted</mat-icon>
      </button>
      <button type="button" [class.on]="active('orderedList')" (click)="cmd('ordered')" matTooltip="Нумерованный список">
        <mat-icon>format_list_numbered</mat-icon>
      </button>
      <button type="button" [class.on]="active('blockquote')" (click)="cmd('quote')" matTooltip="Цитата / выделенный блок">
        <mat-icon>format_quote</mat-icon>
      </button>
      <span class="sep"></span>
      <button type="button" [class.on]="active('link')" (click)="link()" matTooltip="Ссылка">
        <mat-icon>link</mat-icon>
      </button>
      <button type="button" (click)="picker.click()" [disabled]="!!uploading()" matTooltip="Картинка или видео (можно вставить из буфера или перетащить)">
        <mat-icon>perm_media</mat-icon>
      </button>
      <input #picker type="file" [accept]="accept" hidden (change)="picked(picker)" />
      <span class="sep"></span>
      <button type="button" (click)="cmd('undo')" matTooltip="Отменить (Ctrl+Z)"><mat-icon>undo</mat-icon></button>
      <button type="button" (click)="cmd('redo')" matTooltip="Повторить"><mat-icon>redo</mat-icon></button>
    </div>
    @if (uploading(); as u) {
      <div class="upload">
        <span>Загружаю «{{ u.name }}»{{ u.progress !== null ? ' · ' + u.progress + '%' : '' }}…</span>
        <mat-progress-bar [mode]="u.progress === null ? 'indeterminate' : 'determinate'" [value]="u.progress ?? 0" />
      </div>
    }
    <div #host class="kb-content editor"></div>
  `,
  styles: [
    `
      :host {
        display: block;
        border: 1px solid var(--divider-strong);
        border-radius: 10px;
        background: var(--surface);
      }
      .toolbar {
        position: sticky;
        top: 0;
        z-index: 2;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 2px;
        padding: 6px;
        border-bottom: 1px solid var(--divider);
        background: var(--surface-2);
        border-radius: 10px 10px 0 0;
      }
      .toolbar button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 32px;
        height: 32px;
        padding: 0 6px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
      }
      .toolbar button:hover:not(:disabled) {
        background: var(--hover-strong);
        color: var(--text);
      }
      .toolbar button.on {
        background: var(--accent-soft);
        color: var(--accent-text);
      }
      .toolbar button:disabled {
        opacity: 0.4;
        cursor: default;
      }
      .toolbar mat-icon {
        font-size: 20px;
        width: 20px;
        height: 20px;
      }
      .txt {
        font-weight: 700;
        font-size: 13px;
      }
      .sep {
        width: 1px;
        height: 20px;
        margin: 0 4px;
        background: var(--divider-strong);
      }
      .upload {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 8px 12px;
        font-size: 12px;
        color: var(--text-muted);
        border-bottom: 1px solid var(--divider);
      }
      .editor {
        padding: 16px 20px;
        min-height: 360px;
      }
    `,
  ],
})
export class KbEditor implements AfterViewInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly ask = inject(ConfirmService);
  private readonly snack = inject(MatSnackBar);

  readonly html = input('');
  readonly changed = output<void>();
  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('host');

  readonly accept = MEDIA_ACCEPT;
  readonly uploading = signal<{ name: string; progress: number | null } | null>(null);
  /** Bumped on every editor transaction so the toolbar re-reads its state. */
  private readonly tick = signal(0);
  private editor?: Editor;

  ngAfterViewInit(): void {
    this.editor = new Editor({
      element: this.host().nativeElement,
      extensions: [
        StarterKit.configure({
          heading: { levels: [2, 3] },
          code: false,
          codeBlock: false,
          link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
        }),
        Image,
        Video,
      ],
      content: this.html() || '<p></p>',
      editorProps: {
        handlePaste: (_view, event) => this.takeFiles(event.clipboardData?.files),
        handleDrop: (_view, event) => this.takeFiles((event as DragEvent).dataTransfer?.files),
      },
      onTransaction: () => this.tick.update((n) => n + 1),
      onUpdate: () => this.changed.emit(),
    });
  }

  ngOnDestroy(): void {
    this.editor?.destroy();
  }

  getHtml(): string {
    return this.editor?.getHTML() ?? '';
  }

  active(name: string, attrs?: Record<string, unknown>): boolean {
    this.tick();
    return this.editor?.isActive(name, attrs) ?? false;
  }

  cmd(name: 'h2' | 'h3' | 'bold' | 'italic' | 'underline' | 'strike' | 'bullet' | 'ordered' | 'quote' | 'undo' | 'redo'): void {
    if (!this.editor) return;
    const c = this.editor.chain().focus();
    const next = {
      h2: () => c.toggleHeading({ level: 2 }),
      h3: () => c.toggleHeading({ level: 3 }),
      bold: () => c.toggleBold(),
      italic: () => c.toggleItalic(),
      underline: () => c.toggleUnderline(),
      strike: () => c.toggleStrike(),
      bullet: () => c.toggleBulletList(),
      ordered: () => c.toggleOrderedList(),
      quote: () => c.toggleBlockquote(),
      undo: () => c.undo(),
      redo: () => c.redo(),
    }[name]();
    next.run();
  }

  async link(): Promise<void> {
    const ed = this.editor;
    if (!ed) return;
    if (ed.isActive('link')) {
      ed.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    const { from, to } = ed.state.selection;
    const url = await this.ask.prompt({
      title: 'Ссылка',
      message: from === to ? 'Выдели текст перед этим, чтобы он стал ссылкой, — или ссылка вставится как есть.' : undefined,
      input: { label: 'Адрес', placeholder: 'https://…', minLength: 4 },
      ok: 'Вставить',
    });
    if (!url) return;
    const href = /^(https?:|mailto:|tg:)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    if (from === to) {
      ed.chain().focus().insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      ed.chain().focus().setLink({ href }).run();
    }
  }

  picked(el: HTMLInputElement): void {
    const file = el.files?.[0];
    el.value = '';
    if (file) void this.upload(file);
  }

  /** Paste / drop: take the first image or video, leave everything else to the editor. */
  private takeFiles(files: FileList | undefined | null): boolean {
    const file = [...(files ?? [])].find((f) => /^(image|video)\//.test(f.type));
    if (!file) return false;
    void this.upload(file);
    return true;
  }

  private async upload(file: File): Promise<void> {
    if (this.uploading()) return;
    // A pasted screenshot comes as "image.png" or with no name at all.
    const named = file.name && /\.[a-z0-9]+$/i.test(file.name) ? file : new File([file], `image-${Date.now()}.${file.type.split('/')[1] || 'png'}`, { type: file.type });
    this.uploading.set({ name: named.name, progress: 0 });
    try {
      const f = await this.api.knowledge.upload(named, (p) => this.uploading.set({ name: named.name, progress: p }));
      const ed = this.editor;
      if (!ed) return;
      if (f.kind === 'image') ed.chain().focus().setImage({ src: f.url, alt: '' }).run();
      else ed.chain().focus().insertContent({ type: 'video', attrs: { src: f.url } }).run();
    } catch (err) {
      this.snack.open(err instanceof Error ? err.message : String(err), 'OK', { duration: 8000 });
    } finally {
      this.uploading.set(null);
    }
  }
}
