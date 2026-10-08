import { z } from "zod";
import type { Database } from "./database.js";
import type { PluginManager } from "./plugin-manager.js";
import { PerformerConflictError } from "./performer-conflict.js";
import { settingsSchema } from "./output-settings.js";

/*
 * Export and import of the library setup: performers (with aliases, links and
 * priority), their sources, the application settings and which plugins are
 * installed. Downloads, files and plugin configuration (passwords, cookies,
 * sessions) are never part of a backup.
 *
 * Importing merges into the current library and never deletes anything:
 * performers are matched by name, sources by plugin + external ID, so importing
 * the same file twice changes nothing.
 */
export const BACKUP_FORMAT = "open-easyx-backup";
export const BACKUP_VERSION = 1;

const sourceSchema = z.object({
  pluginId: z.string().min(1), externalId: z.string().min(1), label: z.string().default(""),
  profileUrl: z.string().min(1), domain: z.string().default(""),
  enabled: z.boolean().optional(), autoDownload: z.boolean().optional(),
  scraperPluginId: z.string().nullable().optional(), scrapeEnabled: z.boolean().optional(),
  syncIntervalSeconds: z.number().int().min(5).max(31_536_000).optional(),
});

const performerSchema = z.object({
  name: z.string().trim().min(1), aliases: z.array(z.string()).default([]), imageUrl: z.string().nullable().optional(),
  externalRefs: z.record(z.string(), z.string()).default({}), priority: z.number().int().min(-1).max(1).optional(),
  sources: z.array(sourceSchema).default([]),
});

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT), version: z.number().int().min(1),
  exportedAt: z.string().optional(), appVersion: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  plugins: z.array(z.object({ id: z.string().min(1), enabled: z.boolean().optional() })).optional(),
  performers: z.array(performerSchema),
});

export type Backup = z.infer<typeof backupSchema>;
export type ImportOptions = { settings?: boolean; plugins?: boolean };
export type ImportResult = {
  performers: { created: number; updated: number };
  sources: { added: number; updated: number; skipped: Array<{ performer: string; profileUrl: string; reason: string }> };
  settings: { applied: string[]; skipped: string[] };
  plugins: { installed: string[]; skipped: Array<{ id: string; reason: string }> };
};

export function exportBackup(db: Database, plugins: PluginManager, appVersion?: string): Backup {
  const sources = db.listSources();
  const backupSettings = settingsSchema.safeParse(db.getSettings());
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), ...(appVersion ? { appVersion } : {}),
    settings: backupSettings.success ? Object.fromEntries(Object.entries(backupSettings.data).filter(([, value]) => value !== undefined)) : {},
    plugins: plugins.list().filter((plugin) => plugin.installed).map((plugin) => ({ id: plugin.manifest.id, enabled: plugin.enabled })),
    performers: db.listPerformers().map((performer) => ({
      name: performer.name, aliases: performer.aliases, ...(performer.imageUrl ? { imageUrl: performer.imageUrl } : {}),
      externalRefs: performer.externalRefs, priority: performer.priority ?? 0,
      sources: sources.filter((source) => source.performerId === performer.id).map((source) => ({
        pluginId: source.pluginId, externalId: source.externalId, label: source.label, profileUrl: source.profileUrl, domain: source.domain,
        enabled: source.enabled, autoDownload: source.autoDownload, scraperPluginId: source.scraperPluginId ?? null,
        scrapeEnabled: source.scrapeEnabled, syncIntervalSeconds: source.syncIntervalSeconds,
      })),
    })),
  };
}

export function parseBackup(input: unknown): Backup {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const format = input && typeof input === "object" ? (input as Record<string, unknown>).format : undefined;
    const reason = format !== BACKUP_FORMAT ? "This file is not an Open EasyX backup" : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).slice(0, 3).join("; ");
    throw Object.assign(new Error(reason), { statusCode: 400 });
  }
  if (parsed.data.version > BACKUP_VERSION) throw Object.assign(new Error(`This backup was made by a newer Open EasyX (format ${parsed.data.version}); update first`), { statusCode: 400 });
  return parsed.data;
}

export function importBackup(db: Database, plugins: PluginManager, backup: Backup, options: ImportOptions = {}): ImportResult {
  const result: ImportResult = { performers: { created: 0, updated: 0 }, sources: { added: 0, updated: 0, skipped: [] }, settings: { applied: [], skipped: [] }, plugins: { installed: [], skipped: [] } };

  if (options.plugins !== false) {
    const known = new Map(plugins.list().map((plugin) => [plugin.manifest.id, plugin]));
    for (const entry of backup.plugins ?? []) {
      const plugin = known.get(entry.id);
      if (!plugin) { result.plugins.skipped.push({ id: entry.id, reason: "Plugin not available in this installation" }); continue; }
      if (plugin.installed) continue;
      try { plugins.install(entry.id); result.plugins.installed.push(entry.id); }
      catch (error) { result.plugins.skipped.push({ id: entry.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
  }

  if (options.settings !== false && backup.settings) {
    const values: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(backup.settings)) {
      const check = settingsSchema.safeParse({ [key]: value });
      if (check.success && key in check.data) values[key] = (check.data as Record<string, unknown>)[key];
      else result.settings.skipped.push(key);
    }
    if (Object.keys(values).length) { db.updateSettings(values); result.settings.applied.push(...Object.keys(values)); }
  }

  for (const entry of backup.performers) {
    const name = db.resolvePerformerName(entry.name);
    let performer = db.getPerformerByName(name);
    if (performer) result.performers.updated += 1;
    else { performer = db.createPerformer({ name, aliases: [], imageUrl: entry.imageUrl ?? null }); result.performers.created += 1; }
    db.mergePerformerDetails(performer.id, { aliases: entry.name === name ? entry.aliases : [...entry.aliases, entry.name], imageUrl: entry.imageUrl ?? undefined, externalRefs: entry.externalRefs });
    if (entry.priority !== undefined) db.setPerformerPriority(performer.id, entry.priority);

    const existing = new Set(db.listSources(performer.id).map((source) => `${source.pluginId}\u0000${source.externalId}`));
    for (const source of entry.sources) {
      try {
        const saved = db.addSource(performer.id, source.pluginId, { externalId: source.externalId, label: source.label || source.domain, profileUrl: source.profileUrl, domain: source.domain });
        db.updateSource(saved.id, {
          ...(source.enabled !== undefined ? { enabled: source.enabled } : {}), ...(source.autoDownload !== undefined ? { autoDownload: source.autoDownload } : {}),
          ...(source.scraperPluginId !== undefined ? { scraperPluginId: source.scraperPluginId } : {}), ...(source.scrapeEnabled !== undefined ? { scrapeEnabled: source.scrapeEnabled } : {}),
          ...(source.syncIntervalSeconds !== undefined ? { syncIntervalSeconds: source.syncIntervalSeconds } : {}),
        });
        if (existing.has(`${source.pluginId}\u0000${source.externalId}`)) result.sources.updated += 1; else result.sources.added += 1;
      } catch (error) {
        const reason = error instanceof PerformerConflictError
          ? `Already belongs to ${error.conflict.existingPerformer.name}`
          : error instanceof Error ? error.message : String(error);
        result.sources.skipped.push({ performer: name, profileUrl: source.profileUrl, reason });
      }
    }
  }
  return result;
}
