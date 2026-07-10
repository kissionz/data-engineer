import { existsSync } from "node:fs";
import path from "node:path";

export const PRODUCT_NAME = "Montane Code";
export const PRODUCT_VERSION = "0.3.0";
export const STATE_DIRECTORY_NAME = ".montane";
export const LEGACY_STATE_DIRECTORY_NAME = ".harness";

export function stateRoot(parent: string): string {
  const current = path.join(parent, STATE_DIRECTORY_NAME);
  const legacy = path.join(parent, LEGACY_STATE_DIRECTORY_NAME);
  if (existsSync(current) || !existsSync(legacy)) {
    return current;
  }
  return legacy;
}

export function workspaceStateRoot(workspaceRoot: string): string {
  return stateRoot(path.resolve(workspaceRoot));
}

export function userStateRoot(userHome: string): string {
  return stateRoot(path.resolve(userHome));
}

export function stateDirectoryLabel(statePath: string): string {
  return path.basename(statePath) === LEGACY_STATE_DIRECTORY_NAME
    ? LEGACY_STATE_DIRECTORY_NAME
    : STATE_DIRECTORY_NAME;
}
