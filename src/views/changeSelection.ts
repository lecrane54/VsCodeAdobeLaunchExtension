/**
 * Which unpushed changes are ticked in the Changes view.
 *
 * Stored as the set of *excluded* keys, not the included ones: a change you
 * haven't opinionated about should push. That way editing another file adds a
 * change that is already ticked, instead of silently appearing unticked and
 * being left behind on the next push.
 */

import { Change } from '../local/push';

export class ChangeSelection {
  private excluded = new Set<string>();

  isSelected(key: string): boolean {
    return !this.excluded.has(key);
  }

  /** True when every key is ticked — drives a group row's own checkbox. */
  allSelected(keys: readonly string[]): boolean {
    return keys.every((k) => this.isSelected(k));
  }

  setSelected(keys: readonly string[], selected: boolean): void {
    for (const k of keys) {
      if (selected) this.excluded.delete(k);
      else this.excluded.add(k);
    }
  }

  selectAll(): void {
    this.excluded.clear();
  }

  selectNone(changes: readonly Change[]): void {
    for (const c of changes) this.excluded.add(c.key);
  }

  filter(changes: readonly Change[]): Change[] {
    return changes.filter((c) => this.isSelected(c.key));
  }

  /**
   * Drop exclusions for changes that no longer exist, so a key reused by a
   * later edit doesn't come back pre-unticked. Called whenever we read the
   * current change set.
   */
  prune(changes: readonly Change[]): void {
    if (this.excluded.size === 0) return;
    const live = new Set(changes.map((c) => c.key));
    for (const k of [...this.excluded]) {
      if (!live.has(k)) this.excluded.delete(k);
    }
  }

  /** True when the user has actually narrowed the push. */
  get hasExclusions(): boolean {
    return this.excluded.size > 0;
  }
}
