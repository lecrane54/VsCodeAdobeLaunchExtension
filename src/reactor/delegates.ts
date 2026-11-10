/**
 * Static catalog of common Launch delegates, used by the "add trigger/condition/
 * action" picker. The Core extension's delegates cover the vast majority of hand-
 * authored rule components; anything else is reachable via "Enter delegate id…".
 */

export type ComponentKind = 'events' | 'conditions' | 'actions';

export interface DelegateOption {
  label: string;
  delegateId: string;
  customCode?: boolean;
}

export const KIND_LABELS: Record<ComponentKind, string> = {
  events: 'Trigger',
  conditions: 'Condition',
  actions: 'Action',
};

/** Known Core delegates per kind, plus a custom-code option each. */
export const DELEGATE_CATALOG: Record<ComponentKind, DelegateOption[]> = {
  events: [
    { label: 'Click', delegateId: 'core::events::click' },
    { label: 'Direct Call', delegateId: 'core::events::direct-call' },
    { label: 'DOM Ready', delegateId: 'core::events::dom-ready' },
    { label: 'Window Loaded', delegateId: 'core::events::window-loaded' },
    { label: 'Custom Code', delegateId: 'core::events::custom-code', customCode: true },
  ],
  conditions: [
    { label: 'Value Comparison', delegateId: 'core::conditions::value-comparison' },
    { label: 'Domain', delegateId: 'core::conditions::domain' },
    { label: 'Custom Code', delegateId: 'core::conditions::custom-code', customCode: true },
  ],
  actions: [
    { label: 'Custom Code', delegateId: 'core::actions::custom-code', customCode: true },
  ],
};

/**
 * Kinds we only ever author as custom code. Conditions and actions in this
 * property are hand-written JavaScript, so offering a delegate picker for them
 * is a menu of choices nobody takes — the add flow goes straight to naming the
 * component and opening its `.js`. Triggers still get the full picker, because
 * a click/direct-call/DOM-ready trigger is configuration, not code.
 */
export const CUSTOM_CODE_ONLY_KINDS: readonly ComponentKind[] = ['conditions', 'actions'];

export function isCustomCodeOnlyKind(kind: ComponentKind): boolean {
  return CUSTOM_CODE_ONLY_KINDS.includes(kind);
}

/** The custom-code delegate for a kind, e.g. `core::actions::custom-code`. */
export function customCodeDelegateFor(kind: ComponentKind): DelegateOption {
  const found = DELEGATE_CATALOG[kind].find((d) => d.customCode);
  if (found) return found;
  // The catalog always carries one, but don't let a future edit break the flow.
  return { label: 'Custom Code', delegateId: `core::${kind}::custom-code`, customCode: true };
}

/** The extension namespace a delegate belongs to (first `::` segment), e.g. "core". */
export function namespaceOf(delegateId: string | undefined): string {
  return (delegateId ?? '').split('::')[0] ?? '';
}

/** Whether a delegate stores its editable JavaScript in a `.js` sidecar. */
export function isCustomCodeDelegate(delegateId: string | undefined): boolean {
  return /::custom-code$/.test(delegateId ?? '');
}

/** Validate a hand-entered delegate id has the `<ns>::<kind>::<name>` shape. */
export function isWellFormedDelegateId(delegateId: string | undefined, kind: ComponentKind): boolean {
  const parts = (delegateId ?? '').split('::');
  return parts.length >= 3 && parts[0].length > 0 && parts[1] === kind && parts[2].length > 0;
}
