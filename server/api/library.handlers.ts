import { handle } from './rpc';
import { db } from '../db';
import { thumbPath } from '../drive/sync';
import * as fs from 'node:fs';
import { queueState, requeue } from '../creo/transcribe';
import { driveFolderId } from '../config';
import { setVerticalCode } from '../creo/ids';
import { deleteTag, listTags, saveTag, toggleTag, visibleTagLinks } from '../creo/tags';
import { clearDuplicates, markDuplicate, unmarkDuplicate, visibleDuplicateMarks } from '../creo/duplicates';
import { removeReport, resolveReports, saveReport, visibleReports } from '../creo/reports';
import { deleteCreative, listHistory } from '../creo/history';
import { currentUser } from '../users';
import { COUNTRIES } from '../../src/shared/geo';
import type {
  CreoQueueState,
  CreoText,
  DriveFolder,
  CreoReport,
  DuplicateMark,
  HistoryEntry,
  LibraryVideo,
  Tag,
  Vertical,
  VideoPatch,
} from '../../src/shared/api.types';

export function registerLibraryHandlers(): void {
  handle('library:list', (): LibraryVideo[] => {
    const rows = db()
      .prepare(
        `
        SELECT df.*, (SELECT COUNT(*) FROM land_videos lv WHERE lv.drive_file_id = df.id) AS landing_count
        FROM drive_files df
        WHERE df.deleted_at IS NULL
        ORDER BY df.removed, df.folder_path, df.name COLLATE NOCASE
      `,
      )
      .all() as Record<string, unknown>[];
    const user = currentUser();
    const tags = visibleTagLinks(user);
    const marks = visibleDuplicateMarks(user);
    const reports = visibleReports(user);
    return rows.map((r) => ({
      id: String(r['id']),
      creoId: (r['creo_id'] as string | null) ?? null,
      verticalId: (r['vertical_id'] as number | null) ?? null,
      name: String(r['name']),
      mimeType: String(r['mime_type']),
      size: r['size'] as number | null,
      durationSec: r['duration_ms'] == null ? null : Number(r['duration_ms']) / 1000,
      width: r['width'] as number | null,
      height: r['height'] as number | null,
      folderPath: String(r['folder_path']),
      modifiedAt: String(r['modified_at']),
      createdAt: (r['created_at'] as string | null) ?? null,
      firstSeenAt: Number(r['first_seen_at'] ?? 0),
      webViewLink: r['web_view_link'] as string | null,
      hasThumb: r['thumb_at'] != null && fs.existsSync(thumbPath(String(r['id']))),
      geo: (r['geo'] as string | null) ?? null,
      geoSource: (r['geo_source'] as 'name' | 'manual' | null) ?? null,
      lang: (r['lang'] as string | null) ?? null,
      transcribeStatus: (r['transcribe_status'] as LibraryVideo['transcribeStatus']) ?? 'pending',
      hasTranscript: Boolean(r['transcript']),
      hasTranslation: Boolean(r['transcript_ru']),
      removed: r['removed'] === 1,
      note: String(r['note'] ?? ''),
      tagIds: tags.get(String(r['id'])) ?? [],
      landingCount: Number(r['landing_count']),
      duplicateMarks: marks.get(String(r['id'])) ?? [],
      reports: reports.get(String(r['id'])) ?? [],
    }));
  });

  handle('library:update', (id: string, patch: VideoPatch): void => {
    const conn = db();
    if (patch.note !== undefined) {
      conn.prepare('UPDATE drive_files SET note = ? WHERE id = ?').run(String(patch.note).slice(0, 2000), id);
    }
    if (patch.geo !== undefined) {
      const geo = patch.geo ? String(patch.geo).toUpperCase() : null;
      if (geo && !(geo in COUNTRIES)) throw new Error(`Неизвестная страна: ${geo}`);
      // Pinned either way: a cleared geo must not be re-guessed from the name.
      conn.prepare(`UPDATE drive_files SET geo = ?, geo_source = 'manual' WHERE id = ?`).run(geo, id);
    }
  });

  handle('library:folders', (): DriveFolder[] => {
    const rows = db().prepare('SELECT id, path FROM drive_folders ORDER BY path COLLATE NOCASE').all() as unknown as DriveFolder[];
    // Before the first sync after this feature shipped, only the root is known.
    return rows.length ? rows : [{ id: driveFolderId(), path: '' }];
  });

  handle('library:text', (id: string): CreoText => {
    const row = db()
      .prepare(
        'SELECT transcribe_status, lang, transcript, transcript_ru, transcribe_error, translate_error FROM drive_files WHERE id = ?',
      )
      .get(id) as Record<string, string | null> | undefined;
    if (!row) throw new Error('Видео не найдено.');
    return {
      status: (row['transcribe_status'] as CreoText['status']) ?? 'pending',
      lang: row['lang'] ?? null,
      transcript: row['transcript'] ?? null,
      transcriptRu: row['transcript_ru'] ?? null,
      error: row['transcribe_error'] ?? null,
      translateError: row['translate_error'] ?? null,
    };
  });

  handle('library:retranscribe', (id: string): void => requeue(id));

  handle('library:queue', (): CreoQueueState => queueState());

  handle('library:verticals', (): Vertical[] =>
    (
      db()
        .prepare(
          `SELECT v.id, v.name, v.code, v.next_num, v.folder_id IS NOT NULL AS present,
                  (SELECT COUNT(*) FROM drive_files df WHERE df.vertical_id = v.id AND df.removed = 0) AS count
           FROM verticals v ORDER BY v.name = '', v.name COLLATE NOCASE`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r['id']),
      name: String(r['name']),
      code: String(r['code']),
      present: Boolean(r['present']),
      count: Number(r['count']),
      nextId: `${r['code']}-${String(r['next_num']).padStart(4, '0')}`,
    })),
  );

  // Admin only (see adminOnly() in server/http/app.ts).
  handle('library:saveVertical', (id: number, code: string): void => setVerticalCode(id, code));

  // Admin only.
  handle('library:delete', (id: string): Promise<void> => deleteCreative(currentUser(), String(id)));

  handle('reports:save', (fileId: string, text: string): CreoReport => saveReport(currentUser(), String(fileId), text));
  handle('reports:remove', (fileId: string): void => removeReport(currentUser(), String(fileId)));
  // Admin only.
  handle('reports:resolve', (fileId: string): void => resolveReports(currentUser(), String(fileId)));

  handle('duplicates:mark', (fileId: string, originalId: string | null): DuplicateMark =>
    markDuplicate(currentUser(), String(fileId), originalId),
  );
  handle('duplicates:unmark', (fileId: string): void => unmarkDuplicate(currentUser(), String(fileId)));
  // Admin only.
  handle('duplicates:clear', (fileId: string): void => clearDuplicates(String(fileId)));

  // Admin only.
  handle('history:list', (): HistoryEntry[] => listHistory());

  handle('tags:list', (): Tag[] => listTags(currentUser()));
  handle('tags:save', (input: { id?: number; name: string; color: string }): Tag => saveTag(currentUser(), input));
  handle('tags:delete', (id: number): void => deleteTag(currentUser(), id));
  handle('tags:toggle', (fileId: string, tagId: number, on: boolean): void =>
    toggleTag(currentUser(), fileId, tagId, Boolean(on)),
  );
}
