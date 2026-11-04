import path from 'node:path';
import { LEGACY_PRODUCT_NAME } from '../../shared/brand';

export type UserDataLocationSource = 'env' | 'env-legacy' | 'default' | 'legacy-default';

export type UserDataLocation = {
  path: string;
  source: UserDataLocationSource;
};

export type UserDataLocationInput = {
  env: Record<string, string | undefined>;
  appDataDir: string;
  sourceRoot: string;
  existsSync: (candidate: string) => boolean;
};

const ENV_PATH_ERROR = 'Acceptance userData must be an absolute directory outside the source tree';

function resolveEnvPath(value: string, sourceRoot: string): string {
  const resolved = path.resolve(value);
  const resolvedRoot = path.resolve(sourceRoot);
  const candidateLower = resolved.toLowerCase();
  const rootLower = resolvedRoot.toLowerCase();
  const isInsideSource = candidateLower === rootLower || candidateLower.startsWith(rootLower + path.sep.toLowerCase());
  if (!path.isAbsolute(value) || isInsideSource) throw new Error(ENV_PATH_ERROR);
  return resolved;
}

function containsLegacyData(directory: string, existsSync: (candidate: string) => boolean): boolean {
  return existsSync(path.join(directory, 'settings.json')) ||
    existsSync(path.join(directory, 'sessions.json')) ||
    existsSync(path.join(directory, 'sessions'));
}

/** Resolve the active store without creating directories or modifying existing data. */
export function resolveUserDataLocation(input: UserDataLocationInput): UserDataLocation {
  const cliDeskEnv = input.env.CLI_DESK_USER_DATA;
  if (cliDeskEnv) return { path: resolveEnvPath(cliDeskEnv, input.sourceRoot), source: 'env' };

  const legacyEnv = input.env.CC_DESKTOP_USER_DATA;
  if (legacyEnv) return { path: resolveEnvPath(legacyEnv, input.sourceRoot), source: 'env-legacy' };

  const newDefault = path.join(input.appDataDir, 'CLI Desk for Claude Code');
  if (input.existsSync(newDefault)) return { path: newDefault, source: 'default' };

  for (const legacyName of [LEGACY_PRODUCT_NAME, 'cc-desktop']) {
    const legacyDirectory = path.join(input.appDataDir, legacyName);
    if (containsLegacyData(legacyDirectory, input.existsSync)) {
      return { path: legacyDirectory, source: 'legacy-default' };
    }
  }

  return { path: newDefault, source: 'default' };
}
