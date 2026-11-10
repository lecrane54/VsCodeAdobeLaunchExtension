/** Manifest: hash-tracked resource inventory for diff-based push. */

import * as fs from 'fs';
import * as path from 'path';

export const MANIFEST_FILENAME = '.launch-manifest.json';

export interface ResourceEntry {
  id: string;
  kind: 'rule' | 'rule_component' | 'data_element' | 'extension';
  /** Relative to the property root. */
  path: string;
  sha256: string;
  server_updated_at?: string;
  parent_rule_id?: string;
  /** Created locally and not yet POSTed to Reactor. */
  pending?: 'create';
  /** For a pending rule component: the extension that owns its delegate. */
  extension_id?: string;
}

export interface ManifestData {
  property_id?: string;
  pulled_at?: string;
  resources: Record<string, ResourceEntry>;
}

export class Manifest {
  constructor(public data: ManifestData) {}

  static load(root: string): Manifest {
    const filePath = path.join(root, MANIFEST_FILENAME);
    if (!fs.existsSync(filePath)) {
      return new Manifest({ resources: {} });
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ManifestData;
    data.resources ??= {};
    return new Manifest(data);
  }

  save(root: string): void {
    fs.mkdirSync(root, { recursive: true });
    const filePath = path.join(root, MANIFEST_FILENAME);
    fs.writeFileSync(filePath, JSON.stringify(this.data, null, 2) + '\n', 'utf-8');
  }

  set(key: string, entry: ResourceEntry): void {
    this.data.resources[key] = entry;
  }

  get(key: string): ResourceEntry | undefined {
    return this.data.resources[key];
  }
}
