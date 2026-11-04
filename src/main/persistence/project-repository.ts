import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Project, Settings, isPlainObject } from '../../shared/contracts';
import { isLocale, Locale, t } from '../../shared/i18n';

export class ProjectRepository {
  private readonly filename: string;
  private settings: Settings;
  constructor(root: string, private readonly defaultLanguage: Locale = 'zh-CN') {
    mkdirSync(root, { recursive: true });
    this.filename = path.join(root, 'settings.json');
    this.settings = this.load();
  }
  private load(): Settings {
    if (!existsSync(this.filename)) return { schemaVersion: 1, cliPath: null, projects: [], activeProjectId: null, language: this.defaultLanguage };
    const data: unknown = JSON.parse(readFileSync(this.filename, 'utf8'));
    if (!isPlainObject(data) || data.schemaVersion !== 1 || !Array.isArray(data.projects) ||
      !(data.cliPath === null || typeof data.cliPath === 'string') ||
      !(data.activeProjectId === null || typeof data.activeProjectId === 'string') ||
      (data.language !== undefined && !isLocale(data.language)) ||
      !data.projects.every((item: unknown) => isPlainObject(item) && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.directory === 'string' && typeof item.lastOpenedAt === 'string')) {
      const locale = isPlainObject(data) && isLocale(data.language) ? data.language : this.defaultLanguage;
      throw new Error(t('project.settingsInvalid', {}, locale));
    }
    return { ...data, language: data.language === undefined ? this.defaultLanguage : data.language } as Settings;
  }
  private save(): void {
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    writeFileSync(temporary, JSON.stringify(this.settings, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, this.filename);
  }
  snapshot(): Settings { return JSON.parse(JSON.stringify(this.settings)) as Settings; }
  setCliPath(cliPath: string | null): Settings {
    if (cliPath !== null && !path.isAbsolute(cliPath)) throw new Error(t('project.cliPathAbsolute', {}, this.settings.language));
    this.settings.cliPath = cliPath;
    this.save(); return this.snapshot();
  }
  setLanguage(language: unknown): Settings {
    if (!isLocale(language)) throw new Error(t('ipc.invalidLanguage', {}, this.settings.language));
    this.settings.language = language;
    this.save(); return this.snapshot();
  }
  add(directory: string): Settings {
    if (!path.isAbsolute(directory)) throw new Error(t('project.pathAbsolute', {}, this.settings.language));
    const existing = this.settings.projects.find(project => path.normalize(project.directory).toLowerCase() === path.normalize(directory).toLowerCase());
    if (existing) this.settings.activeProjectId = existing.id;
    else {
      const project: Project = { id: randomUUID(), name: path.basename(directory), directory, lastOpenedAt: new Date().toISOString() };
      this.settings.projects.push(project);
      this.settings.activeProjectId = project.id;
    }
    this.save(); return this.snapshot();
  }
  activate(id: string): Settings {
    const project = this.settings.projects.find(item => item.id === id);
    if (!project) throw new Error(t('project.notRegistered', {}, this.settings.language));
    project.lastOpenedAt = new Date().toISOString(); this.settings.activeProjectId = id;
    this.save(); return this.snapshot();
  }
  remove(id: string): Settings {
    this.settings.projects = this.settings.projects.filter(item => item.id !== id);
    if (this.settings.activeProjectId === id) this.settings.activeProjectId = null;
    this.save(); return this.snapshot();
  }
}
